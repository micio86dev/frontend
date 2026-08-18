import { describe, expect, it } from 'vitest'
import {
  redactUrl,
  scrubBreadcrumb,
  scrubSentryEvent,
  type ScrubbableEvent,
} from '~/app/utils/sentry-scrub'
import { sentryPosture } from '~/app/utils/sentry-init'

/**
 * Nothing confidential leaves for Sentry from the candidate-facing app
 * (C13, task 5.1 — Nuxt half).
 *
 * Same shape as `api/tests/Feature/C13/SentryScrubberTest.php`: nine tests,
 * each naming ONE class of leak this scrubber must close, proven by
 * constructing a payload that would leak the marker string if the scrubber
 * were deleted (or replaced with a no-op) and asserting it does not appear
 * in the scrubbed output.
 *
 * `sendDefaultPii: false` stops Sentry ATTACHING context automatically. It
 * does nothing about what this app hands Sentry itself — and on the
 * candidate-facing app, the single most exposed field is the URL: the
 * interview entry link carries the candidate's SSO token as a path segment.
 */

function eventWith(extra: Record<string, unknown>): ScrubbableEvent {
  return { extra }
}

describe('scrubSentryEvent — key-based denylist', () => {
  it('1. a candidate interview answer never reaches the sink', () => {
    const answer = 'I once falsified a report under deadline pressure'

    const scrubbed = scrubSentryEvent(
      eventWith({
        transcript: answer,
        prompt: `Score this: ${answer}`,
        excerpts: [answer],
      })
    )

    // The entire premise of the product is that a candidate's answers stay
    // between them and the organization that assessed them.
    expect(JSON.stringify(scrubbed.extra)).not.toContain('falsified')
  })

  it('2. tokens and secrets never reach the sink', () => {
    const scrubbed = scrubSentryEvent(
      eventWith({
        authorization: 'Bearer eyJhbGciOi.LEAKED',
        api_key: 'beai_live_LEAKED',
        webhook_secret: 'whsec_LEAKED',
        refresh_token: 'rt_LEAKED',
      })
    )

    expect(JSON.stringify(scrubbed.extra)).not.toContain('LEAKED')
  })

  it('3. candidate identifiers never reach the sink, camelCase or snake_case', () => {
    const scrubbed = scrubSentryEvent(
      eventWith({
        candidate_ref: 'acme-672',
        candidateRef: 'acme-672',
        display_name: 'Mario Rossi',
        displayName: 'Mario Rossi',
      })
    )

    const encoded = JSON.stringify(scrubbed.extra)

    // candidate_ref is opaque to BEAI but NOT to the calling system — it is
    // their key back to a named person, identifying the moment it sits
    // alongside anything else.
    expect(encoded).not.toContain('acme-672')
    expect(encoded).not.toContain('Mario Rossi')
  })

  it('4. secrets nested at any depth are scrubbed', () => {
    const scrubbed = scrubSentryEvent(
      eventWith({
        context: { delivery: { payload: { answer: 'NESTED-LEAK' } } },
      })
    )

    // A top-level-only pass would look like it worked while letting the
    // real payload through — exceptions nest their context by nature.
    expect(JSON.stringify(scrubbed.extra)).not.toContain('NESTED-LEAK')
  })

  it('5. fields ending in Token/Secret/Key are scrubbed by convention, camelCase included', () => {
    const scrubbed = scrubSentryEvent(
      eventWith({
        providerApiKey: 'PK-LEAK',
        sessionToken: 'ST-LEAK',
        signingSecret: 'SS-LEAK',
      })
    )

    // Enumerating every future field name is impossible; the convention
    // covers what the denylist has not been told about yet.
    expect(JSON.stringify(scrubbed.extra)).not.toContain('LEAK')
  })
})

describe('scrubSentryEvent — the candidate entry-link token', () => {
  it('6. is stripped from event.request.url', () => {
    const scrubbed = scrubSentryEvent({
      request: { url: 'https://app.beai.io/interview/eyJhbGciOiJIUzI1NiJ9.LEAKED.sig' },
    })

    expect(scrubbed.request?.url).not.toContain('LEAKED')
    expect(scrubbed.request?.url).toBe('https://app.beai.io/interview/:token')
  })

  it('7. is stripped from an XHR/fetch breadcrumb query string (the SSO exchange call)', () => {
    const scrubbed = scrubBreadcrumb({
      category: 'fetch',
      data: { url: 'https://api.beai.io/api/sso/exchange?token=LEAKED-QUERY-TOKEN' },
    })

    expect(scrubbed.data?.['url']).not.toContain('LEAKED-QUERY-TOKEN')
  })
})

describe('scrubSentryEvent — user context and non-sensitive diagnostics', () => {
  it('8. user context is dropped entirely', () => {
    const scrubbed = scrubSentryEvent({ user: { id: 'candidate-42', email: 'x@example.com' } })

    // Dropped rather than scrubbed field by field: a candidate is not a
    // Sentry "user", and there is no case where keeping it is worth the risk
    // of a future SDK version adding a field this module has never heard of.
    expect(scrubbed.user).toBeUndefined()
  })

  it('9. diagnostic context that is NOT sensitive survives, and Sentry is inert without a DSN', () => {
    const scrubbed = scrubSentryEvent(
      eventWith({
        route_name: 'interview-session',
        http_status: 500,
        latency_ms: 1234,
      })
    )

    // A denylist rather than an allowlist, deliberately: an allowlist would
    // strip the context that makes an error report useful, and an unusable
    // error reporter gets switched off — a worse outcome than a scrubbed one.
    expect(scrubbed.extra).toEqual({
      route_name: 'interview-session',
      http_status: 500,
      latency_ms: 1234,
    })

    // No DSN is committed anywhere in this repo, and none should be — it is
    // a per-deployment credential. `sentryPosture` must therefore report the
    // SDK as disabled by construction, not merely "given an empty string".
    const posture = sentryPosture('', 'local')
    expect(posture.enabled).toBe(false)
    expect(posture.sendDefaultPii).toBe(false)

    // And PII stays pinned off even for a real deployment DSN — not a
    // preference any environment gets to flip.
    expect(sentryPosture('https://key@o0.ingest.sentry.io/1', 'production').sendDefaultPii).toBe(
      false
    )
  })
})

describe('redactUrl', () => {
  it('leaves an unrelated absolute URL untouched apart from its query string', () => {
    expect(redactUrl('https://app.beai.io/interview/done?reason=ok')).toBe(
      'https://app.beai.io/interview/done'
    )
  })

  it('passes through undefined and empty strings unchanged', () => {
    expect(redactUrl(undefined)).toBeUndefined()
    expect(redactUrl('')).toBe('')
  })
})
