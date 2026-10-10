/**
 * Tavus provider, over Daily's call object (C14 PR1).
 *
 * SSR INVARIANT (D2, CRITICAL):
 * The @daily-co/daily-js module references browser globals at import evaluation
 * time. It MUST NEVER be imported at module scope — only via dynamic
 * `await import()` inside a function guarded by `import.meta.client`.
 *
 * PROVIDER OPACITY (C14): the candidate must not be able to tell which service
 * is behind the face.
 *
 * This used `Daily.createFrame`, which embeds a VISIBLE daily.co iframe
 * carrying the vendor's own chrome into the interview page — not a subtle tell
 * but the vendor's UI, on screen, in front of the candidate, and named by every
 * DOM inspection. A call object has no UI at all: we take the remote tracks and
 * render them into our own <video>, so the page looks like the page.
 *
 * COMPLETION: the avatar's spoken end phrase, the same signal HeyGen uses.
 * Detection previously relied solely on a `conversation.tool_call` app message
 * naming `end_interview` — a tool that is never registered, so the message
 * never arrives and the interview ran to timeout instead of finishing. An
 * interview that never completes is never scored. The tool call is kept as a
 * second path because it costs three lines and is the more precise signal if it
 * ever starts firing.
 */

import type {
  InterviewProvider,
  ProviderEvent,
  ProviderState,
  StartConfig,
  SteeringFailure,
  SteeringResult,
  SupportsContextSteering,
} from '~/app/types/interview-provider'
import {
  buildAdvancePayload,
  RESPOND_TEXT,
  type TavusBoundaryTicket,
} from '~/app/utils/advance-interaction'
import { matchesEndPhrase } from '~/app/utils/proctor-config'

/** The slice of Daily's call object this provider uses. */
interface DailyCallObject {
  on(event: string, handler: (data: Record<string, unknown>) => void): void
  join(opts: Record<string, unknown>): Promise<void>
  leave(): Promise<void>
  destroy(): Promise<void>
  setLocalAudio(enabled: boolean): void
  localAudio(): boolean
  meetingState(): string
  sendAppMessage(data: unknown, to: string): void
}

/** How long the avatar has to answer a boundary steering (N5). */
export const STEERING_ACK_TIMEOUT_MS = 10_000

/** One armed steering: settles once, and may hold the respond's user-role echo (N15). */
interface Steering {
  settle: (result: SteeringResult) => void
  timer: ReturnType<typeof setTimeout>
  held: { data: Record<string, unknown>; speech: string } | null
}

type EventCallback = (payload: unknown) => void

/** How many avatar utterance keys are remembered for duplicate suppression. */
const SEEN_AVATAR_LIMIT = 50

/** Twin window for avatar events that carry no `inference_id`. */
const TWIN_WINDOW_MS = 2000

export class TavusProvider implements InterviewProvider, SupportsContextSteering {
  private readonly listeners = new Map<ProviderEvent, EventCallback[]>()
  private call: DailyCallObject | null = null
  private phrases: { endPhrase: string; finalPhrase: string } | null = null
  private emittedReady = false
  private steering: Steering | null = null
  /** Set by `stop()`: a `left-meeting` after it is ours, not an unannounced end. */
  private stopping = false

  /**
   * Avatar utterances already emitted (key -> time seen), oldest first.
   *
   * Tavus sends each avatar utterance twice: role "replica" and the legacy
   * duplicate role "pal". Only the first copy is emitted.
   */
  private readonly seenAvatar = new Map<string, number>()

  /** The element we render into, and the stream we build up track by track. */
  private videoEl: HTMLVideoElement | null = null
  private stream: MediaStream | null = null

  private readonly sdkLoader: (mountEl: HTMLElement) => Promise<DailyCallObject>

  constructor(sdkLoader?: (mountEl: HTMLElement) => Promise<DailyCallObject>) {
    this.sdkLoader =
      sdkLoader ??
      (async (): Promise<DailyCallObject> => {
        /* v8 ignore next 3 — dead branch: import.meta.client is always true in production builds */
        if (!import.meta.client) {
          throw new Error('TavusProvider: SDK must only be loaded in a client-side context.')
        }

        const Daily = await import('@daily-co/daily-js')

        // videoSource false: the candidate's camera belongs to the proctoring
        // layer, which owns its own stream. Handing the same device to the
        // conversation SDK means two consumers of one camera, and on several
        // browsers the second one simply fails.
        return Daily.default.createCallObject({
          audioSource: true,
          videoSource: false,
        }) as unknown as DailyCallObject
      })
  }

  on(evt: ProviderEvent, cb: EventCallback): void {
    this.listeners.set(evt, [...(this.listeners.get(evt) ?? []), cb])
  }

