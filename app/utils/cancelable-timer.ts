/**
 * createCancelableTimer — a single-slot, cancel-safe `setTimeout` wrapper.
 *
 * Extracted from `useInterviewSession()`, which repeated this exact pattern three
 * times (`handoverBoundTimer`, `promoteTimer`, `connectingCeilingTimer`: each a
 * module-scope `let ... | null`, a manual `clear...Timer()` function, and an `arm...()`
 * that cleared-then-`setTimeout`'d). Pure and stateless-to-the-caller — no Vue
 * reactivity, since these are imperative timer handles, never rendered — so it lives
 * in `app/utils`, not `app/composables`.
 *
 * `arm()` is atomic: it cancels any pending call before scheduling the new one, so a
 * caller never needs a separate `clear()` before re-arming (the interview handover's
 * bound/ceiling timers rely on exactly this — see their own comments).
 */
export interface CancelableTimer {
  /** Cancels any pending call, then schedules `fn` to run after `ms`. */
  arm(fn: () => void, ms: number): void
  /** Cancels any pending call. Safe to call with nothing pending, or after it already fired. */
  clear(): void
}

export function createCancelableTimer(): CancelableTimer {
  let handle: ReturnType<typeof setTimeout> | null = null

  return {
    arm(fn: () => void, ms: number): void {
      if (handle !== null) {
        clearTimeout(handle)
      }
      handle = setTimeout(() => {
        // Nulled BEFORE invocation: a clear() called from inside fn() itself
        // (or reached via a callback it triggers) must be a safe no-op, not
        // a clearTimeout() on an id Node/the browser has already fired.
        handle = null
        fn()
      }, ms)
    },
    clear(): void {
      if (handle !== null) {
        clearTimeout(handle)
        handle = null
      }
    },
  }
}
