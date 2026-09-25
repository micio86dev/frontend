/**
 * useTabVisibilityGuard — tab-hidden > 60s pause + warn (public-api SPEC §4.4).
 *
 * SPEC.md §4.4 (Embed SDK — `/embed/{token}`): "tab hidden > 60 s (pause & warn)".
 * Used by `InterviewSession.vue` (the shared component both the hosted
 * `/interview/session` page and the embed `/embed/{token}` page render — see
 * SPEC §4.4 "Reuses the hosted page component"), NOT embed-only: the candidate
 * can background the tab in either mode.
 *
 * DELIBERATELY SEPARATE from `useProctor`'s own `visibilitychange` listener.
 * `useProctor` reports `tab_hidden` as a PROCTORING SIGNAL (an integrity event
 * fed into the risk summary) — it does not pause anything and has no timeout.
 * This composable does the opposite: it never reports an integrity event, and
 * exists SOLELY to stop the interview (and warn the candidate) once the tab has
 * been hidden long enough that a provider session left running would be
 * pointless (nobody watching) and billed for nothing. Both listen to the SAME
 * browser event independently, by design — they answer different questions and
 * must not be merged into one handler.
 *
 * SSR-safe: `document` is read only inside `start()`, guarded by a
 * `typeof document === 'undefined'` check; nothing touches a browser global at
 * module scope. Callers only ever invoke `start()` from client-side code
 * anyway (this composable is used from `InterviewSession.vue`, which is
 * itself gated `ssr: false`), matching the same convention `useProctor`'s own
 * `start()`/`stop()` already use.
 *
 * No lifecycle hooks of its own (unlike some composables in this codebase) —
 * `start()`/`stop()` are plain functions the caller invokes from its own
 * `onMounted`/`onUnmounted`, which keeps this composable callable from a plain
 * Vitest test with no active component instance.
 */

/** SPEC.md §4.4 — "tab hidden > 60 s". */
export const DEFAULT_HIDDEN_TIMEOUT_MS = 60_000

export interface UseTabVisibilityGuardOptions {
  /**
   * Whether the interview is currently in a state worth pausing — e.g. `live`.
   * Read at the moment the tab is hidden AND again when the timer fires (the
   * state may have changed — a candidate who reached `done` while the tab was
   * hidden must not be "paused" retroactively).
   */
  isActive: () => boolean
  /** Called once, when the tab has been hidden for `timeoutMs` while `isActive()` was true. */
  onHiddenTimeout: () => void
  /** Default `DEFAULT_HIDDEN_TIMEOUT_MS` (SPEC-pinned 60s) — overridable only for tests. */
  timeoutMs?: number
}

export interface UseTabVisibilityGuardReturn {
  /** Attaches the `visibilitychange` listener. No-op outside the browser or if already started. */
  start: () => void
  /** Detaches the listener and clears any pending timer. Safe to call repeatedly. */
  stop: () => void
}

export function useTabVisibilityGuard(
  options: UseTabVisibilityGuardOptions
): UseTabVisibilityGuardReturn {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HIDDEN_TIMEOUT_MS

  let listening = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let onVisibilityChange: (() => void) | null = null

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function handleVisibilityChange(): void {
    if (document.hidden) {
      if (!options.isActive()) return
      clearTimer() // defensive — a stray second `hidden` transition must not stack timers
      timer = setTimeout(() => {
        timer = null
        if (options.isActive()) {
          options.onHiddenTimeout()
        }
      }, timeoutMs)
    } else {
      // Back before the timeout — cancel silently, no warning, no pause.
      clearTimer()
    }
  }

  function start(): void {
    if (listening || typeof document === 'undefined') return
    listening = true
    onVisibilityChange = handleVisibilityChange
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  function stop(): void {
    clearTimer()
    if (onVisibilityChange && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    onVisibilityChange = null
    listening = false
  }

  return { start, stop }
}
