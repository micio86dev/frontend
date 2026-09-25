/**
 * useNetworkGuard — unit tests (public-api SPEC §4.4, "network drop (reconnect
 * attempt, then fail with events persisted server-side)").
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  useNetworkGuard,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
} from '~/app/composables/useNetworkGuard'

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true })
}

function dispatchOffline(): void {
  setOnline(false)
  window.dispatchEvent(new Event('offline'))
}

function dispatchOnline(): void {
  setOnline(true)
  window.dispatchEvent(new Event('online'))
}

describe('useNetworkGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setOnline(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("mirrors useInterviewSession's own /start retry cadence by default", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(3)
    expect(DEFAULT_RETRY_DELAY_MS).toBe(3_000)
  })

  it('calls onOffline immediately when the browser goes offline while active', () => {
    const onOffline = vi.fn()
    const guard = useNetworkGuard({
      isActive: () => true,
      onOffline,
      onReconnected: vi.fn(),
      onFailed: vi.fn(),
    })
    guard.start()

    dispatchOffline()

    expect(onOffline).toHaveBeenCalledTimes(1)
  })

  it('does nothing when going offline while not active', () => {
    const onOffline = vi.fn()
    const onFailed = vi.fn()
    const guard = useNetworkGuard({
      isActive: () => false,
      onOffline,
      onReconnected: vi.fn(),
      onFailed,
    })
    guard.start()

    dispatchOffline()
    vi.advanceTimersByTime(20_000)

    expect(onOffline).not.toHaveBeenCalled()
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('calls onReconnected the moment the online event fires mid-retry', () => {
    const onReconnected = vi.fn()
    const onFailed = vi.fn()
    const guard = useNetworkGuard({
      isActive: () => true,
      onReconnected,
      onFailed,
      maxAttempts: 3,
      retryDelayMs: 1_000,
    })
    guard.start()

    dispatchOffline()
    vi.advanceTimersByTime(500)
    dispatchOnline()

    expect(onReconnected).toHaveBeenCalledTimes(1)
    expect(onFailed).not.toHaveBeenCalled()

    // No late onFailed after the reconnect already resolved it.
    vi.advanceTimersByTime(10_000)
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('calls onFailed once after maxAttempts reconnect windows elapse while still offline', () => {
    const onReconnected = vi.fn()
    const onFailed = vi.fn()
    const guard = useNetworkGuard({
      isActive: () => true,
      onReconnected,
      onFailed,
      maxAttempts: 3,
      retryDelayMs: 1_000,
    })
    guard.start()

    dispatchOffline()
    // 3 attempt windows of 1000ms each, still offline throughout.
    vi.advanceTimersByTime(3_000)

    expect(onFailed).toHaveBeenCalledTimes(1)
    expect(onReconnected).not.toHaveBeenCalled()
  })

  it('resolves via the attempt-window poll even if the online event never fires', () => {
    // Some browsers do not reliably fire `online` after every real drop —
    // the guard must still resolve once navigator.onLine reports true again.
    const onReconnected = vi.fn()
    const onFailed = vi.fn()
    const guard = useNetworkGuard({
      isActive: () => true,
      onReconnected,
      onFailed,
      maxAttempts: 3,
      retryDelayMs: 1_000,
    })
    guard.start()

    dispatchOffline()
    vi.advanceTimersByTime(500)
    setOnline(true) // no 'online' event dispatched
    vi.advanceTimersByTime(500) // first attempt window elapses

    expect(onReconnected).toHaveBeenCalledTimes(1)
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('fires onReconnected only once when the poll resolves first and an online event follows', () => {
    const onReconnected = vi.fn()
    const guard = useNetworkGuard({
      isActive: () => true,
      onReconnected,
      onFailed: vi.fn(),
      maxAttempts: 3,
      retryDelayMs: 1_000,
    })
    guard.start()

    dispatchOffline()
    setOnline(true)
    vi.advanceTimersByTime(1_000) // poll resolves the reconnect
    window.dispatchEvent(new Event('online')) // late event must be a no-op

    expect(onReconnected).toHaveBeenCalledTimes(1)
    guard.stop()
  })

  it('does not react to onFailed/onReconnected if the interview stopped being active', () => {
    let active = true
    const onFailed = vi.fn()
    const guard = useNetworkGuard({
      isActive: () => active,
      onReconnected: vi.fn(),
      onFailed,
      maxAttempts: 2,
      retryDelayMs: 1_000,
    })
    guard.start()

    dispatchOffline()
    active = false
    vi.advanceTimersByTime(2_000)

    expect(onFailed).not.toHaveBeenCalled()
  })

  it('stop() detaches listeners and clears a pending retry — no late onFailed', () => {
    const onFailed = vi.fn()
    const guard = useNetworkGuard({
      isActive: () => true,
      onReconnected: vi.fn(),
      onFailed,
      maxAttempts: 2,
      retryDelayMs: 1_000,
    })
    guard.start()

    dispatchOffline()
    guard.stop()
    vi.advanceTimersByTime(5_000)

    expect(onFailed).not.toHaveBeenCalled()
  })

  it('an online event with no prior offline episode is a no-op', () => {
    const onReconnected = vi.fn()
    const guard = useNetworkGuard({
      isActive: () => true,
      onReconnected,
      onFailed: vi.fn(),
    })
    guard.start()

    dispatchOnline()

    expect(onReconnected).not.toHaveBeenCalled()
  })
})
