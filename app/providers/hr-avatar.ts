/**
 * Third interview provider: a thin adapter over the engine's browser SDK.
 *
 * SSR INVARIANT: the SDK is reached ONLY through a dynamic `import()` inside the
 * default `sdkLoader`, guarded by `import.meta.client`, and this module itself is only
 * ever loaded by the flag-gated deferred handle in factory.ts. SDK types come from a
 * `typeof import()` query, never from an `import` line, so the textual scan in
 * provider-anonymity.spec.ts stays valid.
 *
 * Opacity: SDK failures reach the session loop as a stable `{ code, message }` pair. The
 * SDK's own text, the base URL and both keys are never forwarded, logged or put in the DOM.
 */

import type {
  InterviewProvider,
  ProviderEvent,
  ProviderState,
  StartConfig,
  TranscriptEntry,
} from '~/app/types/interview-provider'
import { AVATAR_SETTLE_MS } from '~/app/providers/tavus'
import { COMPLETION_FALLBACK_MS } from '~/app/utils/closing-completion'

type EventCallback = (payload: unknown) => void

type Sdk = typeof import('@hr-avatar/sdk')
/** The one export the adapter uses: the package entry hangs `connect` off this object. */
type SdkEntry = Pick<Sdk, 'HrAvatar'>
type SdkConversation = Awaited<ReturnType<Sdk['HrAvatar']['connect']>>

/**
 * Whether BEAI asks the SDK to forward final utterances to the engine. BEAI's own
 * `utterances` rows stay the transcript of record, so it is off. The SDK suppresses
 * UTTERANCE forwarding only; the lifecycle events are always forwarded (HR-Avatar
 * reconciliation item 39), so `false` cannot strand a conversation in `connecting`.
 */
export const HR_AVATAR_FORWARD_TRANSCRIPT = false

/** The SDK's own code for an origin-allowlist refusal. */
const ORIGIN_REFUSED = 'origin_not_allowed'

export class HrAvatarProvider implements InterviewProvider {
  private readonly listeners = new Map<ProviderEvent, EventCallback[]>()
  private conversation: SdkConversation | null = null
  private lastState: ProviderState | null = null
  private micMuted = false
  private stopping = false

  private readonly sdkLoader: () => Promise<SdkEntry>

  constructor(sdkLoader?: () => Promise<SdkEntry>) {
    this.sdkLoader =
      sdkLoader ??
      (async () => {
        // `import.meta.server`, not `!import.meta.client`: Vitest defines neither, so the
        // negated form would also throw in unit tests, where the default loader is exercised.
        /* v8 ignore next 3 — dead branch: import.meta.server is false in the client bundle and in Vitest */
        if (import.meta.server) {
          throw new Error('HrAvatarProvider: the SDK must only be loaded client-side.')
        }
        return import('@hr-avatar/sdk')
      })
  }

  on(evt: ProviderEvent, cb: EventCallback): void {
    this.listeners.set(evt, [...(this.listeners.get(evt) ?? []), cb])
  }

  private emit(evt: ProviderEvent, payload: unknown): void {
    for (const cb of this.listeners.get(evt) ?? []) cb(payload)
  }

  /** Emits a state unless it repeats the previous one (the SDK replays `connecting` on subscribe). */
  private emitState(state: ProviderState): void {
    if (state === this.lastState) return
    this.lastState = state
    this.emit('state', state)
  }

  private emitError(code: string): void {
    this.emit('error', { code, message: 'provider_unavailable' })
  }

  async start(mountEl: HTMLElement, cfg: StartConfig): Promise<{ providerSessionId?: string }> {
    // Absent-phrase guard: terminal for the session loop, and the SDK is not loaded.
    if (!cfg.endPhrase || !cfg.finalPhrase) {
      this.emitError('absent_phrase')
      return {}
    }
    if (!cfg.hrAvatar || !cfg.sessionToken) {
      this.emitError('sdk_error')
      return {}
    }

    this.stopping = false
    this.lastState = null
    this.emitState('connecting')

    try {
      const sdk = await this.sdkLoader()
      const conversation = await sdk.HrAvatar.connect({
        baseUrl: cfg.hrAvatar.baseUrl,
        publishableKey: cfg.hrAvatar.publishableKey,
        clientSecret: cfg.sessionToken,
        mount: mountEl,
        ...(cfg.audioDeviceId ? { audioDeviceId: cfg.audioDeviceId } : {}),
        completionPhrases: [cfg.endPhrase, cfg.finalPhrase],
        forwardTranscript: HR_AVATAR_FORWARD_TRANSCRIPT,
      })

      // Stopped while connecting: nobody is listening any more, so release it at once.
      if (this.stopping) {
        await conversation.end().catch(() => {})
        return {}
      }

      this.conversation = conversation
      this.wire(conversation)
      return {}
    } catch (error) {
      // A stable code, never the SDK's text: it names the engine and its host.
      const code = (error as { code?: unknown } | null)?.code
      this.emitError(code === ORIGIN_REFUSED ? ORIGIN_REFUSED : 'sdk_error')
      return {}
    }
  }

  private wire(conversation: SdkConversation): void {
    conversation.on('state', (state) => {
      if (state === 'connecting') this.emitState('connecting')
      else if (state === 'live') this.emitState('ready')
      else if (state === 'ended') {
        // Deferred one macrotask so a same-tick completion can win over `stopped`.
        setTimeout(() => this.emitState('stopped'), 0)
      } else this.emitError('sdk_error')
    })

    conversation.on('transcript', (entry) => {
      if (!entry.final) return
      const parsed = Date.parse(entry.occurredAt)
      this.emit('transcript', {
        role: entry.role,
        text: entry.text,
        ts: Number.isNaN(parsed) ? Date.now() : parsed,
      } satisfies TranscriptEntry)
    })
  }

  /** Flips the microphone; the SDK returns the new muted state, which the mirror follows. */
  async toggleMic(): Promise<void> {
    if (!this.conversation) return
    this.micMuted = this.conversation.toggleMic()
  }

  async setMicMuted(muted: boolean): Promise<void> {
    if (!this.conversation || this.micMuted === muted) return
    await this.conversation.setMicMuted(muted)
    this.micMuted = muted
  }

  /**
   * Resolves once the avatar has been silent for the shared settle window, or after
   * `maxMs` at the latest. Never rejects.
   */
  whenAvatarSilent(maxMs: number = COMPLETION_FALLBACK_MS): Promise<void> {
    const conversation = this.conversation
    if (!conversation) return Promise.resolve()

    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, maxMs)
      conversation
        .whenAvatarSilent(AVATAR_SETTLE_MS)
        .catch(() => {})
        .then(() => {
          clearTimeout(timer)
          resolve()
        })
    })
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    try {
      await this.conversation?.end()
    } catch {
      /* teardown is best effort: the engine ends the conversation on its own ceiling */
    }
  }
}
