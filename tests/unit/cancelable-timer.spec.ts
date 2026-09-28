/**
 * TDD RED → GREEN — extracted from `useInterviewSession()`'s three near-identical
 * timer-management triples (handoverBoundTimer, promoteTimer, connectingCeilingTimer —
 * each a `let ... | null` plus a manual clear-then-setTimeout pair). Pure, no Vue
 * reactivity involved — these are imperative timer handles, never rendered.
 *
 * Coverage target: ~95% (small, correctness-relevant pure unit — a bug here would
 * silently break the handover bound/ceiling timers the interview state machine
 * depends on for its retryable-error fallback).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createCancelableTimer } from '../../app/utils/cancelable-timer'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createCancelableTimer', () => {
  it('runs the scheduled callback after the given delay', () => {
    const timer = createCancelableTimer()
    const fn = vi.fn()

    timer.arm(fn, 1000)
    expect(fn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(999)
    expect(fn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('clear() before the delay elapses cancels the callback', () => {
    const timer = createCancelableTimer()
    const fn = vi.fn()

    timer.arm(fn, 1000)
    timer.clear()
    vi.advanceTimersByTime(2000)

    expect(fn).not.toHaveBeenCalled()
  })

  it('clear() on a never-armed timer is a safe no-op', () => {
    const timer = createCancelableTimer()
    expect(() => timer.clear()).not.toThrow()
  })

  it('clear() after the callback already fired is a safe no-op', () => {
    const timer = createCancelableTimer()
    const fn = vi.fn()

    timer.arm(fn, 1000)
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledOnce()

    expect(() => timer.clear()).not.toThrow()
  })

  it('a second arm() before the first fires cancels the first — only the second callback runs', () => {
    const timer = createCancelableTimer()
    const first = vi.fn()
    const second = vi.fn()

    timer.arm(first, 1000)
    timer.arm(second, 1000)
    vi.advanceTimersByTime(1000)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })

  it('arm() after the previous callback already fired schedules a fresh one', () => {
    const timer = createCancelableTimer()
    const fn = vi.fn()

    timer.arm(fn, 1000)
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledOnce()

    timer.arm(fn, 1000)
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('clearing inside the callback itself is a safe no-op (handle already nulled before invocation)', () => {
    const timer = createCancelableTimer()
    const fn = vi.fn(() => timer.clear())

    timer.arm(fn, 1000)
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    expect(fn).toHaveBeenCalledOnce()
  })
})
