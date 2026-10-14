/**
 * Suggested answer length for the call panel.
 *
 * The per-answer maximum is the interview's server-stated time split evenly across every
 * scripted primary question of the interview. It is guidance only: nothing here ends,
 * pauses or shortens an answer, and the whole-interview timeout is untouched.
 */

/** Thresholds as fractions of the maximum (owner decision O1). */
export const ANSWER_BUDGET_FRACTIONS = { min: 0.25, idealFrom: 0.375, idealTo: 0.75 } as const

/** All values are whole seconds. */
export interface AnswerBudget {
  min: number
  idealFrom: number
  idealTo: number
  max: number
}

const isPositiveFinite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

/**
 * `null` (no budget) when either input is missing, not finite, zero or negative, or when the
 * maximum would be under one second. The client's 300 s countdown seed is never an input:
 * pass `null` until the server states `interview_max_seconds`.
 */
export function answerBudget(
  interviewMaxSeconds: number | null | undefined,
  primaryTotalAll: number | null | undefined
): AnswerBudget | null {
  if (!isPositiveFinite(interviewMaxSeconds) || !isPositiveFinite(primaryTotalAll)) return null

  const max = Math.floor(interviewMaxSeconds / primaryTotalAll)
  if (max < 1) return null

  return {
    min: Math.round(max * ANSWER_BUDGET_FRACTIONS.min),
    idealFrom: Math.round(max * ANSWER_BUDGET_FRACTIONS.idealFrom),
    idealTo: Math.round(max * ANSWER_BUDGET_FRACTIONS.idealTo),
    max,
  }
}
