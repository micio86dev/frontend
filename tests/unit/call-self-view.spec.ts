/**
 * CallSelfView.client.vue — the candidate's own camera tile
 * (DESIGN.md §7.3; change `candidate-interview-call-ui`, D5, A3).
 *
 * The contract pinned here: the tile PLAYS the stream it is given, unchanged
 * (the mirror is a CSS flip, never a new stream), is muted, has no controls,
 * can never take focus or a click, is named for assistive technology, shows a
 * named placeholder when no live video track exists, and never asks for the
 * camera itself. Tailwind utilities are asserted as classes because that is
 * how the tile is styled: a utility in the list is the style.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import CallSelfView from '../../app/components/molecules/CallSelfView.client.vue'

type Listener = () => void

function fakeTrack(readyState: 'live' | 'ended' = 'live') {
  const listeners = new Map<string, Set<Listener>>()
  return {
    kind: 'video',
    readyState,
    addEventListener: (type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener: (type: string, fn: Listener) => listeners.get(type)?.delete(fn),
    end() {
      this.readyState = 'ended'
      listeners.get('ended')?.forEach((fn) => fn())
    },
  }
}

// A real (happy-dom) MediaStream, because `srcObject` rejects anything else; only
// the track accessors are replaced so a test controls the tracks' state.
function fakeStream(videoTracks: ReturnType<typeof fakeTrack>[]) {
  const stream = new MediaStream()
  stream.getVideoTracks = () => videoTracks as unknown as MediaStreamTrack[]
  stream.getTracks = () => videoTracks as unknown as MediaStreamTrack[]
  return stream
}

function mountView(stream: MediaStream, props: Record<string, unknown> = {}) {
  return mount(CallSelfView, { props: { stream, ...props } })
}

const getUserMedia = vi.fn()
const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')

function spyOnGetUserMedia() {
  getUserMedia.mockReset()
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, enumerateDevices: vi.fn() },
  })
}

afterEach(() => {
  if (original) Object.defineProperty(navigator, 'mediaDevices', original)
  else delete (navigator as unknown as Record<string, unknown>).mediaDevices
})

describe('CallSelfView with a live video track', () => {
  it('plays the provided stream itself, not a copy of it', () => {
    const stream = fakeStream([fakeTrack()])
    const video = mountView(stream).get('video').element as HTMLVideoElement

    expect(video.srcObject).toBe(stream)
  })

  it('is muted, inline, autoplaying and has no controls', () => {
    const video = mountView(fakeStream([fakeTrack()])).get('video')
    const el = video.element as HTMLVideoElement

    expect(el.muted).toBe(true)
    expect(video.attributes('playsinline')).toBeDefined()
    expect(video.attributes('autoplay')).toBeDefined()
    expect(video.attributes('controls')).toBeUndefined()
    expect(el.controls).toBeFalsy()
    expect(video.attributes('disablepictureinpicture')).toBeDefined()
  })

  it('cannot take focus or a pointer event', () => {
    const video = mountView(fakeStream([fakeTrack()])).get('video')

    expect(video.attributes('tabindex')).toBe('-1')
    expect(video.classes()).toContain('pointer-events-none')
  })

  it('is mirrored by a CSS flip only', () => {
    const stream = fakeStream([fakeTrack()])
    const tracksBefore = stream.getTracks()
    const video = mountView(stream).get('video')

    expect(video.classes()).toContain('-scale-x-100')
    // The flip is display only: the stream is the very same object and its
    // tracks were neither replaced nor touched.
    expect((video.element as HTMLVideoElement).srcObject).toBe(stream)
    expect(stream.getTracks()).toBe(tracksBefore)
  })

  it('is named from interview.call.self_view and shows the You chip', () => {
    const wrapper = mountView(fakeStream([fakeTrack()]))

    expect(wrapper.get('video').attributes('aria-label')).toBe('interview.call.self_view')
    expect(wrapper.get('[data-slot="call-tile-name"]').text()).toContain('interview.call.you')
    expect(wrapper.find('[data-slot="self-view-off"]').exists()).toBe(false)
  })

  it('forwards the speaking state to the tile ring', () => {
    const wrapper = mountView(fakeStream([fakeTrack()]), {
      speaking: true,
      speakingLabel: 'You are speaking',
    })

    expect(wrapper.get('[data-slot="call-tile"]').attributes('data-speaking')).toBe('true')
    expect(wrapper.get('.sr-only').text()).toBe('You are speaking')
  })
})

describe('CallSelfView without a live video track', () => {
  it('shows a named placeholder instead of the video when the track has ended', () => {
    const wrapper = mountView(fakeStream([fakeTrack('ended')]))
    const placeholder = wrapper.get('[data-slot="self-view-off"]')

    expect(wrapper.find('video').exists()).toBe(false)
    expect(placeholder.attributes('role')).toBe('img')
    expect(placeholder.attributes('aria-label')).toBe('interview.call.self_view_off')
    expect(placeholder.classes()).toContain('pointer-events-none')
  })

  it('shows the placeholder for a stream with no video track at all', () => {
    const wrapper = mountView(fakeStream([]))

    expect(wrapper.find('video').exists()).toBe(false)
    expect(wrapper.find('[data-slot="self-view-off"]').exists()).toBe(true)
  })

  it('swaps the video for the placeholder when the track ends while mounted', async () => {
    const track = fakeTrack()
    const wrapper = mountView(fakeStream([track]))
    expect(wrapper.find('video').exists()).toBe(true)

    track.end()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('video').exists()).toBe(false)
    expect(wrapper.find('[data-slot="self-view-off"]').exists()).toBe(true)
  })
})

describe('CallSelfView when the stream is replaced', () => {
  it('plays the new stream and stops listening to the old tracks', async () => {
    const oldTrack = fakeTrack()
    const wrapper = mountView(fakeStream([oldTrack]))
    const next = fakeStream([fakeTrack()])

    await wrapper.setProps({ stream: next })
    expect((wrapper.get('video').element as HTMLVideoElement).srcObject).toBe(next)

    // The old stream's track ending is no longer this tile's business.
    oldTrack.end()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('video').exists()).toBe(true)
  })

  it('detaches the stream, without stopping it, on unmount', () => {
    const stream = fakeStream([fakeTrack()])
    const wrapper = mountView(stream)
    const el = wrapper.get('video').element as HTMLVideoElement

    wrapper.unmount()

    expect(el.srcObject).toBeNull()
    expect(stream.getVideoTracks()[0]!.readyState).toBe('live')
  })
})

describe('CallSelfView never asks for the camera', () => {
  it.each([
    ['a live stream', () => fakeStream([fakeTrack()])],
    ['an ended stream', () => fakeStream([fakeTrack('ended')])],
  ])('does not call getUserMedia with %s, nor when the stream changes', async (_n, make) => {
    spyOnGetUserMedia()
    const wrapper = mountView(make())

    await wrapper.setProps({ stream: fakeStream([fakeTrack()]) })
    await wrapper.setProps({ stream: fakeStream([fakeTrack('ended')]) })
    wrapper.unmount()

    expect(getUserMedia).not.toHaveBeenCalled()
  })
})
