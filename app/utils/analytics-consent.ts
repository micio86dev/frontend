/**
 * Analytics consent, which defaults to DENIED (C13, task 5.3).
 *
 * Deliberately SEPARATE from the interview-recording consent the ConsentBanner
 * collects. Agreeing to be assessed is not agreeing to be tracked by Google,
 * and a single flag covering both would quietly make it so.
 *
 * There is exactly one input that means yes. Every other outcome — no storage,
 * an unset key, a corrupted value, a browser that throws — resolves to no. A
 * permissive default would not fail loudly: it would work perfectly, for
 * everybody, while collecting data from people who never agreed.
 */

export const ANALYTICS_CONSENT_KEY = 'beai.consent.analytics'

const GRANTED = 'granted'

export function readAnalyticsConsent(storage: Storage | undefined): boolean {
  if (storage === undefined) {
    return false
  }

  try {
    // Exact match, not a truthiness check. "true", "1" and "yes" are what a
    // hand-written value or an unrelated component would plausibly store, and
    // accepting them would let consent be granted by code that never intended
    // to speak for the user.
    return storage.getItem(ANALYTICS_CONSENT_KEY) === GRANTED
  } catch {
    // Private mode, or storage blocked by policy. A visitor who has locked
    // their browser down is the least likely to want tracking, so an exception
    // here must never become permission.
    return false
  }
}