  private emit(evt: ProviderEvent, payload: unknown): void {
    for (const cb of this.listeners.get(evt) ?? []) {
      cb(payload)
    }
  }

  private emitState(state: ProviderState): void {
    this.emit('state', state)
  }

  /**
   * Finds the <video> to render into.
   *
   * The mount element is a container the page owns; the provider does not
   * create or style anything, because anything it created would be a thing
   * whose shape gives the vendor away.
   */
  private resolveVideo(mountEl: HTMLElement): HTMLVideoElement | null {
    return mountEl instanceof HTMLVideoElement ? mountEl : mountEl.querySelector('video')
  }

  private attachTrack(track: MediaStreamTrack): void {
    if (this.videoEl === null) {
      return
    }

    this.stream ??= new MediaStream()
    this.stream.addTrack(track)

    // Reassigned on every track: audio and video arrive as separate events, and
    // some browsers ignore tracks added to a stream that is already assigned.
    this.videoEl.srcObject = this.stream
  }

  async start(mountEl: HTMLElement, cfg: StartConfig): Promise<{ providerSessionId?: string }> {
    this.emitState('connecting')
    this.phrases = { endPhrase: cfg.endPhrase, finalPhrase: cfg.finalPhrase }
    this.videoEl = this.resolveVideo(mountEl)

    try {
      this.call = await this.sdkLoader(mountEl)

      this.call.on('joined-meeting', () => {
        this.emittedReady = true
        this.emitState('ready')
      })

      this.call.on('track-started', (event) => {
        const participant = event?.participant as { local?: boolean } | undefined
        const track = event?.track as MediaStreamTrack | undefined

        // Local tracks are the candidate's own microphone. Piping those into
        // the avatar's element plays their voice back at them on a delay — the
        // most disorienting thing you can do to somebody being interviewed.
        if (participant?.local === true || track === undefined) {
          return
        }

        this.attachTrack(track)
      })

      this.call.on('left-meeting', () => {
        this.failSteering('left')

        // The conversation ended without `stop()` (the ceiling, observed: design
        // N17). Reported as a stop; the client decides whether that is a problem.
        if (!this.stopping) {
          this.stopping = true
          this.emitState('stopped')
        }
      })
      this.call.on('error', () => this.failSteering('error'))

      this.call.on('app-message', (event) => {
        this.handleAppMessage(event?.data as Record<string, unknown> | undefined)
      })

      await this.call.join({ url: cfg.conversationUrl ?? '', startVideoOff: true })

      if (!this.emittedReady) {
        this.emittedReady = true
        this.emitState('ready')
      }

      return {}
    } catch {
      // A STABLE CODE, never String(err).
      //
      // The SDK's own error text names the vendor — "daily.co", a room URL, a
      // LiveKit host — and an earlier version of this line carried it while a
      // comment above claimed it did not. Nothing consumes `message` today
      // (useInterviewSession switches on `code` alone), but a message that
      // exists is a message something will eventually render.
      this.emit('error', { code: 'sdk_error', message: 'provider_unavailable' })
      return {}
    }
  }

  private handleAppMessage(data: Record<string, unknown> | undefined): void {
    if (data === undefined) {
      return
    }

    // Path 1 — the tool call. Precise, and never observed to fire.
    if (data.type === 'conversation.tool_call' && data.name === 'end_interview') {
      this.emitState('complete')

      return
    }

    // Path 2 — the spoken phrase, which is what actually happens.
    if (data.event_type !== 'conversation.utterance') {
      return
    }

    const properties = data.properties as { role?: string; speech?: string } | undefined
    const speech = properties?.speech

    if (typeof speech !== 'string' || speech === '') {
      return
    }

    // Echo filter (N15): hold the first user-role copy of the respond trigger
    // while a steering is armed; it is settled when the avatar's reply arrives.
    if (
      properties?.role === 'user' &&
      this.steering !== null &&
      this.steering.held === null &&
      speech.trim().toLowerCase() === RESPOND_TEXT.toLowerCase()
    ) {
      this.steering.held = { data, speech }

      return
    }

    // "pal" is Tavus's legacy duplicate of "replica": both are the avatar.
    const isAvatar = properties?.role === 'replica' || properties?.role === 'pal'

    if (isAvatar && this.isDuplicateAvatar(data, speech)) {
      return
    }

    // The first de-duplicated avatar utterance acknowledges the steering. A held
    // echo is the platform's own text when the reply shares its inference_id;
    // otherwise it was candidate speech after all and is released first.
    const armed = isAvatar ? this.steering : null

    if (armed !== null) {
      const held = armed.held
      const id = data.inference_id

      this.settleSteering({ ok: true })

      if (held !== null && !(typeof id === 'string' && id === held.data.inference_id)) {
        this.emitUser(held.speech)
      }
    }

    this.emit('transcript', {
      role: isAvatar ? 'avatar' : 'user',
      text: speech,
      ts: Date.now(),
    })

    // Only the AVATAR's speech ends the interview. A candidate who reads the
    // closing line aloud — or is simply polite — must not be able to end their
    // own assessment early.
    if (isAvatar && this.phrases !== null && matchesEndPhrase(speech, this.phrases)) {
      this.emitState('complete')
    }
  }

