import { describe, expect, it } from 'vitest'
import { ANALYTICS_CONSENT_KEY, readAnalyticsConsent } from '~/app/utils/analytics-consent'

/**
 * Consent defaults to DENIED (C13, task 5.3).
 *
 * Every case in this file is a way of getting no answer — absent storage, an
 * unset key, a corrupted value, a browser that throws on access. They all
 * resolve to the same thing, and that is the entire point: there is exactly one
 * input that means yes, and everything else means no.
 *
 * A default of "granted" would not fail loudly. It would work perfectly, for
 * everybody, while collecting data from people who never agreed — which is the
 * regulatory problem, not the technical one.
 */

function storageWith(value: string | null): Storage {
  return {
    getItem: () => value,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  }
}

describe('readAnalyticsConsent', () => {
  it('is denied when nothing has been stored', () => {
    expect(readAnalyticsConsent(storageWith(null))).toBe(false)
  })

  it('is denied when there is no storage at all', () => {
    // SSR has no localStorage, and a plugin that assumed one would crash the
    // server render rather than simply not tracking.
    expect(readAnalyticsConsent(undefined)).toBe(false)
  })

  it('is denied when storage throws', () => {
    // Safari in private mode, and any browser with storage blocked by policy.
    // A visitor who has locked their browser down is the LEAST likely to want
    // to be tracked, so an exception here must never become permission.
    const hostile = {
      getItem: () => {
        throw new Error('SecurityError')
      },
    } as unknown as Storage

    expect(readAnalyticsConsent(hostile)).toBe(false)
  })

  it('is granted only for the exact stored value', () => {
    expect(readAnalyticsConsent(storageWith('granted'))).toBe(true)
  })

  it('is denied for anything else that looks affirmative', () => {
    // "true", "1" and "yes" are what a hand-written value or a different
    // component would plausibly store. Accepting them would mean consent could
    // be granted by accident, by code that never intended to speak for the user.
    for (const value of ['true', '1', 'yes', 'GRANTED', ' granted ', 'denied', '']) {
      expect(readAnalyticsConsent(storageWith(value))).toBe(false)
    }
  })

  it('uses a key that says what it is about', () => {
    // Namespaced and specific: this is consent for ANALYTICS, not the interview
    // recording consent the ConsentBanner collects. Conflating the two would
    // mean agreeing to be assessed also agreed to be tracked by Google.
    expect(ANALYTICS_CONSENT_KEY).toBe('beai.consent.analytics')
  })
})
