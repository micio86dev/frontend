/**
 * The identity a reusable-link visitor types never reaches an error sink
 * (reusable-link-visitor-identity VD-17; observability spec "A Reusable-Link
 * Visitor's Name And Email Never Reach An Error Sink, A Log Line Or Analytics").
 *
 * The redemption body is now `{link_token, display_name, email}`, and an error
 * report that captures that body (a failed request, a breadcrumb, a context) would
 * carry a name and an address. The scrubber already denies those keys and redacts
 * addresses by pattern; these tests pin that, so a refactor of the scrubber cannot
 * quietly stop covering the one body that now holds personal data.
 *
 * This is a SEPARATE spec on purpose. The shared fixture
 * `fixtures/reusable-link-scrub-cases.ts` must stay byte-identical with the
 * backoffice copy (the wrapper guard compares them), so a frontend-only case
 * cannot live there.
 */
import { describe, expect, it } from 'vitest'
import { DENIED_KEYS, scrubSentryEvent, type ScrubbableEvent } from '~/app/utils/sentry-scrub'
import { REUSABLE_LINK_SECRET, REUSABLE_LINK_TOKEN } from './fixtures/reusable-link-scrub-cases'

/** Sentinels no other string in the scrubber or its fixtures contains. */
const NAME = 'Ada Sentinel Lovelace'
const EMAIL = 'ada.sentinel@example.test'

const REDEMPTION_BODY = {
  link_token: REUSABLE_LINK_TOKEN,
  display_name: NAME,
  email: EMAIL,
}

function scrubbed(event: Record<string, unknown>): string {
  return JSON.stringify(scrubSentryEvent(event as ScrubbableEvent))
}

describe('the redemption body, wherever an error report might capture it', () => {
  it.each<[string, Record<string, unknown>]>([
    ['an extra body', { extra: { body: REDEMPTION_BODY } }],
    ['the request data', { request: { data: REDEMPTION_BODY } }],
    ['the request data as a JSON string', { request: { data: JSON.stringify(REDEMPTION_BODY) } }],
    [
      'a fetch breadcrumb',
      {
        breadcrumbs: [
          { category: 'fetch', data: { url: '/api/reusable-links/redeem', body: REDEMPTION_BODY } },
        ],
      },
    ],
    ['a deep context', { contexts: { redeem: { attempt: { body: REDEMPTION_BODY } } } }],
    ['an array of bodies', { extra: { bodies: [REDEMPTION_BODY, REDEMPTION_BODY] } }],
  ])('has all three values replaced in %s', (_name, event) => {
    const out = scrubbed(event)

    expect(out).not.toContain(NAME)
    expect(out).not.toContain(EMAIL)
    expect(out).not.toContain(REUSABLE_LINK_TOKEN)
    expect(out).not.toContain(REUSABLE_LINK_SECRET)
  })

  it('keeps the field names, so the report still shows what was sent', () => {
    const out = scrubbed({ extra: { body: REDEMPTION_BODY } })

    expect(out).toContain('display_name')
    expect(out).toContain('email')
    expect(out).toContain('link_token')
  })
})

describe('an address that appears as free text', () => {
  it.each<[string, Record<string, unknown>]>([
    ['an event message', { message: `redeem failed for ${EMAIL}` }],
    [
      'an exception value',
      { exception: { values: [{ type: 'Error', value: `bad address ${EMAIL}` }] } },
    ],
    ['a console breadcrumb', { breadcrumbs: [{ category: 'console', message: `typed ${EMAIL}` }] }],
    ['an ordinary extra key', { extra: { note: `the visitor typed ${EMAIL} twice` } }],
  ])('is redacted in %s', (_name, event) => {
    expect(scrubbed(event)).not.toContain(EMAIL)
  })

  it('is redacted next to the token in one message', () => {
    const out = scrubbed({ message: `${REUSABLE_LINK_TOKEN} ${EMAIL}` })

    expect(out).not.toContain(EMAIL)
    expect(out).not.toContain(REUSABLE_LINK_SECRET)
  })
})

describe('the keys that carry the identity are denied', () => {
  it('still denies email and display_name', () => {
    expect(DENIED_KEYS.has('email')).toBe(true)
    expect(DENIED_KEYS.has('display_name')).toBe(true)
  })

  it.each(['email', 'display_name', 'visitor_email', 'candidate_email', 'user_email'])(
    'cuts the value under the key %s at any depth',
    (key) => {
      const out = scrubbed({ extra: { outer: { inner: [{ [key]: 'VALUE-UNDER-KEY-SENTINEL' }] } } })

      expect(out).not.toContain('VALUE-UNDER-KEY-SENTINEL')
    }
  )
})
