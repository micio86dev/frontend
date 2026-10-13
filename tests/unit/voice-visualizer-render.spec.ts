/**
 * VoiceVisualizer — what actually reaches the canvas.
 *
 * voice-visualizer.spec.ts proves the audio graph wiring. This file proves the
 * other half: that the ribbon follows the signal, settles when the audio stops,
 * repaints on a slow timer under reduced motion, reads its colours from the
 * stylesheet, and keeps its backing store in step with the device.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

const WIDTH = 300
const HEIGHT = 100
const CENTRE = HEIGHT / 2

interface Ctx {
  moveTo: ReturnType<typeof vi.fn>
  lineTo: ReturnType<typeof vi.fn>
  quadraticCurveTo: ReturnType<typeof vi.fn>
  fill: ReturnType<typeof vi.fn>
  stroke: ReturnType<typeof vi.fn>
  clearRect: ReturnType<typeof vi.fn>
  addColorStop: ReturnType<typeof vi.fn>
  strokeStyle: string
}

let ctx: Ctx
let sample: number
let frames: FrameRequestCallback[]
let observerCallback: () => void

function makeCtx(): Ctx {
  const addColorStop = vi.fn()
  return {
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    clearRect: vi.fn(),
    addColorStop,
    strokeStyle: '',
    // beginPath/closePath/createLinearGradient are plain pass-throughs
    ...({
      beginPath: vi.fn(),
      closePath: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop })),
    } as object),
  } as Ctx
}

function stubAudio(): { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal(
    'AudioContext',
    vi.fn(() => ({
      resume: vi.fn().mockResolvedValue(undefined),
      close,
      createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
      createAnalyser: () => ({
        fftSize: 2048,
        disconnect: vi.fn(),
        getByteTimeDomainData: (a: Uint8Array) => a.fill(sample),
      }),
    }))
  )
  return { close }
}

async function mountVisualizer(props: Record<string, unknown>) {
  const { default: VoiceVisualizer } = await import('~/app/components/VoiceVisualizer.client.vue')
  return mount(VoiceVisualizer, { props: { label: 'Voice', ...props } })
}

/** The y of the ribbon's first point: the path's second moveTo (the first is the hairline). */
const ribbonTop = () => ctx.moveTo.mock.calls[1]![1] as number

function runFrame(): void {
  const cb = frames.shift()!
  cb(0)
}

