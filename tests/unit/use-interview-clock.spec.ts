/**
 * useInterviewClock — whole seconds of LIVE time (candidate-interview-call-ui,
 * UI-06; design D7).
 *
 * Two contracts carry this composable:
 *   - it counts only while `isRunning()` is true, so a suspension of any length
 *     is invisible to the figure the candidate reads;
 *   - it is built on TIMESTAMPS, not on counting interval ticks, so a throttled
 *     background tab (one tick delivered late, or not at all) does not lose time.
 *
 * Time is faked twice on purpose: `now` is injected (a number the test moves),
 * and the interval is faked by Vitest. Moving `now` WITHOUT firing the interval
 * is the "skipped interval" case; firing it once after a long jump is the
 * "throttled tab" case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { formatClock, useInterviewClock } from '~/app/composables/useInterviewClock'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function harness(startRunning = true) {
  const running = ref(startRunning)
  let now = 1_000_000
  const scope = effectScope()
  const clock = scope.run(() =>
    useInterviewClock({ isRunning: () => running.value, now: () => now })
  )!

  /** Moves the injected clock AND lets the faked interval fire as the real one would. */
  function advance(ms: number): void {
    now += ms
    vi.advanceTimersByTime(ms)
  }

  /** Moves the injected clock only: the interval is skipped entirely. */
  function skip(ms: number): void {
    now += ms
  }

  return { running, scope, clock, advance, skip }
}

describe('useInterviewClock — counting', () => {
  it('starts at zero', () => {
    const h = harness()

    expect(h.clock.elapsed.value).toBe(0)
  })

  it('counts whole seconds while running', () => {
    const h = harness()

    h.advance(3000)

    expect(h.clock.elapsed.value).toBe(3)
  })

  it('floors to whole seconds, keeping the fraction for the next one', () => {
    const h = harness()

    h.advance(2500)
    expect(h.clock.elapsed.value).toBe(2)

    h.advance(500)
    expect(h.clock.elapsed.value).toBe(3)
  })

  it('never counts when it starts paused', () => {
    const h = harness(false)

    h.advance(60_000)

    expect(h.clock.elapsed.value).toBe(0)
  })

  it('arms no timer at all while not running', () => {
    const h = harness(false)

    expect(vi.getTimerCount()).toBe(0)
    h.scope.stop()
  })
})

describe('useInterviewClock — pause and resume', () => {
  it('does not count while paused, and the figure is unchanged across the pause', () => {
    const h = harness()
    h.advance(3200)
    expect(h.clock.elapsed.value).toBe(3)

    h.running.value = false
    h.advance(10 * 60_000)

    expect(h.clock.elapsed.value).toBe(3)
  })

  it('resumes from where it stopped, keeping the sub-second remainder', () => {
    const h = harness()
    h.advance(3200)
    h.running.value = false
    h.advance(10 * 60_000)

    // 800 ms after the resume the 3.2 s carried over make exactly 4.0 s. The
    // figure is read at the next transition (the interval has not ticked yet).
    h.running.value = true
    h.advance(800)
    h.running.value = false

    expect(h.clock.elapsed.value).toBe(4)
  })

  it('does not count the unobserved gap of a pause that no interval tick fell inside', () => {
    const h = harness()
    h.advance(1000)

    // Paused and resumed with no tick in between: the pause is still excluded
    // because the transition itself is sampled, not only the interval.
    h.running.value = false
    h.skip(5 * 60_000)
    h.running.value = true
    h.advance(1000)

    expect(h.clock.elapsed.value).toBe(2)
  })

  it('does not tick the timer while paused', () => {
    const h = harness()
    h.running.value = false

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('useInterviewClock — timestamp based', () => {
  it('loses no time when the interval is delivered once, late', () => {
    const h = harness()

    // A background tab throttled for 10 s: ONE tick arrives, carrying 10 s.
    h.skip(10_000)
    vi.advanceTimersByTime(1000)

    expect(h.clock.elapsed.value).toBe(10)
  })

  it('loses no time when the interval is not delivered at all before the next transition', () => {
    const h = harness()

    h.skip(7000)
    h.running.value = false

    expect(h.clock.elapsed.value).toBe(7)
  })
})

describe('useInterviewClock — lifecycle', () => {
  it('clears its timer when the scope stops', () => {
    const h = harness()
    expect(vi.getTimerCount()).toBe(1)

    h.scope.stop()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('stop() clears the timer and freezes the figure', () => {
    const h = harness()
    h.advance(2000)

    h.clock.stop()
    h.advance(5000)

    expect(vi.getTimerCount()).toBe(0)
    expect(h.clock.elapsed.value).toBe(2)
  })
})

describe('useInterviewClock — without an active effect scope', () => {
  it('does not throw, still counts, and stop() releases its timer', () => {
    let now = 1_000_000
    const running = ref(true)

    const clock = useInterviewClock({ isRunning: () => running.value, now: () => now })
    expect(vi.getTimerCount()).toBe(1)

    now += 3000
    vi.advanceTimersByTime(3000)
    expect(clock.elapsed.value).toBe(3)

    clock.stop()

    expect(vi.getTimerCount()).toBe(0)
    now += 5000
    vi.advanceTimersByTime(5000)
    expect(clock.elapsed.value).toBe(3)
  })
})

describe('formatClock', () => {
  it.each([
    [0, '00:00'],
    [5, '00:05'],
    [192, '03:12'],
    [300, '05:00'],
    [1500, '25:00'],
    [3600, '60:00'],
    [5400, '90:00'],
    [6000, '100:00'],
  ])('formats %i s as %s, never wrapping minutes at 60', (seconds, expected) => {
    expect(formatClock(seconds)).toBe(expected)
  })

  it.each([-5, Number.NaN, Number.POSITIVE_INFINITY])('clamps %s to 00:00', (seconds) => {
    expect(formatClock(seconds)).toBe('00:00')
  })

  it('drops a fraction rather than rounding it up', () => {
    expect(formatClock(59.9)).toBe('00:59')
  })
})
