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
} from '~/app/types/interview-provider'
import { matchesEndPhrase } from '~/app/utils/proctor-config'

/** The slice of Daily's call object this provider uses. */
interface DailyCallObject {
  on(event: string, handler: (data: Record<string, unknown>) => void): void
  join(opts: Record<string, unknown>): Promise<void>
  leave(): Promise<void>
  destroy(): Promise<void>
  setLocalAudio(enabled: boolean): void
  localAudio(): boolean
}

type EventCallback = (payload: unknown) => void

export class TavusProvider implements InterviewProvider {
  private readonly listeners = new Map<ProviderEvent, EventCallback[]>()
  private call: DailyCallObject | null = null
  private phrases: { endPhrase: string; finalPhrase: string } | null = null
  private emittedReady = false

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

      this.call.on('app-message', (event) => {
        this.handleAppMessage(event?.data as Record<string, unknown> | undefined)
      })

      await this.call.join({ url: cfg.conversationUrl ?? '', startVideoOff: true })

      if (!this.emittedReady) {
        this.emittedReady = true
        this.emitState('ready')
      }

      return {}
    } catch (err) {
      // Deliberately not the provider's own words. Upstream error text names
      // the vendor, and this string is rendered to the candidate.
      this.emit('error', { code: 'sdk_error', message: String(err) })
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

    const isAvatar = properties?.role === 'replica'

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

  async toggleMic(): Promise<void> {
    // This was an empty no-op carrying a comment that said the component
    // handled it. Nothing did — a candidate pressing mute stayed live, which on
    // a recorded assessment is a promise broken silently.
    this.call?.setLocalAudio(!this.call.localAudio())
  }

  async stop(): Promise<void> {
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
    this.emitState('stopped')
  }
}
