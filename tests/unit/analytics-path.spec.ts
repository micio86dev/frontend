import { describe, expect, it } from 'vitest'
import { isAnalyticsSafeRoute, redactAnalyticsPath } from '~/app/utils/analytics-path'

/**
 * Nothing identifying reaches a third-party analytics sink (C13, task 5.4).
 *
 * This is the highest-consequence file in the analytics work, because the
 * candidate's magic-link token IS a path segment: `/interview/<jwt>`. GA4's
 * default page_view sends `page_location` and `page_path` verbatim, so wiring
 * analytics naively would post a live credential to Google — one that grants
 * whoever holds it entry to that candidate's interview.
 *
 * That is not a privacy nicety. It is handing out a key, in bulk, to a system
 * nobody at BEAI can audit or purge.
 */

describe('redactAnalyticsPath', () => {
  it('replaces the interview token with a placeholder', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjQyfQ.SECRET-SIGNATURE'

    expect(redactAnalyticsPath(`/interview/${token}`)).toBe('/interview/:token')
  })

  it('replaces the token under a locale prefix too', () => {
    // i18n uses prefix_except_default, so the same page exists at /en/interview/…
    // A rule that only knew about the unprefixed form would leak every token
    // belonging to an English-language project and nobody would notice, because
    // the Italian ones would look correctly redacted.
    expect(redactAnalyticsPath('/en/interview/eyJ.LEAK.sig')).toBe('/en/interview/:token')
  })

  it('leaves the named interview routes intact', () => {
    // done/error/terminal are fixed pages, not tokens. Redacting them would
    // collapse three distinct outcomes into one and destroy the only funnel
    // signal analytics is here to provide.
    expect(redactAnalyticsPath('/interview/done')).toBe('/interview/done')
    expect(redactAnalyticsPath('/interview/error')).toBe('/interview/error')
    expect(redactAnalyticsPath('/interview/terminal')).toBe('/interview/terminal')
    expect(redactAnalyticsPath('/en/interview/done')).toBe('/en/interview/done')
  })

  it('strips the query string and the fragment entirely', () => {
    // Not redacted field by field — removed wholesale. Query parameters are
    // where tokens, candidate references and exit-redirect URLs travel, and an
    // allowlist of safe parameter names is a promise about every parameter
    // anyone will ever add.
    expect(redactAnalyticsPath('/interview/done?token=LEAK&ref=acme-672')).toBe('/interview/done')
    expect(redactAnalyticsPath('/?utm_source=x#LEAK')).toBe('/')
  })

  it('redacts a token even when the path has a trailing slash', () => {
    expect(redactAnalyticsPath('/interview/eyJ.LEAK.sig/')).toBe('/interview/:token')
  })

  it('passes ordinary pages through unchanged', () => {
    expect(redactAnalyticsPath('/')).toBe('/')
    expect(redactAnalyticsPath('/unsupported')).toBe('/unsupported')
    expect(redactAnalyticsPath('/en/unsupported')).toBe('/en/unsupported')
  })

  it('never returns anything resembling a JWT, whatever it is given', () => {
    const jwtish = /[\w-]{16,}\.[\w-]{8,}\.[\w-]{8,}/

    const hostile = [
      '/interview/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcdefghij',
      '/en/interview/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcdefghij/',
      '/interview/done?next=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcdefghij',
    ]

    // A backstop, not a duplicate of the cases above. Those assert the shapes
    // known today; this asserts the property that actually matters, so a new
    // route added later fails here rather than in production.
    for (const path of hostile) {
      expect(redactAnalyticsPath(path)).not.toMatch(jwtish)
    }
  })
})

describe('isAnalyticsSafeRoute', () => {
  it('marks the interview itself as UNSAFE', () => {
    // Session replay records the DOM. On this page the DOM is the interview:
    // the question being asked, the live transcript of what the candidate said,
    // and the video surface. Replaying it means a third party holds a recording
    // of an assessment the candidate believes is between them and one employer.
    expect(isAnalyticsSafeRoute('/interview/eyJ.tok.sig')).toBe(false)
    expect(isAnalyticsSafeRoute('/en/interview/eyJ.tok.sig')).toBe(false)
  })

  it('marks every other interview page as unsafe too', () => {
    // done/error/terminal carry no transcript, but they are reached only from
    // within a session and the URL history around them does. The whole branch
    // is excluded because a per-page allowlist is a decision that has to be
    // remade correctly every time a page is added.
    expect(isAnalyticsSafeRoute('/interview/done')).toBe(false)
    expect(isAnalyticsSafeRoute('/interview/error')).toBe(false)
  })

  it('marks ordinary pages as safe', () => {
    expect(isAnalyticsSafeRoute('/')).toBe(true)
    expect(isAnalyticsSafeRoute('/unsupported')).toBe(true)
    expect(isAnalyticsSafeRoute('/en/unsupported')).toBe(true)
  })
})
