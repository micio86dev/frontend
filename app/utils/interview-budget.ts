/**
 * Behaviour once the whole interview's time is spent.
 *
 * The question in progress is allowed to finish: the avatar speaks its closing
 * phrase, and that is what completes it. The server then settles the interview
 * (`budget_spent` on /end) and answers `done`, so no further competency starts.
 */

/** Longest the interview waits for the closing phrase after the budget runs out, then closes anyway. */
export const INTERVIEW_CLOSING_GRACE_MS = 60_000
