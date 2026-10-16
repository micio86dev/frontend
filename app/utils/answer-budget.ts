/**
 * Suggested answer length for the call panel.
 *
 * A good answer lasts from `min` to `max` seconds (the active avatar template's range, default
 * 1:30 to 2:30). Three zones: below min (too short), min to max (good), above max (long). The
 * bar's scale ends at `end`, a third past the max, so the long zone is visible. It is guidance
 * only: nothing here ends, pauses or shortens an answer.
 */

/** Used when the start response names no valid range. */
export const DEFAULT_ANSWER_RANGE = { min: 90, max: 150 } as const

/** All values are whole seconds. */
export interface AnswerBudget {
  min: number
  max: number
  /** Where the bar's scale ends: `max` x 4/3, rounded. */
  end: number
}

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

/** `null` (no budget) unless both bounds are positive whole seconds with min below max. */
export function answerBudget(min: unknown, max: unknown): AnswerBudget | null {
  if (!isPositiveInt(min) || !isPositiveInt(max) || min >= max) return null

  return { min, max, end: Math.round((max * 4) / 3) }
}

/** The range a start response states, or the default when either bound is missing or invalid. */
export function answerRangeFrom(min: unknown, max: unknown): { min: number; max: number } {
  const budget = answerBudget(min, max)

  return budget ? { min: budget.min, max: budget.max } : { ...DEFAULT_ANSWER_RANGE }
}

/**
 * `m:ss` for the suggested-length labels ("Good answer: 1:30 to 2:30"): minutes
 * unpadded and never wrapped at 60, a fraction dropped, anything negative or non-finite 0:00.
 */
export function formatBudgetTime(totalSeconds: number): string {
  const whole = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0

  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
