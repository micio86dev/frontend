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
import {
  COMPLETION_FALLBACK_MS,
  COMPLETION_SETTLE_MS,
  closingFallbackMs,
} from '~/app/utils/closing-completion'
import { matchesEndPhrase } from '~/app/utils/proctor-config'

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
  private phrases: { endPhrase: string; finalPhrase: string } | null = null
  /**
   * The one terminal outcome of this start. Set once; every later terminal input is ignored,
   * so `complete` fires at most once and `stopped` never follows `complete` or `error`.
   * Reset only by `start()`.
   */
  private terminal: 'complete' | 'error' | 'stopped' | null = null
  /** A phrase match is settling: an SDK end during the wait completes instead of stopping. */
  private completing = false
  /** Bumped by every `start()`, so a timer or wait armed by an earlier start does nothing. */
  private generation = 0

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
    this.terminal = null
    this.completing = false
    this.generation += 1
    const generation = this.generation
    this.phrases = { endPhrase: cfg.endPhrase, finalPhrase: cfg.finalPhrase }
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

      // Stopped, or superseded by a newer start(), while connecting: nobody is listening
      // any more, so release it at once and leave the newer conversation alone.
      if (this.stopping || generation !== this.generation) {
        await conversation.end().catch(() => {})
        return {}
      }

      this.conversation = conversation
      this.wire(conversation)
      return {}
    } catch (error) {
      // A superseded start has no one left to tell.
      if (generation !== this.generation) return {}
      // A stable code, never the SDK's text: it names the engine and its host.
      const code = (error as { code?: unknown } | null)?.code
      this.emitError(code === ORIGIN_REFUSED ? ORIGIN_REFUSED : 'sdk_error')
      return {}
    }
  }

  private wire(conversation: SdkConversation): void {
    const generation = this.generation

    conversation.on('state', (state) => {
      if (state === 'connecting') this.emitState('connecting')
      else if (state === 'live') this.emitState('ready')
      else if (state === 'ended') {
        // Deferred one macrotask: the SDK reports the state before the reasoned `ended` event
        // in the same tick, and a completion must be able to win over `stopped`.
        setTimeout(() => this.settle('stopped', generation), 0)
      } else if (state === 'error') this.settle('error', generation)
      // Any other state is not a failure: ignored, the next known state decides.
    })

    conversation.on('error', () => this.settle('error', generation))

    conversation.on('ended', ({ reason }) => {
      if (reason === 'completion_phrase') this.settle('complete', generation)
      else if (reason === 'error') this.settle('error', generation)
      // Unrequested ends. A closing phrase still settling counts as heard: the conversation is
      // over, so waiting for silence is moot.
      else this.settle(this.completing ? 'complete' : 'stopped', generation)
    })

    conversation.on('transcript', (entry) => {
      if (!entry.final) return
      const parsed = Date.parse(entry.occurredAt)
      this.emit('transcript', {
        role: entry.role,
        text: entry.text,
        ts: Number.isNaN(parsed) ? Date.now() : parsed,
      } satisfies TranscriptEntry)

      // Only the AVATAR's words complete a question, never the candidate's.
      if (entry.role === 'avatar' && this.phrases && matchesEndPhrase(entry.text, this.phrases)) {
        this.holdCompletion(conversation, entry.text, generation)
      }
    })
  }

  /**
   * A closing phrase was heard: complete once the avatar has been silent for the settle
   * window, or after the lost-event fallback, whichever comes first.
   */
  private holdCompletion(conversation: SdkConversation, text: string, generation: number): void {
    if (this.completing || this.terminal !== null) return
    this.completing = true

    const done = (): void => this.settle('complete', generation)
    const fallback = setTimeout(done, closingFallbackMs(text))
    conversation
      .whenAvatarSilent(COMPLETION_SETTLE_MS)
      .catch(() => {})
      .then(() => {
        clearTimeout(fallback)
        done()
      })
  }

  /** Applies a terminal outcome unless this start already has one or the start is stale. */
  private settle(outcome: 'complete' | 'error' | 'stopped', generation: number): void {
    if (generation !== this.generation || this.terminal !== null) return
    this.terminal = outcome
    this.completing = false
    if (outcome === 'error') this.emitError('sdk_error')
    else this.emitState(outcome)
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
