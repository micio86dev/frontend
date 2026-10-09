/**
 * The time of day until which a stored candidate session can be resumed
 * (candidate-interview-call-ui D9).
 *
 * `exp` is the stored token's expiry in epoch SECONDS, as
 * `useCandidateSession().read()` returns it. The result is the hours and minutes
 * in the candidate's locale ("14:30", "02:30 PM"), or null when there is no
 * usable `exp`: callers drop the sentence instead of guessing a time.
 */
export function formatDeadline(exp: number | null | undefined, locale: string): string | null {
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null

  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(exp * 1000)
  )
}
