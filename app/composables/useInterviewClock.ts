/**
 * useInterviewClock.ts — whole seconds of LIVE interview time.
 *
 * candidate-interview-call-ui, design D7. The side panel shows "03:12 / 25:00":
 * the left figure is this clock. It counts only while `isRunning()` is true (the
 * session is `live`), so a suspension of any length leaves it where it was and a
 * resume continues from there.
 *
 * TIMESTAMPS, NOT TICKS. The interval is only a prompt to look at the clock; the
 * figure is the sum of `now()` differences, so a background tab whose timer is
 * throttled to once a minute (or a tick that simply never fires) loses nothing.
 * Counting ticks would drift by exactly that much.
 *
 * TRANSITIONS ARE SAMPLED TOO. A synchronous watcher on `isRunning` takes a
 * reading at the instant the state flips, so the time before the flip is credited
 * to the old state and the time after it to the new one, whatever the interval was
 * doing. `isRunning` must read reactive state for this to work; a plain function
 * over non-reactive data still counts, but only as precisely as the interval.
 *
 * COST: one `setInterval`, armed while running and cleared otherwise. Nothing
 * runs while paused.
 *
 * Reload restarts the figure from zero: nothing is persisted (a documented
 * limitation of the design, not an inaccuracy).
 *
 * `now` is injectable for tests. Client-side only: it arms a timer, so call it
 * from code that runs in the browser, as the interview session does.
 */

import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue'

/** How often the clock re-reads `now()` while running. A prompt, not the unit of counting. */
export const CLOCK_SAMPLE_INTERVAL_MS = 1000

export interface UseInterviewClockOptions {
  /** True while time should count, e.g. `() => state.value === 'live'`. */
  isRunning: () => boolean
  /** Millisecond timestamp source; defaults to `Date.now`. */
  now?: () => number
}

export interface UseInterviewClockReturn {
  /** Whole seconds of running time so far. */
  elapsed: Readonly<Ref<number>>
  /** Takes a last reading, freezes the figure and releases the timer. Safe to call twice. */
  stop: () => void
}

export function useInterviewClock(options: UseInterviewClockOptions): UseInterviewClockReturn {
  const now = options.now ?? Date.now

  const elapsed = ref(0)

  let accumulatedMs = 0
  let lastAt = now()
  let wasRunning = false
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null

  function disarm(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function sample(): void {
    const at = now()

    // The span since the last reading belongs to the state the clock was in THEN.
    if (wasRunning) accumulatedMs += Math.max(0, at - lastAt)
    lastAt = at

    elapsed.value = Math.floor(accumulatedMs / 1000)

    if (stopped) return

    wasRunning = options.isRunning()
    if (wasRunning) {
      timer ??= setInterval(sample, CLOCK_SAMPLE_INTERVAL_MS)
    } else {
      disarm()
    }
  }

  const unwatch = watch(options.isRunning, sample, { flush: 'sync', immediate: true })

  function stop(): void {
    if (stopped) return
    sample()
    stopped = true
    wasRunning = false
    unwatch()
    disarm()
  }

  if (getCurrentScope()) onScopeDispose(stop)

  return { elapsed, stop }
}

/**
 * "mm:ss" with minutes NOT wrapped at 60 ("90:00", "100:00"): the design states a
 * maximum duration longer than an hour for 12+ competencies. A fraction is
 * dropped, and anything negative or non-finite reads "00:00".
 */
export function formatClock(totalSeconds: number): string {
  const whole = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0
  const minutes = Math.floor(whole / 60)
  const seconds = whole % 60

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
