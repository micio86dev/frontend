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

/**
 * Broadcast when the visitor answers, so the analytics plugin can start without
 * a page reload.
 *
 * An event rather than a shared mutable flag: the plugin stays the single owner
 * of script injection, and the banner stays a component that knows nothing
 * about Google or Microsoft.
 */
export const ANALYTICS_CONSENT_EVENT = 'beai:analytics-consent'

const GRANTED = 'granted'
const DENIED = 'denied'

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

/**
 * Whether the visitor has answered AT ALL — a different question from whether
 * they said yes.
 *
 * "Not granted" and "never asked" are identical for tracking purposes and
 * completely different for the banner: one means stay silent, the other means
 * ask. Collapsing them is how a banner ends up either nagging somebody who
 * already refused, or never appearing at all.
 *
 * A value that is neither answer counts as no decision. Re-asking costs a small
 * annoyance; assuming costs a decision attributed to somebody who never made it.
 */
export function hasAnalyticsDecision(storage: Storage | undefined): boolean {
  if (storage === undefined) {
    return false
  }

  try {
    const stored = storage.getItem(ANALYTICS_CONSENT_KEY)

    return stored === GRANTED || stored === DENIED
  } catch {
    return false
  }
}

/**
 * Records the answer — including a refusal, EXPLICITLY.
 *
 * Storing nothing on refusal would be indistinguishable from never having
 * asked, so the banner would return on every visit: nagging somebody who
 * already said no, which regulators treat as pressure towards yes.
 *
 * Failures are swallowed. A banner that breaks the page because storage is full
 * or blocked is a far worse outcome than one that asks again next time.
 */
export function writeAnalyticsConsent(storage: Storage | undefined, granted: boolean): void {
  if (storage === undefined) {
    return
  }

  try {
    storage.setItem(ANALYTICS_CONSENT_KEY, granted ? GRANTED : DENIED)
  } catch {
    // Nowhere to record the answer. The visitor's choice still applies to this
    // page load; it simply cannot be remembered.
  }
}
