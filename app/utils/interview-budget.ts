/**
 * Behaviour once the whole interview's time is spent.
 *
 * The question in progress is allowed to finish: the avatar speaks its closing
 * phrase, and that is what completes it. No further competency starts after it.
 */

/** Longest the interview waits for the closing phrase after the budget runs out, then closes anyway. */
export const INTERVIEW_CLOSING_GRACE_MS = 60_000

/** The server's directive, overridden to `done` when the budget is spent and it would continue. */
export function directiveWithinBudget<T extends 'continue' | 'pause' | 'done' | null>(
  directive: T,
  budgetSpent: boolean
): T | 'done' {
  return budgetSpent && directive === 'continue' ? 'done' : directive
}