describe('VoiceVisualizer rendering', () => {
  beforeEach(() => {
    vi.resetModules()
    sample = 128
    frames = []
    ctx = makeCtx()
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => ctx
    ) as unknown as typeof HTMLCanvasElement.prototype.getContext
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: WIDTH,
      height: HEIGHT,
    } as DOMRect)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observerCallback = cb
        }
        observe() {}
        disconnect() {}
      }
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('sizes the backing store to the device pixels and repaints when the element resizes', async () => {
    stubAudio()
    vi.stubGlobal('devicePixelRatio', 2)
    const wrapper = await mountVisualizer({ stream: null })
    const canvas = wrapper.get('canvas').element as HTMLCanvasElement
    await nextTick()

    expect([canvas.width, canvas.height]).toEqual([WIDTH * 2, HEIGHT * 2])

    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 40 } as DOMRect)
    ctx.clearRect.mockClear()
    observerCallback()

    expect([canvas.width, canvas.height]).toEqual([200, 80])
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 200, 80)
  })

  it('never lets the backing store collapse to zero pixels', async () => {
    stubAudio()
    vi.mocked(HTMLCanvasElement.prototype.getBoundingClientRect).mockReturnValue({
      width: 0,
      height: 0,
    } as DOMRect)
    const wrapper = await mountVisualizer({ stream: null })
    const canvas = wrapper.get('canvas').element as HTMLCanvasElement
    await nextTick()

    expect([canvas.width, canvas.height]).toEqual([1, 1])
  })

  it('draws a resting hairline even with no stream and no animation loop', async () => {
    stubAudio()
    await mountVisualizer({ stream: null })
    await nextTick()

    expect(ctx.stroke).toHaveBeenCalled()
    expect(ctx.moveTo).toHaveBeenCalledWith(0, CENTRE)
    expect(ctx.lineTo).toHaveBeenCalledWith(WIDTH, CENTRE)
    expect(frames).toHaveLength(0)
  })

  it('does not start a loop for an active visualizer that has no stream yet', async () => {
    stubAudio()
    const wrapper = await mountVisualizer({ stream: null, active: false })
    await nextTick()
    ctx.clearRect.mockClear()

    await wrapper.setProps({ active: true })

    expect(frames).toHaveLength(0)
    expect(ctx.clearRect).toHaveBeenCalledTimes(1)
  })

  it('widens the ribbon with a louder signal and keeps animating frame after frame', async () => {
    stubAudio()
    await mountVisualizer({ stream: {} as MediaStream })
    await nextTick()

    runFrame()
    const silentTop = ribbonTop()
    expect(frames).toHaveLength(1)

    ctx.moveTo.mockClear()
    sample = 255
    runFrame()
    const loudTop = ribbonTop()

    expect(loudTop).toBeLessThan(silentTop)
    expect(loudTop).toBeGreaterThanOrEqual(CENTRE - (HEIGHT / 2) * 0.78)
    expect(ctx.fill).toHaveBeenCalled()
    expect(frames).toHaveLength(1)
  })

  it('settles to the resting shape when paused instead of freezing mid-word', async () => {
    stubAudio()
    const wrapper = await mountVisualizer({ stream: {} as MediaStream })
    await nextTick()
    runFrame()
    const silentTop = ribbonTop()

    sample = 255
    for (let i = 0; i < 10; i += 1) runFrame()
    ctx.moveTo.mockClear()

    await wrapper.setProps({ active: false })

    expect(ribbonTop()).toBe(silentTop)
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalled()
  })

  it('zeroes the ribbon when the stream goes away', async () => {
    stubAudio()
    const wrapper = await mountVisualizer({ stream: {} as MediaStream })
    await nextTick()
    runFrame()
    const silentTop = ribbonTop()
    sample = 255
    for (let i = 0; i < 10; i += 1) runFrame()
    ctx.moveTo.mockClear()

    await wrapper.setProps({ stream: null })

    expect(ribbonTop()).toBe(silentTop)
  })

  it('falls back to the prefixed AudioContext, and survives having none at all', async () => {
    const { close } = stubAudio()
    const Ctor = (window as unknown as { AudioContext: unknown }).AudioContext
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', Ctor)
    const prefixed = await mountVisualizer({ stream: {} as MediaStream })
    await nextTick()
    expect(Ctor).toHaveBeenCalledTimes(1)
    prefixed.unmount()
    expect(close).toHaveBeenCalled()

    vi.resetModules()
    vi.stubGlobal('webkitAudioContext', undefined)
    frames = []
    const bare = await mountVisualizer({ stream: {} as MediaStream })
    await nextTick()
    // No analyser can exist, but the panel still starts and rests on the hairline.
    expect(() => frames.length && runFrame()).not.toThrow()
    expect(ctx.stroke).toHaveBeenCalled()
    bare.unmount()
  })

  it('paints the ribbon with the brand colours read from the stylesheet', async () => {
    stubAudio()
    const tokens: Record<string, string> = {
      '--color-lavender': ' #112233 ',
      '--color-primary-light': '#445566',
    }
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (t: string) => tokens[t] ?? '',
    } as CSSStyleDeclaration)

    await mountVisualizer({ stream: null })
    await nextTick()

    expect(ctx.addColorStop.mock.calls).toEqual([
      [0, '#445566'],
      [0.5, '#112233'],
      [1, '#445566'],
    ])
  })

  it('falls back to the DESIGN.md colours when the tokens do not resolve', async () => {
    stubAudio()
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration)

    await mountVisualizer({ stream: null })
    await nextTick()

    expect(ctx.addColorStop.mock.calls).toEqual([
      [0, '#c222d3'],
      [0.5, '#8373d2'],
      [1, '#c222d3'],
    ])
  })

  it('stops observing and releases the audio graph on unmount', async () => {
    const { close } = stubAudio()
    const disconnect = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect = disconnect
      }
    )
    const wrapper = await mountVisualizer({ stream: {} as MediaStream })
    await nextTick()

    wrapper.unmount()

    expect(disconnect).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  describe('under prefers-reduced-motion', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.stubGlobal(
        'matchMedia',
        vi.fn(() => ({ matches: true }))
      )
    })
    afterEach(() => vi.useRealTimers())

    it('repaints four times a second on a timer and never starts the animation loop', async () => {
      stubAudio()
      const wrapper = await mountVisualizer({ stream: {} as MediaStream })
      await nextTick()
      expect(frames).toHaveLength(0)

      ctx.clearRect.mockClear()
      vi.advanceTimersByTime(1000)
      expect(ctx.clearRect).toHaveBeenCalledTimes(4)

      wrapper.unmount()
      ctx.clearRect.mockClear()
      vi.advanceTimersByTime(1000)
      expect(ctx.clearRect).not.toHaveBeenCalled()
    })

    it('still reflects the signal, so speaking stays distinguishable from silence', async () => {
      stubAudio()
      await mountVisualizer({ stream: {} as MediaStream })
      await nextTick()
      vi.advanceTimersByTime(250)
      const silentTop = ribbonTop()

      sample = 255
      ctx.moveTo.mockClear()
      vi.advanceTimersByTime(250)

      expect(ribbonTop()).toBeLessThan(silentTop)
    })
  })
})
