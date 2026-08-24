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
 * Lifecycle: start() → (SESSION_STREAM_READY) attach(el) → stop()
 * Mic control: session.voiceChat.mute() / unmute()
 * Send message: message(text: string)
 * Interrupt barge-in: interrupt()
 * Events (AgentEventsEnum): AVATAR_TRANSCRIPTION, USER_TRANSCRIPTION,
 *   USER_SPEAK_STARTED, AVATAR_SPEAK_STARTED, AVATAR_SPEAK_ENDED
 * Events (SessionEvent): SESSION_STREAM_READY, SESSION_DISCONNECTED
 *
 * MICROPHONE (the contract that makes this provider work at all):
 * The SDK's internal `configureSession()` publishes the candidate's local audio
 * track ONLY when the constructor received a truthy `voiceChat` config —
 * `new LiveAvatarSession(token)` with no second argument produces a session that
 * can speak but can never hear. `startListening()` does NOT compensate: it only
 * emits an AVATAR_START_LISTENING command event on the agent socket.
 * See legacy-demo/src/providers/heygen.ts, the demonstrated-working wiring.
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
interface HeyGenVoiceChat {
  readonly isMuted: boolean
  mute(): Promise<void>
  unmute(): Promise<void>
}

interface HeyGenSession {
  on(event: string, handler: (data: never) => void): void
  start(): Promise<void>
  stop(): Promise<void>
  attach(element: HTMLMediaElement): void
  interrupt(): void
  message(text: string): string
  readonly voiceChat: HeyGenVoiceChat
}

/**
 * The `SessionConfig` subset this provider sets. Mirrors the SDK's own type rather
 * than importing it — importing pulls the SDK in at module scope, which the SSR
 * invariant above forbids.
 */
export interface HeyGenSessionConfig {
  voiceChat: {
    mode: 'CONVERSATIONAL' | 'PUSH_TO_TALK'
    defaultMuted: boolean
    deviceId?: string
  }
}

/**
 * SDK event names, as string literals.
 *
 * Deliberately NOT imported from the SDK's `SessionEvent`/`AgentEventsEnum`: those
 * are runtime enums, and importing them at module scope would evaluate the SDK
 * during SSR. The values are pinned by the unit tests against the shipped .d.ts.
 */
const SDK_EVENT = {
  streamReady: 'session.stream_ready',
  disconnected: 'session.disconnected',
  userSpeakStarted: 'user.speak_started',
  avatarSpeakStarted: 'avatar.speak_started',
  avatarSpeakEnded: 'avatar.speak_ended',
  userTranscription: 'user.transcription',
  avatarTranscription: 'avatar.transcription',
} as const