  private emitUser(speech: string): void {
    this.emit('transcript', { role: 'user', text: speech, ts: Date.now() })
  }

  /** Disarms the filter and resolves the caller; a still-held echo is dropped. */
  private settleSteering(result: SteeringResult): void {
    const s = this.steering

    if (s === null) {
      return
    }

    clearTimeout(s.timer)
    this.steering = null
    s.settle(result)
  }

  private failSteering(reason: SteeringFailure['reason']): void {
    if (this.steering === null) {
      return
    }

    const failure: SteeringFailure = { ok: false, reason }

    this.settleSteering(failure)
    this.emit('steering_failed', failure)
  }

  /**
   * The ONLY outbound data-channel site: the append, then the mandatory respond
   * (design N5). Resolves on the avatar's first utterance, or with a failure
   * (also emitted as `steering_failed`); never throws.
   */
  sendBoundary(ticket: TavusBoundaryTicket): Promise<SteeringResult> {
    const refuse = (reason: SteeringFailure['reason']): Promise<SteeringResult> => {
      const failure: SteeringFailure = { ok: false, reason }

      this.emit('steering_failed', failure)

      return Promise.resolve(failure)
    }

    if (this.call === null || this.call.meetingState() !== 'joined-meeting') {
      return refuse('not_joined')
    }

    if (this.steering !== null) {
      return refuse('busy')
    }

    return new Promise<SteeringResult>((settle) => {
      this.steering = {
        settle,
        held: null,
        timer: setTimeout(() => this.failSteering('timeout'), STEERING_ACK_TIMEOUT_MS),
      }

      try {
        for (const msg of buildAdvancePayload(ticket)) {
          this.call?.sendAppMessage(msg, '*')
        }
      } catch {
        this.failSteering('send_failed')
      }
    })
  }

  /**
   * Records an avatar utterance and reports whether it was already seen.
   *
   * Rule: events sharing an `inference_id` are the same utterance (no time
   * limit). Without one, the key is (turn_idx, speech) and a twin only counts
   * inside TWIN_WINDOW_MS, so the avatar legitimately repeating a sentence
   * later is not swallowed.
   */
  private isDuplicateAvatar(data: Record<string, unknown>, speech: string): boolean {
    const id = data.inference_id
    const hasId = typeof id === 'string' && id !== ''
    const key = hasId ? `i:${id}` : `s:${String(data.turn_idx ?? '')}:${speech}`
    const now = Date.now()
    const prev = this.seenAvatar.get(key)

    if (prev !== undefined && (hasId || now - prev <= TWIN_WINDOW_MS)) {
      return true
    }

    this.seenAvatar.delete(key)
    this.seenAvatar.set(key, now)

    if (this.seenAvatar.size > SEEN_AVATAR_LIMIT) {
      this.seenAvatar.delete(this.seenAvatar.keys().next().value as string)
    }

    return false
  }

  async toggleMic(): Promise<void> {
    // This was an empty no-op carrying a comment that said the component
    // handled it. Nothing did — a candidate pressing mute stayed live, which on
    // a recorded assessment is a promise broken silently.
    this.call?.setLocalAudio(!this.call.localAudio())
  }

  /**
   * Assert an explicit mute state (pause/resume). Daily's `setLocalAudio` takes
   * ENABLED, so the flag is inverted: muted === audio disabled.
   */
  async setMicMuted(muted: boolean): Promise<void> {
    this.call?.setLocalAudio(!muted)
  }

  async stop(): Promise<void> {
    const alreadyReported = this.stopping

    this.stopping = true

    if (this.call) {
      try {
        await this.call.leave()
        await this.call.destroy()
      } catch {
        /* v8 ignore next — SDK teardown error path; non-fatal */
      }
    }

    if (this.videoEl !== null) {
      this.videoEl.srcObject = null
    }

    this.stream = null
    this.settleSteering({ ok: false, reason: 'left' })
    this.seenAvatar.clear()

    if (!alreadyReported) {
      this.emitState('stopped')
    }
  }
}
