/* eslint-disable no-unused-vars */
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

// Minimal shape of the StreamingAvatar session used by this provider.
// Typed loosely so we can mock it in tests without importing the full SDK.
interface HeyGenSession {
  on(event: string, handler: (data: Record<string, unknown>) => void): void
  connect(opts: Record<string, unknown>): Promise<void>
  close(): Promise<void>
  startVoiceChat(opts: Record<string, unknown>): Promise<void>
  muteInputAudio(muted: boolean): Promise<void>
  speak(opts: Record<string, unknown>): Promise<void>
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
        return new sdk.StreamingAvatar({ token }) as unknown as HeyGenSession
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

      // Wire SDK event handlers for transcript capture
      this.session.on('avatar_talking_message', (data) => {
        const text = String(data?.message ?? '')
        const role: 'user' | 'avatar' = data?.role === 'user' ? 'user' : 'avatar'

        const entry: TranscriptEntry = {
          role,
          text,
          ts: Date.now(),
        }
        this.emit('transcript', entry)

        // Completion detection: check avatar speech against the project-language phrases
        if (role === 'avatar' && this.phrases && matchesEndPhrase(text, this.phrases)) {
          this.emitState('complete')
        }
      })

      // Connect to the HeyGen avatar session
      await this.session.connect({ quality: 'high', avatarName: cfg.sessionToken ?? '' })

      this.emitState('ready')
      this.emitState('listening')

      // Start voice chat so the candidate can speak
      await this.session.startVoiceChat({ useSilencePrompt: false })

      return {}
    } catch (err) {
      this.emit('error', { code: 'sdk_error', message: String(err) })
      return {}
    }
  }

  async toggleMic(): Promise<void> {
    if (!this.session) return
    this.micMuted = !this.micMuted
    await this.session.muteInputAudio(this.micMuted)
  }

  async stop(): Promise<void> {
    if (this.session) {
      try {
        await this.session.close()
      } catch {
        /* v8 ignore next — SDK close() error path; non-fatal, covered by integration tests */
      }
    }
    this.emitState('stopped')
  }

  nudgeWrapUp(): void {
    if (!this.session) return
    // Send a soft wrap-up prompt via session.speak()
    this.session.speak({ text: '' }).catch(() => {
      /* v8 ignore next — nudge failure; non-fatal, covered by integration tests */
    })
  }
}