/** SessionDisconnectReason value for a disconnect this client asked for. */
const CLIENT_INITIATED = 'CLIENT_INITIATED'

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
  private avatarSpeaking = false
  /**
   * Set when the closing phrase is transcribed while the avatar is still talking.
   * The actual 'complete' is emitted on AVATAR_SPEAK_ENDED so the sentence finishes
   * in the candidate's ear before the question tears down.
   */
  private pendingComplete = false
  /**
   * Set the moment WE ask the session to stop.
   *
   * A disconnect arriving after that is expected teardown, not a failure. In
   * production the sequence was: the timer ended the question, /end returned
   * 200, we called stop(), and HeyGen's own MAX_DURATION_REACHED landed a beat
   * later with a server-initiated reason — which surfaced to the candidate as
   * "an error occurred" at the end of a question they had answered fully, while
   * the flow had in fact already moved on correctly.
   */
  private stopping = false

  /**
   * Injectable SDK loader for testability.
   * Production default: dynamically imports the real SDK under import.meta.client guard.
   */
  private readonly sdkLoader: (token: string, config: HeyGenSessionConfig) => Promise<HeyGenSession>

  constructor(sdkLoader?: (token: string, config: HeyGenSessionConfig) => Promise<HeyGenSession>) {
    if (sdkLoader) {
      this.sdkLoader = sdkLoader
    } else {
      // Production path: dynamic import guarded by import.meta.client
      this.sdkLoader = async (
        token: string,
        config: HeyGenSessionConfig
      ): Promise<HeyGenSession> => {
        /* v8 ignore next 3 — dead branch: import.meta.client is always true in production builds; unreachable via define in test builds */
        if (!import.meta.client) {
          throw new Error('HeyGenProvider: SDK must only be loaded in a client-side context.')
        }
        const sdk = await import('@heygen/liveavatar-web-sdk')

        // `voiceChat.mode` is a nominal enum in the SDK's types, so the string
        // literal this provider carries is not structurally assignable even though
        // the runtime values are identical ("CONVERSATIONAL"/"PUSH_TO_TALK").
        //
        // The target type is derived from the LOCAL `sdk` binding rather than a
        // top-level `import type`: tests/unit/provider-anonymity.spec.ts scans the
        // import lines textually and cannot tell `import type` from a value import
        // — correctly so, since one keystroke turns the erased form into the one
        // that evaluates the SDK during SSR and crashes the Nitro bundle.
        type SdkSessionConfig = ConstructorParameters<typeof sdk.LiveAvatarSession>[1]

        // The config is what makes the session able to HEAR — see the class comment.
        return new sdk.LiveAvatarSession(
          token,
          config as unknown as SdkSessionConfig
        ) as unknown as HeyGenSession
      }
    }
  }

  /**
   * Diagnostic breadcrumb for turn-taking (barge-in) and transcript events —
   * mirrors the `[handover]` console.info pattern in useInterviewSession.ts,
   * added for the same reason: a candidate-reported "the avatar cuts itself
   * off mid-sentence" defect left no trace to diagnose from. `console.info`
   * never throws, so this is always safe to call.
   */
  private logEvent(event: string, detail?: Record<string, unknown>): void {
    console.info(`[heygen] ${event}`, detail ?? {})
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
    this.avatarSpeaking = false
    this.stopping = false
    this.pendingComplete = false
    this.emitState('connecting')

    try {
      // CONVERSATIONAL = hands-free VAD turn-taking, NOT push-to-talk: the candidate
      // just speaks. defaultMuted:false so the mic is live from the first second —
      // there is no unmute affordance on the interview screen to recover from it.
      const sessionConfig: HeyGenSessionConfig = {
        voiceChat: {
          mode: 'CONVERSATIONAL',
          defaultMuted: false,
          ...(cfg.audioDeviceId ? { deviceId: cfg.audioDeviceId } : {}),
        },
      }

      // Load the SDK session (either real SDK or injected mock)
      const session = await this.sdkLoader(cfg.sessionToken ?? '', sessionConfig)
      this.session = session

      // ── Media attach ────────────────────────────────────────────────────────
      // attach() binds the avatar's video+audio tracks to the element. It belongs on
      // SESSION_STREAM_READY, not immediately after start(): start() resolves once the
      // room is joined, which is not the same instant the tracks exist.
      session.on(SDK_EVENT.streamReady, () => {
        if (!(mountEl instanceof HTMLMediaElement)) return
        session.attach(mountEl)
        void mountEl.play?.().catch(() => {})
        this.emitState('ready')
      })

      // ── Disconnection ───────────────────────────────────────────────────────
      // A dropped session used to be invisible: the candidate sat in front of a
      // frozen avatar with the session machine still believing it was live.
      session.on(SDK_EVENT.disconnected, (reason: never) => {
        this.session = null
        this.avatarSpeaking = false

        // Either WE asked for this, or the reason says the client did. Both are
        // ordinary teardown. Only an unexpected drop — one that arrives while we
        // still believe the session is live — is worth showing a candidate.
        if (this.stopping || String(reason) === CLIENT_INITIATED) {
          this.emitState('stopped')

          return
        }

        this.emit('error', { code: 'disconnected', message: 'provider_disconnected' })
      })

      // ── Turn-taking and barge-in ────────────────────────────────────────────
      // The candidate talking over the avatar must cut the avatar off, the way a
      // person would stop when interrupted. Server-side VAD also handles this in
      // CONVERSATIONAL mode, so a throwing interrupt() is not fatal.
      session.on(SDK_EVENT.userSpeakStarted, () => {
        // A false trigger here (mic picking up the avatar's own speech off
        // speakers, no headphones) reads identically to a real barge-in —
        // `avatarSpeaking: true` plus an `interrupted` log with no
        // corresponding `user.transcription` text a moment later is the
        // signature to look for when the avatar cuts itself off mid-sentence.
        this.logEvent('user_speak_started', { avatarSpeaking: this.avatarSpeaking })
        this.emitState('listening')
        if (!this.avatarSpeaking) return
        this.avatarSpeaking = false
        try {
          session.interrupt()
          this.logEvent('interrupted')
        } catch {
          /* server VAD covers barge-in in CONVERSATIONAL mode */
        }
      })

      session.on(SDK_EVENT.avatarSpeakStarted, () => {
        this.logEvent('avatar_speak_started')
        this.avatarSpeaking = true
        this.emitState('speaking')
      })

      session.on(SDK_EVENT.avatarSpeakEnded, () => {
        this.logEvent('avatar_speak_ended', { pendingComplete: this.pendingComplete })
        this.avatarSpeaking = false
        this.emitState('ready')
        // The closing phrase has now been spoken in full → the question is done.
        if (this.pendingComplete) {
          this.pendingComplete = false
          this.emitState('complete')
        }
      })

      // ── Transcripts ─────────────────────────────────────────────────────────
      // Only the final *_TRANSCRIPTION events; the *_CHUNK variants would persist
      // duplicate partials.
      session.on(SDK_EVENT.avatarTranscription, (data: never) => {
        const text = String((data as { text?: unknown })?.text ?? '')
        this.logEvent('avatar_transcription', { text })

        this.emit('transcript', { role: 'avatar', text, ts: Date.now() } satisfies TranscriptEntry)

        // Completion detection: the avatar marks a question done by SPEAKING the
        // configured phrase. Defer to AVATAR_SPEAK_ENDED if it is still mid-sentence.
        if (this.phrases && matchesEndPhrase(text, this.phrases)) {
          if (this.avatarSpeaking) this.pendingComplete = true
          else this.emitState('complete')
        }
      })

      session.on(SDK_EVENT.userTranscription, (data: never) => {
        const text = String((data as { text?: unknown })?.text ?? '')
        // An empty/very short text right after a `user_speak_started` log with
        // `avatarSpeaking: true` is the strongest signal of a false barge-in
        // (noise/echo, not real speech) rather than a genuine interruption.
        this.logEvent('user_transcription', { text })

        this.emit('transcript', { role: 'user', text, ts: Date.now() } satisfies TranscriptEntry)
      })

      // Start the LiveAvatar session (connects to HeyGen via LiveKit/WebRTC and,
      // because sessionConfig.voiceChat is set, publishes the candidate's mic).
      await session.start()

      // Emitted unconditionally rather than left to SESSION_STREAM_READY alone: the
      // session machine leaves its loading skeleton on 'ready'/'listening', and a
      // stream-ready event that never arrives would strand the candidate there.
      this.emitState('ready')
      this.emitState('listening')

      return {}
    } catch {
      // A stable code, never String(err) — the SDK's error text names the
      // vendor and its hosts. See the same guard in tavus.ts.
      this.emit('error', { code: 'sdk_error', message: 'provider_unavailable' })
      return {}
    }
  }

  /**
   * Mute/unmute the always-on conversational microphone.
   *
   * Reads `voiceChat.isMuted` rather than a provider-local mirror: anything that
   * mutes the track out-of-band (SDK-side mute, device loss) would desynchronise a
   * local boolean, and the button would then do the opposite of its label.
   */
  async toggleMic(): Promise<void> {
    const voiceChat = this.session?.voiceChat
    if (!voiceChat) return
    await this.setMicMuted(!voiceChat.isMuted)
  }

  async setMicMuted(muted: boolean): Promise<void> {
    const voiceChat = this.session?.voiceChat
    if (!voiceChat) return
    if (voiceChat.isMuted === muted) return
    if (muted) await voiceChat.mute()
    else await voiceChat.unmute()
  }

  async stop(): Promise<void> {
    // Set BEFORE awaiting: the disconnect can land while stop() is still in
    // flight, and that one is the most expected of all.
    this.stopping = true

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
