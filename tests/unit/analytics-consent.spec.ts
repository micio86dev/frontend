import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_CONSENT_KEY,
  hasAnalyticsDecision,
  readAnalyticsConsent,
  writeAnalyticsConsent,
} from '~/app/utils/analytics-consent'

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
    // RECORDING consent the interview page collects before a session starts.
    // Conflating the two would mean agreeing to be assessed also agreed to be
    // tracked by Google — and one of those is required to use the service while
    // the other must be freely refusable. Bundling them is precisely what makes
    // a consent invalid.
    expect(ANALYTICS_CONSENT_KEY).toBe('beai.consent.analytics')
  })
})

describe('hasAnalyticsDecision — has the visitor answered at all?', () => {
  it('is false when nothing is stored', () => {
    // Distinct from readAnalyticsConsent. "Not granted" and "never asked" are
    // the same for tracking purposes and completely different for the banner:
    // one means stay silent, the other means ask.
    expect(hasAnalyticsDecision(storageWith(null))).toBe(false)
  })

  it('is true after either answer', () => {
    expect(hasAnalyticsDecision(storageWith('granted'))).toBe(true)
    expect(hasAnalyticsDecision(storageWith('denied'))).toBe(true)
  })

  it('is false for a value that is neither', () => {
    // A corrupted or hand-edited value means asking again, not assuming. The
    // cost of re-asking is a small annoyance; the cost of assuming is a
    // decision attributed to somebody who never made it.
    for (const value of ['true', '', 'GRANTED', 'maybe']) {
      expect(hasAnalyticsDecision(storageWith(value))).toBe(false)
    }
  })

  it('is false when storage is absent or throws', () => {
    const hostile = {
      getItem: () => {
        throw new Error('SecurityError')
      },
    } as unknown as Storage

    // Returning false means the banner shows and the choice is never persisted
    // — mildly repetitive, and the only honest option when there is nowhere to
    // record an answer.
    expect(hasAnalyticsDecision(undefined)).toBe(false)
    expect(hasAnalyticsDecision(hostile)).toBe(false)
  })
})

describe('writeAnalyticsConsent', () => {
  function recordingStorage(): { storage: Storage; written: Record<string, string> } {
    const written: Record<string, string> = {}

    return {
      written,
      storage: {
        getItem: (k: string) => written[k] ?? null,
        setItem: (k: string, v: string) => {
          written[k] = v
        },
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
      },
    }
  }

  it('records a refusal explicitly rather than storing nothing', () => {
    const { storage, written } = recordingStorage()

    writeAnalyticsConsent(storage, false)

    // Storing nothing would be indistinguishable from never having asked, so
    // the banner would return on every visit — nagging somebody who already
    // said no, which regulators treat as pressuring them into yes.
    expect(written[ANALYTICS_CONSENT_KEY]).toBe('denied')
    expect(readAnalyticsConsent(storage)).toBe(false)
    expect(hasAnalyticsDecision(storage)).toBe(true)
  })

  it('records a grant that reads back as granted', () => {
    const { storage } = recordingStorage()

    writeAnalyticsConsent(storage, true)

    expect(readAnalyticsConsent(storage)).toBe(true)
  })

  it('does not throw when storage refuses to write', () => {
    const hostile = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    } as unknown as Storage

    // A banner that crashes the page because storage is full would be a far
    // worse outcome than one that simply asks again next time.
    expect(() => writeAnalyticsConsent(hostile, true)).not.toThrow()
  })
})
