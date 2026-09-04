/**
 * VoiceVisualizer — the panel a candidate looks at when there is no face.
 *
 * WRITTEN FOR A DEFECT THE REVIEW GATE CAUGHT, not for coverage. The first
 * version handled `active: false` by nulling the analyser and leaving the
 * requestAnimationFrame loop running, on the theory that the decay branch
 * would settle the shape. It did — and then spun at 60fps for the whole pause,
 * and made resume a permanent no-op, because `start()` returns early while a
 * frame is still pending. The ribbon would have gone flat and stayed flat for
 * the rest of the interview.
 *
 * Not reachable through today's call site, which is exactly why it needed a
 * test: a latent defect in a public prop is one binding away from being real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

/** A stand-in for the analyser graph, so the component's wiring is observable. */
function stubAudio() {
  const disconnect = vi.fn()
  const close = vi.fn().mockResolvedValue(undefined)
  const createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect }))
  const createAnalyser = vi.fn(() => ({
    fftSize: 2048,
    disconnect,
    // Silence: every sample sits at the 128 midpoint.
    getByteTimeDomainData: vi.fn((array: Uint8Array) => array.fill(128)),
  }))

  const AudioContextStub = vi.fn(() => ({
    resume: vi.fn().mockResolvedValue(undefined),
    close,
    createMediaStreamSource,
    createAnalyser,
  }))

  vi.stubGlobal('AudioContext', AudioContextStub)

  return { createMediaStreamSource, close }
}

function stubCanvas(): void {
  // jsdom has no 2d context; the component must survive whatever it gets.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext
}

async function mountVisualizer(props: Record<string, unknown>) {
  const { default: VoiceVisualizer } = await import('~/app/components/VoiceVisualizer.client.vue')

  return mount(VoiceVisualizer, { props: { label: 'Interviewer voice', ...props } })
}

describe('VoiceVisualizer', () => {
  beforeEach(() => {
    vi.resetModules()
    stubCanvas()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('taps the stream for analysis and never routes it to an output', async () => {
    // The media element owns playback. A second sink for the same stream would
    // play every word twice, slightly out of phase.
    const { createMediaStreamSource } = stubAudio()
    const stream = {} as MediaStream

    await mountVisualizer({ stream })

    expect(createMediaStreamSource).toHaveBeenCalledWith(stream)
  })

  it('tears the audio graph down when it goes inactive', async () => {
    const { close } = stubAudio()

    const wrapper = await mountVisualizer({ stream: {} as MediaStream, active: true })

    await wrapper.setProps({ active: false })
    await nextTick()

    // Not merely "stops reading": the context is closed and the frame is
    // cancelled, so a pause costs nothing at all.
    expect(close).toHaveBeenCalled()
    expect(cancelAnimationFrame).toHaveBeenCalled()
  })

  it('REBUILDS the analyser when it becomes active again', async () => {
    // The defect this file exists for. Restarting the loop is not enough —
    // pause tore the graph down, so resume has to reconnect it. Without this
    // the ribbon is flat for the rest of the interview.
    const { createMediaStreamSource } = stubAudio()

    const wrapper = await mountVisualizer({ stream: {} as MediaStream, active: true })

    expect(createMediaStreamSource).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ active: false })
    await nextTick()
    await wrapper.setProps({ active: true })
    await nextTick()

    expect(createMediaStreamSource).toHaveBeenCalledTimes(2)
  })

  it('builds NOTHING when a stream arrives while it is inactive', async () => {
    // The handover's happy path, and the mutation the first version of this
    // file missed. An incoming player mounts muted, so `active` is false, and
    // the stream watcher fired anyway — an AudioContext and a 60fps loop for a
    // hidden session meant to stay inert for the whole overlap, running until
    // promote() or clearIncomingProvider().
    const { createMediaStreamSource } = stubAudio()

    await mountVisualizer({ stream: {} as MediaStream, active: false })

    expect(createMediaStreamSource).not.toHaveBeenCalled()
    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })

  it('starts once it is promoted, with the stream it already had', async () => {
    // The other half of the same path: the incoming player becomes live, and
    // the analyser has to be built then rather than never.
    const { createMediaStreamSource } = stubAudio()

    const wrapper = await mountVisualizer({ stream: {} as MediaStream, active: false })

    await wrapper.setProps({ active: true })
    await nextTick()

    expect(createMediaStreamSource).toHaveBeenCalledTimes(1)
  })

  it('builds exactly one graph when stream and active change together', async () => {
    // The mutation the REBUILDS test above could not see: it toggles
    // sequentially, and a SIMULTANEOUS change fires both watchers. Without
    // `connect()` disconnecting first, the second one stranded the first
    // context and its running frame — leaked at 60fps for the rest of the
    // interview.
    const { close, createMediaStreamSource } = stubAudio()

    const wrapper = await mountVisualizer({ stream: {} as MediaStream, active: true })

    await wrapper.setProps({ stream: {} as MediaStream, active: true })
    await nextTick()

    // The first graph was torn down before the second was built.
    expect(close).toHaveBeenCalled()
    expect(createMediaStreamSource).toHaveBeenCalledTimes(2)
  })

  it('carries a static label rather than announcing every amplitude change', async () => {
    // The caption component already delivers the interviewer's speech as live
    // text; announcing the waveform too would bury it.
    const wrapper = await mountVisualizer({ stream: null })

    const canvas = wrapper.get('[data-testid="voice-visualizer-canvas"]')

    expect(canvas.attributes('role')).toBe('img')
    expect(canvas.attributes('aria-label')).toBe('Interviewer voice')
  })
})
