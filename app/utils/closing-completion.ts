/**
 * Shared timing for "the closing greeting has really finished" (Tavus + HeyGen).
 *
 * A heard end/final phrase is only the LAST words of the closing. Completion is
 * released after the avatar has been continuously silent for COMPLETION_SETTLE_MS,
 * or, if an audio event is lost, after closingFallbackMs(text).
 */

/**
 * Base of the lost-event fallback: how long a held completion waits before it
 * completes anyway, on top of the estimated speech length.
 * UNMEASURED: an estimate, to be confirmed on a live run.
 */
export const COMPLETION_FALLBACK_MS = 12_000

/**
 * Continuous avatar silence required before a held completion is released. Rides
 * out the mid-speech pauses of a long closing, which emit a stop that is not the end.
 * UNMEASURED: an estimate, to be confirmed on a live run.
 */
export const COMPLETION_SETTLE_MS = 2_000

/** Rough speech time per character (~100 ms). UNMEASURED estimate. */
const SPEECH_MS_PER_CHAR = 100

/** Hard ceiling of the fallback window. */
const COMPLETION_FALLBACK_CAP_MS = 5 * 60_000

/** The lost-event fallback for a heard phrase: base + estimated speech, capped at 5 min. */
export function closingFallbackMs(text: string): number {
  return Math.min(
    COMPLETION_FALLBACK_MS + text.length * SPEECH_MS_PER_CHAR,
    COMPLETION_FALLBACK_CAP_MS
  )
}
