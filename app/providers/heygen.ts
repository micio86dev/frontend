/**
 * HeyGen LiveAvatar provider implementation.
 *
 * SSR INVARIANT (D2, CRITICAL):
 * The @heygen/liveavatar-web-sdk module references browser globals (window, navigator)
 * at import evaluation time. It MUST NEVER be imported at module scope — only via
 * dynamic `await import()` inside a function that is guarded by `import.meta.client`.
 *
 * Violation crashes the Nitro node-server SSR bundle.
 *
 * Testability: the SSR guard is extracted into a lazily-evaluated check so that
 * unit tests can verify behavior without a real browser context.
 *
 * SDK: @heygen/liveavatar-web-sdk@0.0.18 — exports LiveAvatarSession.
 * Constructor: new LiveAvatarSession(sessionAccessToken: string, config?: SessionConfig)
 * Lifecycle: start() → attach(el) → stop()
 * Mic control: startListening() / stopListening()
 * Send message: message(text: string)
 * Interrupt barge-in: interrupt()
 * Events (AgentEventsEnum): AVATAR_TRANSCRIPTION, USER_TRANSCRIPTION,
 *   AVATAR_SPEAK_STARTED, AVATAR_SPEAK_ENDED
 */

import type {
  InterviewProvider,
  ProviderEvent,
  ProviderState,
  StartConfig,
  TranscriptEntry,
} from '~/app/types/interview-provider'
import { matchesEndPhrase } from '~/app/utils/proctor-config'

type EventCallback = (payload: unknown) => void

/**
 * Minimal shape of the LiveAvatarSession used by this provider.
 * Typed to the real SDK API (AgentEventsEnum string values as event names).
 * Kept as a local interface to avoid importing the full SDK at module scope
 * and to allow injection of a mock in tests.
 */
interface HeyGenSession {
  on(event: string, handler: (data: Record<string, unknown>) => void): void
  start(): Promise<void>
  stop(): Promise<void>
  attach(element: HTMLMediaElement): void
  startListening(): string
  stopListening(): string
  interrupt(): void
  message(text: string): string
}

/**
 * HeyGen LiveAvatar provider.
 *
 * Completion detection: avatar speaks the project-language end_phrase or final_phrase.
 * The provider matches each avatar transcript segment against the phrases via
 * matchesEndPhrase() and emits 'state' 'complete' on a match.
 *
 * Absent-phrase guard: if either endPhrase or finalPhrase is empty, the provider
 * emits 'error' immediately on start() WITHOUT calling the SDK (safe-fail path).
 *
 * @param sdkLoader - Injectable SDK loader (defaults to dynamic import of the real SDK).
 *   Inject a factory returning a mock session in tests to avoid real WebRTC connections.
 */
export class HeyGenProvider implements InterviewProvider {
  private readonly listeners = new Map<ProviderEvent, EventCallback[]>()
  private session: HeyGenSession | null = null
  private phrases: { endPhrase: string; finalPhrase: string } | null = null
  private micMuted = false

  /**
   * Injectable SDK loader for testability.
   * Production default: dynamically imports the real SDK under import.meta.client guard.
   */
  private readonly sdkLoader: (token: string) => Promise<HeyGenSession>

  constructor(sdkLoader?: (token: string) => Promise<HeyGenSession>) {
    if (sdkLoader) {
      this.sdkLoader = sdkLoader
    } else {
      // Production path: dynamic import guarded by import.meta.client
      this.sdkLoader = async (token: string): Promise<HeyGenSession> => {
        /* v8 ignore next 3 — dead branch: import.meta.client is always true in production builds; unreachable via define in test builds */
        if (!import.meta.client) {
          throw new Error('HeyGenProvider: SDK must only be loaded in a client-side context.')
        }
        const sdk = await import('@heygen/liveavatar-web-sdk')
        return new sdk.LiveAvatarSession(token) as unknown as HeyGenSession
      }
    }
  }

  on(evt: ProviderEvent, cb: EventCallback): void {
    const existing = this.listeners.get(evt) ?? []
    this.listeners.set(evt, [...existing, cb])
  }

  private emit(evt: ProviderEvent, payload: unknown): void {
    for (const cb of this.listeners.get(evt) ?? []) {
      cb(payload)
    }
  }

  private emitState(state: ProviderState): void {
    this.emit('state', state)
  }

  async start(mountEl: HTMLElement, cfg: StartConfig): Promise<{ providerSessionId?: string }> {
    // Absent-phrase guard (D4 CRITICAL):
    // If either phrase is absent, emit 'error' immediately — do NOT start the SDK.
    // The state machine transitions to 'terminal' (not retryable) on this error.
    if (!cfg.endPhrase || !cfg.finalPhrase) {
      this.emit('error', {
        code: 'absent_phrase',
        message:
          'endPhrase and finalPhrase must both be non-empty strings before starting the HeyGen provider.',
      })
      return {}
    }

    this.phrases = { endPhrase: cfg.endPhrase, finalPhrase: cfg.finalPhrase }
    this.emitState('connecting')

    try {
      // Load the SDK session (either real SDK or injected mock)
      this.session = await this.sdkLoader(cfg.sessionToken ?? '')

      // Wire SDK event handlers for transcript capture.
      // AgentEventsEnum values (from @heygen/liveavatar-web-sdk):
      //   "avatar.transcription" — avatar speech text
      //   "user.transcription"   — candidate speech text
      this.session.on('avatar.transcription', (data) => {
        const text = String(data?.['text'] ?? '')

        const entry: TranscriptEntry = {
          role: 'avatar',
          text,
          ts: Date.now(),
        }
        this.emit('transcript', entry)

        // Completion detection: check avatar speech against the project-language phrases
        if (this.phrases && matchesEndPhrase(text, this.phrases)) {
          this.emitState('complete')
        }
      })

      this.session.on('user.transcription', (data) => {
        const text = String(data?.['text'] ?? '')

        const entry: TranscriptEntry = {
          role: 'user',
          text,
          ts: Date.now(),
        }
        this.emit('transcript', entry)
      })

      // Start the LiveAvatar session (connects to HeyGen via LiveKit/WebRTC)
      await this.session.start()

      // Attach the media stream to the provided mount element
      if (mountEl instanceof HTMLMediaElement) {
        this.session.attach(mountEl)
      }

      this.emitState('ready')
      this.emitState('listening')

      // Start listening so the candidate can speak
      this.session.startListening()

      return {}
    } catch {
      // A stable code, never String(err) — the SDK's error text names the
      // vendor and its hosts. See the same guard in tavus.ts.
      this.emit('error', { code: 'sdk_error', message: 'provider_unavailable' })
      return {}
    }
  }

  async toggleMic(): Promise<void> {
    if (!this.session) return
    this.micMuted = !this.micMuted
    if (this.micMuted) {
      this.session.stopListening()
    } else {
      this.session.startListening()
    }
  }

  async stop(): Promise<void> {
    if (this.session) {
      try {
        await this.session.stop()
      } catch {
        /* v8 ignore next — SDK stop() error path; non-fatal, covered by integration tests */
      }
    }
    this.emitState('stopped')
  }

  /**
   * Send a soft wrap-up prompt via session.message().
   *
   * The message is supplied by the caller from i18n in the project language — this
   * provider must not author avatar speech. A blank message is dropped rather than
   * sent: `session.message('')` inside a swallowing try/catch did nothing at all.
   */
  nudgeWrapUp(message: string): void {
    if (!this.session) return
    if (!message.trim()) return
    try {
      this.session.message(message)
    } catch {
      /* v8 ignore next — nudge failure; non-fatal */
    }
  }
}
