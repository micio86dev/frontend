/**
 * useTabVisibilityGuard — unit tests (public-api SPEC §4.4, "tab hidden > 60 s").
 *
 * Pure browser-event composable — no Nuxt runtime, no mocks beyond fake timers
 * and `document.hidden`, which happy-dom lets us stub directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  useTabVisibilityGuard,
  DEFAULT_HIDDEN_TIMEOUT_MS,
} from '~/app/composables/useTabVisibilityGuard'

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useTabVisibilityGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setHidden(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('exposes the spec-pinned 60s default', () => {
    expect(DEFAULT_HIDDEN_TIMEOUT_MS).toBe(60_000)
  })

  it('fires onHiddenTimeout after the tab stays hidden for the full timeout while active', () => {
    const onHiddenTimeout = vi.fn()
    const guard = useTabVisibilityGuard({ isActive: () => true, onHiddenTimeout, timeoutMs: 1_000 })
    guard.start()

    setHidden(true)
    vi.advanceTimersByTime(999)
    expect(onHiddenTimeout).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onHiddenTimeout).toHaveBeenCalledTimes(1)
  })

  it('cancels silently when the tab becomes visible again before the timeout', () => {
    const onHiddenTimeout = vi.fn()
    const guard = useTabVisibilityGuard({ isActive: () => true, onHiddenTimeout, timeoutMs: 1_000 })
    guard.start()

    setHidden(true)
    vi.advanceTimersByTime(500)
    setHidden(false)
    vi.advanceTimersByTime(1_000)

    expect(onHiddenTimeout).not.toHaveBeenCalled()
  })

  it('never starts a timer while isActive() is false', () => {
    const onHiddenTimeout = vi.fn()
    const guard = useTabVisibilityGuard({
      isActive: () => false,
      onHiddenTimeout,
      timeoutMs: 1_000,
    })
    guard.start()

    setHidden(true)
    vi.advanceTimersByTime(5_000)

    expect(onHiddenTimeout).not.toHaveBeenCalled()
  })

  it('does not fire if the interview stopped being active exactly when the timer elapses', () => {
    let active = true
    const onHiddenTimeout = vi.fn()
    const guard = useTabVisibilityGuard({
      isActive: () => active,
      onHiddenTimeout,
      timeoutMs: 1_000,
    })
    guard.start()

    setHidden(true)
    active = false // e.g. the candidate reached `done` while the tab was hidden
    vi.advanceTimersByTime(1_000)

    expect(onHiddenTimeout).not.toHaveBeenCalled()
  })

  it('stop() detaches the listener — a later hide event does nothing', () => {
    const onHiddenTimeout = vi.fn()
    const guard = useTabVisibilityGuard({ isActive: () => true, onHiddenTimeout, timeoutMs: 1_000 })
    guard.start()
    guard.stop()

    setHidden(true)
    vi.advanceTimersByTime(2_000)

    expect(onHiddenTimeout).not.toHaveBeenCalled()
  })

  it('stop() clears a pending timer — no late fire after teardown', () => {
    const onHiddenTimeout = vi.fn()
    const guard = useTabVisibilityGuard({ isActive: () => true, onHiddenTimeout, timeoutMs: 1_000 })
    guard.start()

    setHidden(true)
    vi.advanceTimersByTime(500)
    guard.stop()
    vi.advanceTimersByTime(1_000)

    expect(onHiddenTimeout).not.toHaveBeenCalled()
  })

  it('calling start() twice does not attach a second listener (no double-fire)', () => {
    const onHiddenTimeout = vi.fn()
    const guard = useTabVisibilityGuard({ isActive: () => true, onHiddenTimeout, timeoutMs: 1_000 })
    guard.start()
    guard.start()

    setHidden(true)
    vi.advanceTimersByTime(1_000)

    expect(onHiddenTimeout).toHaveBeenCalledTimes(1)
  })
})
