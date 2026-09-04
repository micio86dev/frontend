/**
 * AvatarPlayer.client.vue — audio channel ownership.
 *
 * The <video> in this component carries the INTERVIEWER's audio. It used to bind
 * `:muted="micMuted"`, where micMuted is the CANDIDATE's microphone state — two
 * unrelated channels. A candidate who muted their mic stopped hearing the interview.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InterviewProvider, StartConfig } from '~/app/types/interview-provider'

const CONFIG: StartConfig = {
  dbSessionId: 1,
  sessionToken: 'tok',
  endPhrase: 'Passiamo alla prossima domanda.',
  finalPhrase: 'Grazie per il tuo tempo.',
}

function makeProvider(): InterviewProvider {
  return {
    on: vi.fn(),
    start: vi.fn(async () => ({})),
    stop: vi.fn(async () => undefined),
    toggleMic: vi.fn(async () => undefined),
    // B1 (four-lens review): AvatarPlayer now seeds this session's mic
    // uplink right after start() resolves. Every fixture in this suite
    // therefore needs a real setMicMuted() to mount without throwing.
    setMicMuted: vi.fn(async () => undefined),
  }
}

async function mountPlayer(provider: InterviewProvider, extraProps: Record<string, unknown> = {}) {
  const { default: AvatarPlayer } = await import('~/app/components/AvatarPlayer.client.vue')
  const wrapper = mount(AvatarPlayer, {
    props: { provider, config: CONFIG, ...extraProps },
    global: { mocks: { $t: (key: string) => key }, stubs: { Skeleton: true } },
  })
  await nextTick()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AvatarPlayer.client.vue', () => {
  it('renders the avatar video UNMUTED even when the candidate mic is reported muted', async () => {
    // `micMuted: true` is passed deliberately. Reinstating the `micMuted` prop and the
    // `:muted="micMuted"` binding on the <video> makes this fail, which is the point:
    // the candidate's microphone state must never gate the interviewer's audio.
    const wrapper = await mountPlayer(makeProvider(), { micMuted: true })

    const video = wrapper.find('video').element as HTMLVideoElement
    expect(video.muted).toBe(false)
    expect(wrapper.find('video').attributes('muted')).toBeUndefined()
  })

  it("declares no micMuted prop — the candidate mic is not this component's concern", async () => {
    // `muted` (invisible-competency-handover D4) and `overlay` (D6 position
    // fix below) ARE legitimate declared props now — `micMuted` specifically
    // stays absent: the candidate's own microphone is never this
    // component's concern.
    const { default: AvatarPlayer } = await import('~/app/components/AvatarPlayer.client.vue')
    const declaredProps = (AvatarPlayer as unknown as { props?: Record<string, unknown> }).props

    // `audioOnly` joined the list for voice-only templates. It describes the
    // INTERVIEW (no video track on the stream), never the candidate's
    // microphone — which is what this exact-list assertion exists to keep out.
    expect(Object.keys(declaredProps ?? {})).toEqual([
      'provider',
      'config',
      'overlay',
      'muted',
      'audioOnly',
    ])
    expect(Object.keys(declaredProps ?? {})).not.toContain('micMuted')
  })

  it('starts the provider against the <video> element, not a detached node', async () => {
    // provider.start() attaches media ONLY when the mount element is an
    // HTMLMediaElement; anything else silently attaches nothing.
    const provider = makeProvider()
    const wrapper = await mountPlayer(provider)

    expect(provider.start).toHaveBeenCalledTimes(1)
    const [mountEl, config] = (provider.start as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect((mountEl as HTMLElement).tagName).toBe('VIDEO')
    expect(mountEl).toBe(wrapper.find('video').element)
    expect(config).toStrictEqual(CONFIG)
  })

  it('stops the provider on unmount', async () => {
    const provider = makeProvider()
    const wrapper = await mountPlayer(provider)

    wrapper.unmount()
    await nextTick()

    expect(provider.stop).toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // invisible-competency-handover D4 — the `muted` prop, applied IMPERATIVELY.
  //
  // Governs the HANDOVER role's downlink (outgoing vs a hidden incoming
  // warming up behind it) — never the candidate's own microphone, which
  // stays the `micMuted`-prohibition test above.
  // ---------------------------------------------------------------------------

  describe('muted prop (D4) — handover downlink, applied imperatively', () => {
    it('3.1 — mounts with videoEl.muted === true when muted is passed', async () => {
      const wrapper = await mountPlayer(makeProvider(), { muted: true })
      const video = wrapper.find('video').element as HTMLVideoElement

      expect(video.muted).toBe(true)
    })

    it('defaults muted to false when the prop is omitted', async () => {
      const wrapper = await mountPlayer(makeProvider())
      const video = wrapper.find('video').element as HTMLVideoElement

      expect(video.muted).toBe(false)
    })

    it('3.3 — reacts to muted flipping false after mount, unmuting the already-playing element', async () => {
      // Unmuting an ALREADY-MOUNTED, already-playing element is exactly why
      // D4 requires the imperative DOM-property form: a template `:muted`
      // binding only ever affects the ATTRIBUTE, consulted once at parse
      // time — it would silently fail to unmute a video already playing.
      const wrapper = await mountPlayer(makeProvider(), { muted: true })
      const video = wrapper.find('video').element as HTMLVideoElement
      expect(video.muted).toBe(true)

      await wrapper.setProps({ muted: false })

      expect(video.muted).toBe(false)
    })

    it('writes the muted DOM PROPERTY imperatively, not via a template attribute binding', async () => {
      // The template carries NO `:muted` binding at all (grep-checkable) — the
      // pre-existing "renders UNMUTED" test above already pins the `muted:
      // false` (default) case to `attributes('muted')` being absent; this
      // pins that the PROPERTY (not just the initial attribute) is what
      // actually silences/unsilences playback.
      const wrapper = await mountPlayer(makeProvider(), { muted: true })
      const video = wrapper.find('video').element as HTMLVideoElement

      expect(video.muted).toBe(true)

      const source = readFileSync(
        join(process.cwd(), 'app', 'components', 'AvatarPlayer.client.vue'),
        'utf8'
      )
      const templateOnly = source.slice(0, source.indexOf('</template>'))
      expect(templateOnly).not.toMatch(/:muted="/)
    })
  })

  // ---------------------------------------------------------------------------
  // invisible-competency-handover D6/F3 — `painted`, not the provider's `ready`.
  // ---------------------------------------------------------------------------

  describe('painted emit (D6) — a real frame, never the provider ready state', () => {
    it('3.6 — emits painted exactly once when the <video> fires loadeddata', async () => {
      const wrapper = await mountPlayer(makeProvider())
      const video = wrapper.find('video').element as HTMLVideoElement

      video.dispatchEvent(new Event('loadeddata'))
      video.dispatchEvent(new Event('loadeddata')) // a late, second event must not double-emit
      await nextTick()

      expect(wrapper.emitted('painted')).toHaveLength(1)
    })

    it('emits painted on `playing` too, whichever fires first', async () => {
      const wrapper = await mountPlayer(makeProvider())
      const video = wrapper.find('video').element as HTMLVideoElement

      video.dispatchEvent(new Event('playing'))
      await nextTick()

      expect(wrapper.emitted('painted')).toHaveLength(1)
    })

    it("B1 — seeds the session's OWN mic uplink from `muted` once, right after start() resolves", async () => {
      // Four-lens review B1: `beginHandover()` only ever muted the OUTGOING;
      // nothing muted the INCOMING's uplink, so for the whole overlap TWO
      // conversational sessions listened to the candidate. `setMicMuted()` is
      // a guaranteed no-op before the underlying session exists (heygen.ts:
      // `this.session?.voiceChat` is undefined until start() resolves), so
      // this is the earliest point at which muting an incoming session is
      // even possible.
      const provider = makeProvider()
      await mountPlayer(provider, { muted: true })
      await nextTick()

      expect(provider.setMicMuted).toHaveBeenCalledWith(true)
    })

    it('B1 — calls setMicMuted AFTER start(), never before (no window with a live, unmuted mic)', async () => {
      const provider = makeProvider()
      const callOrder: string[] = []
      provider.start = vi.fn(async () => {
        callOrder.push('start')
        return {}
      })
      provider.setMicMuted = vi.fn(async (muted: boolean) => {
        callOrder.push(`setMicMuted:${muted}`)
      })

      await mountPlayer(provider, { muted: true })
      await nextTick()

      expect(callOrder).toEqual(['start', 'setMicMuted:true'])
    })

    it('B1 — a `live`-role mount (muted=false) also seeds setMicMuted(false) — harmless, idempotent on the provider side', async () => {
      const provider = makeProvider()
      await mountPlayer(provider) // muted defaults to false
      await nextTick()

      expect(provider.setMicMuted).toHaveBeenCalledWith(false)
    })

    it("B1 — does NOT re-call setMicMuted when `muted` flips later — unmuting the incoming mic is promote()'s job, not this prop reacting", async () => {
      const provider = makeProvider()
      const wrapper = await mountPlayer(provider, { muted: true })
      await nextTick()
      expect(provider.setMicMuted).toHaveBeenCalledTimes(1)

      await wrapper.setProps({ muted: false }) // e.g. the D6 `entering` role
      await nextTick()

      expect(provider.setMicMuted).toHaveBeenCalledTimes(1)
    })

    it('requestVideoFrameCallback — the PRIMARY paint detector — fires `painted` on its own, with no DOM event needed', async () => {
      // jsdom has no requestVideoFrameCallback, and the E2E mock only ever
      // dispatches `loadeddata` — so in production, where rVFC exists on
      // Chromium/Safari 15.4+, this branch had NEVER been exercised by any
      // test. Stub it on the prototype BEFORE mounting so
      // wirePaintedDetection() picks it up during onMounted, then restore it
      // unconditionally afterward so this stub cannot leak into later tests.
      type RvfcVideo = HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => void
      }
      const rvfcCallback: { fn: (() => void) | null } = { fn: null }
      const proto = window.HTMLVideoElement.prototype as RvfcVideo
      const original = proto.requestVideoFrameCallback
      proto.requestVideoFrameCallback = function (this: HTMLVideoElement, cb: () => void) {
        rvfcCallback.fn = cb
      }

      try {
        const provider = makeProvider()
        const wrapper = await mountPlayer(provider)
        await nextTick()

        expect(rvfcCallback.fn).toBeTypeOf('function')
        expect(wrapper.emitted('painted')).toBeUndefined() // armed, not yet fired

        rvfcCallback.fn!() // the browser presents a frame
        await nextTick()

        expect(wrapper.emitted('painted')).toHaveLength(1)
        expect((wrapper.element as HTMLElement).className).toContain('opacity-100')

        // Never fires twice even if a late `loadeddata` ALSO arrives.
        wrapper.find('video').element.dispatchEvent(new Event('loadeddata'))
        await nextTick()
        expect(wrapper.emitted('painted')).toHaveLength(1)
      } finally {
        proto.requestVideoFrameCallback = original
      }
    })

    it("3.5/F3 — the provider's own 'ready' state does NOT drive the opacity gate; only painted does", async () => {
      const provider = makeProvider()
      const wrapper = await mountPlayer(provider)

      const stateHandler = (provider.on as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0] === 'state'
      )?.[1] as ((payload: unknown) => void) | undefined

      // heygen.ts:315 emits 'ready' unconditionally — no frame implied.
      stateHandler?.('ready')
      await nextTick()

      expect((wrapper.element as HTMLElement).className).toContain('opacity-0')
      expect(wrapper.emitted('painted')).toBeUndefined()

      wrapper.find('video').element.dispatchEvent(new Event('loadeddata'))
      await nextTick()

      expect((wrapper.element as HTMLElement).className).toContain('opacity-100')
      expect(wrapper.emitted('painted')).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------------
  // `overlay` prop — position class, decided INSIDE this component.
  //
  // Regression coverage for a handover visual glitch: the incoming player's
  // positioning used to be forced from session.vue via a
  // `class="absolute inset-0"` fallthrough, string-concatenated onto this
  // component's own root `relative` class. Both `absolute` and `relative`
  // ended up on the same element, and which one actually applied depended on
  // Tailwind's generated CSS order, not on DOM class order — during a
  // handover this could leave the incoming player in normal document flow,
  // clipped by the parent's `overflow-hidden` instead of overlaying
  // invisibly on top of the live one. `overlay` makes the two classes
  // mutually exclusive by construction: no parent-injected class to collide
  // with.
  // ---------------------------------------------------------------------------

  describe('overlay prop (D6 fix) — position class owned internally, never via a class fallthrough', () => {
    it('is in normal flow (relative, never absolute) when overlay is false — the live slot', async () => {
      const wrapper = await mountPlayer(makeProvider(), { overlay: false })
      const root = wrapper.element as HTMLElement

      expect(root.classList.contains('relative')).toBe(true)
      expect(root.classList.contains('absolute')).toBe(false)
      expect(root.classList.contains('inset-0')).toBe(false)
    })

    it('is absolutely positioned (never relative) when overlay is true — a handover incoming/entering slot', async () => {
      const wrapper = await mountPlayer(makeProvider(), { overlay: true })
      const root = wrapper.element as HTMLElement

      expect(root.classList.contains('absolute')).toBe(true)
      expect(root.classList.contains('inset-0')).toBe(true)
      expect(root.classList.contains('relative')).toBe(false)
    })

    it('defaults overlay to false when the prop is omitted', async () => {
      const wrapper = await mountPlayer(makeProvider())
      const root = wrapper.element as HTMLElement

      expect(root.classList.contains('relative')).toBe(true)
      expect(root.classList.contains('absolute')).toBe(false)
    })
  })
})

/**
 * Voice-only templates.
 *
 * A template with `audioOnly` produces a stream with no video track. The
 * element still received it and painted an undecoded frame — vertical green
 * and black banding, for the whole interview, in the rectangle where a
 * candidate expects a face.
 */
