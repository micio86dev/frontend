import { describe, expect, it } from 'vitest'
import { analyticsPlan, gaConfigPayload } from '~/app/utils/analytics'
import { redactAnalyticsPath } from '~/app/utils/analytics-path'

/**
 * What actually loads, and what it is allowed to send (C13, tasks 5.3 / 5.4).
 *
 * The decision is a pure function on purpose. Whether a third-party recorder
 * starts on a page showing somebody's interview transcript is not something to
 * discover by reading a plugin's control flow in a browser — it is the kind of
 * thing that should be assertable in a line of test.
 */

const ids = { gaMeasurementId: 'G-TEST123', clarityProjectId: 'clr123' }

describe('analyticsPlan — the default is OFF', () => {
  it('loads nothing when no IDs are configured', () => {
    const plan = analyticsPlan({
      gaMeasurementId: '',
      clarityProjectId: '',
      consentGranted: true,
      path: '/',
    })

    expect(plan.loadGa).toBe(false)
    expect(plan.loadClarity).toBe(false)
  })

  it('loads nothing without consent, even with both IDs configured', () => {
    const plan = analyticsPlan({ ...ids, consentGranted: false, path: '/' })

    // Consent defaults to denied and there is no UI yet to grant it — see
    // docs/observability.md. That is the same posture as the GDPR purge:
    // built, correct, and inert until a human decision exists. Shipping
    // analytics that run before consent would be a regulatory problem, not a
    // configuration one.
    expect(plan.loadGa).toBe(false)
    expect(plan.loadClarity).toBe(false)
  })

  it('loads only the tool whose ID is present', () => {
    const onlyGa = analyticsPlan({
      gaMeasurementId: 'G-TEST123',
      clarityProjectId: '',
      consentGranted: true,
      path: '/',
    })

    expect(onlyGa.loadGa).toBe(true)
    expect(onlyGa.loadClarity).toBe(false)
  })
})

describe('analyticsPlan — the interview is off limits to session replay', () => {
  it('never loads Clarity on the interview, even with consent and an ID', () => {
    const plan = analyticsPlan({ ...ids, consentGranted: true, path: '/interview/eyJ.tok.sig' })

    // Not a setting. Clarity records the DOM, and on this page the DOM is the
    // question being asked plus the live transcript of the answer. There is no
    // configuration of a session recorder that makes that acceptable, so the
    // decision is made here rather than left to whoever fills in the env var.
    expect(plan.loadClarity).toBe(false)
  })

  it('does not load Clarity on the other interview pages either', () => {
    for (const path of ['/interview/done', '/interview/error', '/en/interview/terminal']) {
      expect(analyticsPlan({ ...ids, consentGranted: true, path }).loadClarity).toBe(false)
    }
  })

  it('still counts the interview in GA, but only as a redacted path', () => {
    const plan = analyticsPlan({ ...ids, consentGranted: true, path: '/interview/eyJ.LEAK.sig' })

    // Dropping the interview from analytics entirely would remove the only
    // funnel that matters — how many candidates who start actually finish. A
    // page count is not personal data; the token in the URL is.
    expect(plan.loadGa).toBe(true)
    expect(plan.pagePath).toBe('/interview/:token')
    expect(plan.pagePath).not.toContain('LEAK')
  })

  it('loads Clarity on ordinary pages', () => {
    expect(analyticsPlan({ ...ids, consentGranted: true, path: '/' }).loadClarity).toBe(true)
  })
})

describe('gaConfigPayload — what GA4 is allowed to see', () => {
  const payload = gaConfigPayload('/interview/:token')

  it('sends the redacted path and NOT the real location', () => {
    expect(payload.page_path).toBe('/interview/:token')

    // GA4 defaults to reading window.location itself. Overriding page_path
    // alone is not enough — page_location would still carry the token — so it
    // is pinned to the origin with the path stripped off.
    expect(payload.page_location).toBe('')
  })

  it('turns off advertising signals and personalization', () => {
    // A candidate taking a hiring assessment has not agreed to be an
    // advertising audience, and remarketing lists built from this traffic would
    // leak the fact that a named person is job-hunting to every advertiser who
    // buys that segment.
    expect(payload.allow_google_signals).toBe(false)
    expect(payload.allow_ad_personalization_signals).toBe(false)
  })

  it('anonymizes IP and does not send a user id', () => {
    expect(payload.anonymize_ip).toBe(true)
    expect(payload).not.toHaveProperty('user_id')
    expect(payload).not.toHaveProperty('client_id')
  })

  it('carries no candidate reference and no credential under any key', () => {
    const encoded = JSON.stringify(
      gaConfigPayload(redactAnalyticsPath('/interview/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.SIGNATURE'))
    )

    // A whole-object assertion rather than a per-field one: the risk is a field
    // somebody adds later, not one of the four above.
    //
    // The literal string ":token" is deliberately NOT forbidden here — it is
    // the placeholder that PROVES the redaction ran. Forbidding the word rather
    // than the value is the kind of assertion that gets satisfied by renaming
    // the placeholder, which would leave the leak exactly where it was.
    expect(encoded).not.toMatch(/[\w-]{16,}\.[\w-]{8,}\.[\w-]{8,}/)
    expect(encoded).not.toMatch(/candidate|participant/i)
    expect(encoded).toContain(':token')
  })
})
