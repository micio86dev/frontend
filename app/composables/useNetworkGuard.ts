/**
 * useNetworkGuard — network-drop reconnect-then-fail (public-api SPEC §4.4).
 *
 * SPEC.md §4.4: "network drop (reconnect attempt, then fail with events
 * persisted server-side)". Used by `InterviewSession.vue` (shared between the
 * hosted `/interview/session` page and the embed `/embed/{token}` page), not
 * embed-only — a dropped connection is exactly as real in either mode.
 *
 * Mirrors the EXISTING retry shape `useInterviewSession`'s own `/start` 429
 * handling already uses (`MAX_ATTEMPTS = 3`, `RETRY_DELAY_MS = 3000`) rather
 * than inventing a new cadence — see that composable's own constants. This
 * composable does not import or modify `useInterviewSession`; it only tells
 * its caller (`InterviewSession.vue`) when to call the EXISTING `resume()` /
 * `pause()` it already exposes — the "existing resume/reconnect method" this
 * guard is required to reuse rather than inventing a new one.
 *
 * "events persisted server-side": investigated and NOT reused here — the only
 * client-persisted event channel (`POST /candidate/interview/integrity`) is
 * bound to a FROZEN, server-validated 13-value enum (`INTEGRITY_KINDS` in
 * `app/utils/proctor-config.ts`) that has no "network drop" member and is
 * scored as a proctoring signal about the CANDIDATE — forcing a network event
 * through it would misrepresent a connectivity failure as candidate behaviour
 * and could fail server-side validation outright. A failed automatic
 * `resume()` already reaches `useInterviewSession`'s existing, real `/start`
 * call, so the failure IS observed server-side through that call's own
 * request, without this composable inventing a second, mismatched persistence
 * path. See this feature's report for the full judgment call.
 *
 * SSR-safe: `window`/`navigator` are read only inside `start()`, guarded by a
 * `typeof window === 'undefined'` check — the same convention `useProctor`'s
 * own `start()`/`stop()` already use; callers only ever invoke `start()` from
 * client-side code (this composable is used from `InterviewSession.vue`,
 * itself gated `ssr: false`).
 */

/** Matches `useInterviewSession`'s own `MAX_ATTEMPTS` for `/start` 429 retries. */
export const DEFAULT_MAX_ATTEMPTS = 3

/** Matches `useInterviewSession`'s own `RETRY_DELAY_MS` for `/start` 429 retries. */
export const DEFAULT_RETRY_DELAY_MS = 3_000

export interface UseNetworkGuardOptions {
  /** Whether the interview is currently in a state worth reconnecting — e.g. `live`/`paused`. */
  isActive: () => boolean
  /**
   * Called once per `offline` episode, immediately, so the caller can stop a
   * live provider session before it burns minutes talking to nobody.
   */
  onOffline?: () => void
  /** Called once the browser reports `online` again, before attempts are exhausted. */
  onReconnected: () => void
  /** Called once, after `maxAttempts` reconnect windows elapse while still offline. */
  onFailed: () => void
  maxAttempts?: number
  retryDelayMs?: number
}

export interface UseNetworkGuardReturn {
  start: () => void
  stop: () => void
}

export function useNetworkGuard(options: UseNetworkGuardOptions): UseNetworkGuardReturn {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS

  let listening = false
  let attemptTimer: ReturnType<typeof setTimeout> | null = null
  let attemptsRemaining = 0
  let onOfflineBound: (() => void) | null = null
  let onOnlineBound: (() => void) | null = null

  function clearAttemptTimer(): void {
    if (attemptTimer !== null) {
      clearTimeout(attemptTimer)
      attemptTimer = null
    }
  }

  function scheduleAttempt(): void {
    clearAttemptTimer()
    attemptTimer = setTimeout(() => {
      attemptTimer = null
      if (!options.isActive()) return

      if (typeof navigator !== 'undefined' && navigator.onLine) {
        // The browser already says we're back — handleOnline() will also fire
        // (or already has), but resolving here too covers environments where
        // the 'online' event is unreliable (some browsers never fire it after
        // a real network-level drop, only after airplane-mode-style toggles).
        attemptsRemaining = 0
        options.onReconnected()
        return
      }

      attemptsRemaining -= 1
      if (attemptsRemaining <= 0) {
        options.onFailed()
        return
      }
      scheduleAttempt()
    }, retryDelayMs)
  }

  function handleOffline(): void {
    if (!options.isActive()) return
    clearAttemptTimer()
    attemptsRemaining = maxAttempts
    options.onOffline?.()
    scheduleAttempt()
  }

  function handleOnline(): void {
    if (attemptTimer === null && attemptsRemaining <= 0) return // no reconnect was in flight
    clearAttemptTimer()
    attemptsRemaining = 0
    options.onReconnected()
  }

  function start(): void {
    if (listening || typeof window === 'undefined') return
    listening = true
    onOfflineBound = handleOffline
    onOnlineBound = handleOnline
    window.addEventListener('offline', onOfflineBound)
    window.addEventListener('online', onOnlineBound)
  }

  function stop(): void {
    clearAttemptTimer()
    attemptsRemaining = 0
    if (typeof window !== 'undefined') {
      if (onOfflineBound) window.removeEventListener('offline', onOfflineBound)
      if (onOnlineBound) window.removeEventListener('online', onOnlineBound)
    }
    onOfflineBound = null
    onOnlineBound = null
    listening = false
  }

  return { start, stop }
}