describe('AvatarPlayer — voice-only', () => {
  it('renders the voice visualizer instead of showing the video element', async () => {
    const wrapper = await mountPlayer(makeProvider(), { audioOnly: true })

    expect(wrapper.find('[data-testid="voice-visualizer"]').exists()).toBe(true)
  })

  it('KEEPS the media element mounted, merely out of sight', async () => {
    // The element owns playback. Unmounting it — or hiding it with `display:
    // none`, which frees a browser to stop rendering — silences the
    // interviewer, which is a worse defect than the banding this replaces.
    const wrapper = await mountPlayer(makeProvider(), { audioOnly: true })

    const video = wrapper.find('video')

    expect(video.exists()).toBe(true)
    expect(video.classes()).not.toContain('hidden')
    expect(video.attributes('aria-hidden')).toBe('true')
  })

  it('shows no visualizer for a normal template', async () => {
    const wrapper = await mountPlayer(makeProvider())

    expect(wrapper.find('[data-testid="voice-visualizer"]').exists()).toBe(false)
    expect(wrapper.find('video').classes()).toContain('size-full')
  })

  it('defaults to showing the avatar when nothing says otherwise', async () => {
    // Fail toward "a video panel for a voiceless stream", which is visible and
    // reportable, never toward "no avatar at all", which reads as the product
    // deciding to hide the interviewer.
    const wrapper = await mountPlayer(makeProvider())

    expect(wrapper.find('[data-testid="voice-visualizer"]').exists()).toBe(false)
  })
})
