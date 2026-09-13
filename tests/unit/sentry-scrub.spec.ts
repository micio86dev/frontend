import { describe, expect, it } from 'vitest'
import {
  DENIED_CONTENT_WORDS,
  DENIED_KEYS,
  HANDLED_EVENT_FIELDS,
  redactFreeText,
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
        email: 'mario.rossi@example.test',
      })
    )

    const encoded = JSON.stringify(scrubbed.extra)

    // candidate_ref is opaque to BEAI but NOT to the calling system — it is
    // their key back to a named person, identifying the moment it sits
    // alongside anything else.
    expect(encoded).not.toContain('acme-672')
    expect(encoded).not.toContain('Mario Rossi')

    // The email is the candidate's GLOBAL identity key (CLAUDE.md ruling 8,
    // reversed 2026-09-01) and is named in the GDPR retention sign-off
    // (ruling 2). `redactAnalyticsPath` already strips `?email=` from URLs —
    // the codebase agreed it was sensitive before the denylist did.
    expect(encoded).not.toContain('mario.rossi@example.test')
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

describe('the two path passes must not disagree on the same route', () => {
  // `redactPath` guards `/interview/done` as a NAMED PAGE, and `redactFreeText`
  // used to defeat that guard by running the unanchored pass on the fallthrough
  // anyway. `redactUrl` said `/interview/done`, `redactFreeText` said
  // `/interview/:token`, and every event from the done and error pages grouped
  // under the token page. A grouping collapse, not a leak — which this module
  // argues is the worse outcome.
  it.each([['/interview/done'], ['/interview/error'], ['/en/interview/done']])(
    'reports %s the same way through both passes',
    (route) => {
      expect(redactFreeText(route)).toBe(redactUrl(route))
      expect(redactFreeText(route)).toBe(route)
    }
  )

  it('still redacts a real token through both passes', () => {
    expect(redactFreeText('/interview/LIVE-TOKEN')).toBe('/interview/:token')
    expect(redactUrl('/interview/LIVE-TOKEN')).toBe('/interview/:token')
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

describe('the suffix convention has to cover the address too', () => {
  it('scrubs any field ending in _email, camelCase included', () => {
    // Same reasoning the _token/_secret/_key suffixes already carry: enumerating
    // every future field name is impossible, a naming convention is not. An
    // address is the one candidate identifier that resolves to a person with no
    // calling system in the loop.
    const scrubbed = scrubSentryEvent(
      eventWith({
        candidate_email: 'mario.rossi@example.test',
        contactEmail: 'anna.bianchi@example.test',
        // The plural and the compound, which a `_email` SUFFIX misses and the
        // api's `str_contains` catches. The two halves must not disagree.
        email_address: 'carla.verdi@example.test',
        emails: ['dario.neri@example.test'],
      })
    )

    const encoded = JSON.stringify(scrubbed.extra)

    expect(encoded).not.toContain('mario.rossi@example.test')
    expect(encoded).not.toContain('anna.bianchi@example.test')
    expect(encoded).not.toContain('carla.verdi@example.test')
    expect(encoded).not.toContain('dario.neri@example.test')
  })
})

describe('an embedded document is scanned with the delimiter spellings the normalizer folds', () => {
  // The normalizer half of this rule was pinned; the SCANNER half was not.
  // `EMBEDDED_KEY_PATTERN` matched keys with `[\w.-]+`, so a delimiter-bearing
  // key inside a serialised body was never FOUND — the denylist never got the
  // chance to refuse it.
  //
  // NO braces in the fixture: a balanced `{…}` is cut wholesale one pass
  // earlier, so a document-shaped fixture proves nothing about this scanner. A
  // TRUNCATED body — the ordinary shape once a provider message has been
  // clipped — is what actually reaches it.
  it('denies a delimiter-bearing key inside a truncated body', () => {
    const body =
      'HTTP 422 from provider: "candidate ref":"SPEECHLEAK", ' +
      '"data[transcript]":"SPEECHLEAK", "user:candidate_ref":"REFLEAK"'

    const extra = scrubSentryEvent({ extra: { provider_error: body } }).extra

    expect(JSON.stringify(extra)).not.toContain('LEAK')
  })
})

describe('a key path the normalizer cannot segment is a key path it cannot deny', () => {
  // Measured leak: `toSnakeKey` folded `-`, `.` and whitespace and nothing else,
  // so a BRACKET or COLON spelling never split into segments the walk reaches.
  // `headers[authorization]` shipped a live bearer token and `data[transcript]`
  // shipped candidate speech, both one character away from the same value being
  // cut correctly. The api carried the identical `[-.\s]+` set, so this was a
  // symmetric gap, not a mirror break — and symmetric is worse, not better.
  it.each([
    ['data[transcript]'],
    ['form[answer_1]'],
    ['headers[authorization]'],
    ['user:candidate_ref'],
    ['headers/authorization'],
    ['user|candidate_ref'],
    // A CLOSING delimiter leaves an empty trailing segment, and the single-word
    // rule requires the denied word to BE the last one. `data[content]` folded
    // to `data_content_` — parts `['data','content','']` — so `content` was
    // never tested as the last segment and candidate speech walked. The six
    // cases above were all blind to it: every one ends in a CONTENT WORD or a
    // multi-word entry, both of which match in any position anyway, so the
    // test was green on the half that already worked.
    ['data[content]'],
    ['user[content]'],
    ['data[contents]'],
  ])('denies %s', (key) => {
    const extra = scrubSentryEvent({ extra: { [key]: 'LEAKED' } }).extra as Record<string, unknown>

    expect(Object.values(extra)).toEqual(['[redacted]'])
  })

  it('still keeps a key whose segments are all benign', () => {
    // The fold must not turn every punctuated key into a denial — that would be
    // fail-closed by accident rather than by rule, and it would destroy the
    // diagnostics this module exists to preserve.
    const extra = scrubSentryEvent({ extra: { 'view[list]': 'PROJECTS' } }).extra

    expect(extra).toEqual({ 'view[list]': 'PROJECTS' })
  })
})

describe('namespaced keys must reach the denylist the api reaches', () => {
  it('scrubs dotted OpenTelemetry keys', () => {
    // The normalizer handled camelCase but never dots, so every OTel-style key
    // missed both the set and the convention suffixes. `authorization`,
    // `content` and `transcript` are all IN the set — the set knew, the
    // normalizer could not reach them.
    const scrubbed = scrubSentryEvent(
      eventWith({
        'auth.token': 'TOKENLEAK',
        'user.content': 'CONTENTLEAK',
        'request.transcript': 'TRANSCRIPTLEAK',
        'http.request.header.authorization': 'AUTHLEAK',
      })
    )

    expect(JSON.stringify(scrubbed.extra)).not.toContain('LEAK')
  })

  it('scrubs the AI conversation, which arrives as a JSON STRING', () => {
    // The api's AiIntegration json_encodes the messages, so they land under one
    // key with nothing inside for a key denylist to walk.
    const scrubbed = scrubSentryEvent(
      eventWith({
        'gen_ai.input.messages': '[{"role":"user","content":"I led the migration"}]',
        messages: '[{"content":"my answer"}]',
      })
    )

    const encoded = JSON.stringify(scrubbed.extra)

    expect(encoded).not.toContain('I led the migration')
    expect(encoded).not.toContain('my answer')
  })
})

describe('every confidential-content key is pinned, not just the ones with a rule', () => {
  // Each of these normalises to ITSELF — its last segment is the whole key — so
  // no other rule reaches it. Deleting any one line is a live leak that the
  // whole suite would stay green through.
  it.each([
    ['text', 'Nel mio ultimo progetto ho gestito un conflitto'],
    ['explanation', 'The candidate de-escalated a peer dispute'],
    ['transcripts', 'full transcript body'],
    ['prompts', 'Score this answer'],
    ['answers', 'I led the migration'],
    ['utterances', 'ho gestito un conflitto'],
    ['contents', 'spoken content body'],
    ['messages', '[{"content":"my answer"}]'],
  ])('scrubs %s', (key, marker) => {
    const scrubbed = scrubSentryEvent(eventWith({ [key]: marker }))

    expect(JSON.stringify(scrubbed.extra)).not.toContain(marker)
  })

  it('scrubs a hyphenated header key and an acronym-leading one', () => {
    // `X-Api-Key` lowercases to `x-api-key` and `_key` cannot match across a
    // hyphen; `APIKey` has no lowercase character before the uppercase one so
    // the camelCase split never fires. Both passes existed untested.
    const scrubbed = scrubSentryEvent(
      eventWith({ 'X-Api-Key': 'HEADERLEAK', APIKey: 'ACRONYMLEAK', SSOToken: 'ACRONYMLEAK2' })
    )

    const encoded = JSON.stringify(scrubbed.extra)

    expect(encoded).not.toContain('HEADERLEAK')
    expect(encoded).not.toContain('ACRONYMLEAK')
  })
})

describe('the http context is the request under a second name', () => {
  it('cuts the query and keeps the path, like the request branch does', () => {
    // Sentry populates `contexts.http` independently of `event.request`, with
    // the same url/query shapes — and a generic key walk denies neither `url`
    // nor `query`, so the entry-link token walked out one context over from
    // where the request branch cuts it.
    const scrubbed = scrubSentryEvent({
      contexts: {
        http: {
          url: 'https://bo.test/interview/TOKENLEAK?token=TOKENLEAK',
          query: 'token=TOKENLEAK',
          method: 'GET',
        },
      },
    } as ScrubbableEvent)

    const http = (scrubbed.contexts as Record<string, Record<string, unknown>>)['http']

    expect(JSON.stringify(http)).not.toContain('TOKENLEAK')
    // The method is diagnostic and must survive — an unusable error reporter is
    // the outcome this module calls worse than a scrubbed one.
    expect(http?.['method']).toBe('GET')
    // And the URL must survive REDACTED, not dropped. Without this the test
    // passed with `url` handling deleted outright: "nothing leaked" and "the
    // diagnostic survived" are two assertions, and only one was being made.
    expect(http?.['url']).toBe('https://bo.test/interview/:token')
  })
})

describe('the carriers this half never walked while the other two did', () => {
  it('redacts a thrown message — the entry link IS a bearer credential', () => {
    // Holding the entry link starts a specific candidate's interview, and inside
    // a thrown message it has no field name for a key denylist to deny.
    const scrubbed = scrubSentryEvent({
      message: 'entry link https://beai.test/interview/TOKENLEAK rejected',
    } as ScrubbableEvent)

    expect(String(scrubbed.message)).not.toContain('TOKENLEAK')
  })

  it('redacts an exception value and walks its stacktrace frame vars', () => {
    // Frame `vars` are the function's ARGUMENTS: a call taking the interview
    // token or the transcript puts that value on the wire under its parameter
    // name — a key this module already denies.
    const scrubbed = scrubSentryEvent({
      exception: {
        values: [
          {
            value: 'entry link https://beai.test/interview/TOKENLEAK rejected',
            stacktrace: {
              frames: [
                {
                  filename: 'https://beai.test/interview/TOKENLEAK',
                  vars: { transcript: 'I once falsified a report', line: 42 },
                },
              ],
            },
          },
        ],
      },
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.exception)

    expect(encoded).not.toContain('TOKENLEAK')
    expect(encoded).not.toContain('falsified')
    // The diagnostic survives — an unusable error reporter is the worse outcome.
    const frame = (
      scrubbed.exception?.values?.[0] as {
        stacktrace?: { frames?: { vars?: Record<string, unknown> }[] }
      }
    )?.stacktrace?.frames?.[0]
    expect(frame?.vars?.['line']).toBe(42)
  })

  it('scrubs tags, transaction, fingerprint and an unrecognised top-level key', () => {
    const scrubbed = scrubSentryEvent({
      tags: { candidate_ref: 'acme-672' },
      transaction: '/interview/TOKENLEAK',
      fingerprint: ['https://beai.test/interview/TOKENLEAK'],
      custom: { candidate_ref: 'CR-99' },
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed)

    expect(encoded).not.toContain('acme-672')
    expect(encoded).not.toContain('TOKENLEAK')
    expect(encoded).not.toContain('CR-99')
  })

  it('leaves a scoped package path in a stack intact', () => {
    // The address pattern must not eat `@sentry/vue`: redactFreeText runs over
    // Error.stack, and a stack here is scoped packages all the way down.
    const stack = 'at Module.render (/app/node_modules/@sentry/vue/esm/index.js:12:5)'

    expect(redactFreeText(stack)).toBe(stack)
  })
})

describe('the keys that walked out one field over', () => {
  it('drops request.query, not only request.query_string', () => {
    // The URL got cut and the token walked out one key over in the SAME object.
    // `redactFreeText` cannot help: a bare `token=…` has no leading slash, no
    // `@` and no scheme to match on. A real participants filter is worse —
    // `q=Ada Lovelace&candidate_ref=CR-99` carries a candidate's name and a ref,
    // both keys this module already denies, as one plain string value.
    const scrubbed = scrubSentryEvent({
      request: {
        url: 'https://bo.test/interview/TOKENLEAK',
        query: 'q=Ada Lovelace&candidate_ref=CR-99',
      },
    } as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.request)

    expect(encoded).not.toContain('Ada Lovelace')
    expect(encoded).not.toContain('CR-99')
  })

  it('denies the PLURAL credential keys', () => {
    // The content keys were pluralised and the credential keys never were —
    // same list, same rule, half applied.
    const scrubbed = scrubSentryEvent(
      eventWith({
        tokens: ['T1LEAK'],
        api_keys: ['K1LEAK'],
        passwords: ['P1LEAK'],
        secrets: ['S1LEAK'],
        cookies: { session: 'SESSLEAK' },
        // A header name in NO list and matching NO convention, so only the
        // wholesale `headers` drop catches it. With `authorization` here the
        // assertion went green off a key that was already denied.
        headers: { 'x-trace-context': 'sess=HLEAK' },
      })
    )

    expect(JSON.stringify(scrubbed.extra)).not.toContain('LEAK')
  })
})

describe('a plural must never be weaker than its singular', () => {
  it('denies _keys and the bare header', () => {
    // `stripe_api_keys` was allowed while `stripe_api_key` was denied: the set
    // gained `api_keys` and the convention did not. `header` had the mirror
    // asymmetry — denied as `headers`, allowed on its own.
    const scrubbed = scrubSentryEvent(
      eventWith({
        stripe_api_keys: ['sk_live_LEAKED'],
        provider_api_keys: { openai: 'sk-LEAKED2' },
        header: 'Cookie: sess=LEAKED3',
      })
    )

    expect(JSON.stringify(scrubbed.extra)).not.toContain('LEAKED')
  })
})

describe('what a key CONTAINS, not only what it is called', () => {
  it('redacts an address used as an array key', () => {
    // Keying a map by address is the ordinary shape of a delivery-result map,
    // and the module denied `email`/`emails`/`email_address` by name then handed
    // the address over the moment it moved one position left.
    const scrubbed = scrubSentryEvent(
      eventWith({ delivery_results: { 'mario.rossi@example.test': 'bounced' } })
    )

    expect(JSON.stringify(scrubbed.extra)).not.toContain('mario.rossi@example.test')
  })

  it('drops request.env with the user context', () => {
    // The SDK builds the user bag from `env.REMOTE_ADDR`; dropping `user` while
    // keeping this kept the IP under another name.
    const scrubbed = scrubSentryEvent({
      request: { url: 'https://bo.test/x', env: { REMOTE_ADDR: '203.0.113.77' } },
    } as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.request)).not.toContain('203.0.113.77')
  })
})

describe('a RENAMED key must not leave its original behind', () => {
  it('drops the original when the key itself is rewritten', () => {
    // `next` is a spread of the event, so the original key is already on it.
    // A bare Object.assign added the scrubbed entry under the NEW name and left
    // the original sitting there — the entry_url verbatim, one key to the left
    // of its redacted twin. The twin is what made the event look scrubbed.
    const scrubbed = scrubSentryEvent({
      'https://bo.test/interview/TOKENLEAK': { entry_url: 'https://bo.test/interview/TOKENLEAK' },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed)).not.toContain('TOKENLEAK')
  })

  it('does not rename a key that merely shares a name with Object.prototype', () => {
    // `'toString' in {}` is true before anything is written, so the collision
    // guard renamed keys against a collision that did not exist — corrupting the
    // diagnostic payload, which is the failure this module argues against.
    const scrubbed = scrubSentryEvent(eventWith({ toString: 'x', constructor: 'y', valueOf: 'z' }))

    const extra = scrubbed.extra as Record<string, unknown>

    expect(extra['toString']).toBe('x')
    expect(extra['valueOf']).toBe('z')
  })
})

describe('the spreads that carried unhandled fields out', () => {
  it('scrubs a breadcrumb field that is neither data nor message', () => {
    // `ScrubbableBreadcrumb` carries an open index signature, so only `data` and
    // `message` were handled and everything else rode out on the spread —
    // `entry_url` among them, which is a bearer credential.
    const scrubbed = scrubBreadcrumb({
      category: 'ui.click',
      message: 'clicked',
      candidate_ref: 'CR-99',
      entry_url: 'https://bo.test/interview/TOKENLEAK',
    } as unknown as Parameters<typeof scrubBreadcrumb>[0])

    const encoded = JSON.stringify(scrubbed)

    expect(encoded).not.toContain('CR-99')
    expect(encoded).not.toContain('TOKENLEAK')
    // The diagnostic half survives.
    expect(scrubbed['category']).toBe('ui.click')
  })

  it('scrubs an exception WRAPPER, with or without values', () => {
    // The old guard tested a nested field, so an exception without `values` was
    // not partially scrubbed — it was not scrubbed at all.
    const withValues = scrubSentryEvent({
      exception: { candidate_ref: 'CR-77', values: [{ value: 'boom' }] },
    } as unknown as ScrubbableEvent)

    const without = scrubSentryEvent({
      exception: { candidate_ref: 'CR-66' },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(withValues.exception)).not.toContain('CR-77')
    expect(JSON.stringify(without.exception)).not.toContain('CR-66')
  })

  it('SCRUBS a malformed breadcrumbs or exception value, not merely survives it', () => {
    // Asserting `not.toThrow()` on `{a: 1}` proves nothing: the fixture carries
    // nothing to leak, so no mutation of the scrubbing path can ever turn it
    // red. These carry a real payload.
    const badBreadcrumbs = scrubSentryEvent({
      breadcrumbs: {
        0: { message: 'loaded /interview/TOKENLEAK', data: { candidate_ref: 'CR-99' } },
      },
    } as unknown as ScrubbableEvent)

    const badValues = scrubSentryEvent({
      exception: { values: ['boom /interview/TOKENLEAK for ada@acme.test'] },
    } as unknown as ScrubbableEvent)

    const badElement = scrubSentryEvent({
      breadcrumbs: ['loaded /interview/TOKENLEAK for ada@acme.test'],
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(badBreadcrumbs.breadcrumbs)).not.toContain('CR-99')
    expect(JSON.stringify(badBreadcrumbs.breadcrumbs)).not.toContain('TOKENLEAK')
    expect(JSON.stringify(badValues.exception)).not.toContain('ada@acme.test')
    expect(JSON.stringify(badElement.breadcrumbs)).not.toContain('ada@acme.test')
  })

  it('survives malformed breadcrumbs and exception values', () => {
    // `.map is not a function` thrown INSIDE beforeSend loses the event whole —
    // monitoring dying silently on the events carrying the richest context.
    expect(() =>
      scrubSentryEvent({ breadcrumbs: { a: 1 } } as unknown as ScrubbableEvent)
    ).not.toThrow()
    expect(() =>
      scrubSentryEvent({ exception: { values: 'oops' } } as unknown as ScrubbableEvent)
    ).not.toThrow()
    // The ELEMENT, not only the container: `[null]` threw on destructuring.
    expect(() =>
      scrubSentryEvent({ breadcrumbs: [null] } as unknown as ScrubbableEvent)
    ).not.toThrow()
    expect(() =>
      scrubSentryEvent({ exception: { values: [null] } } as unknown as ScrubbableEvent)
    ).not.toThrow()
  })
})

describe('one key rule, and an address that ends a sentence', () => {
  it('redacts an address at the end of a sentence and in a subdomain', () => {
    // Both shapes an address takes in prose. This pins the CURRENT pattern; it
    // does not pin any particular way of writing it — an earlier version of this
    // test claimed to, and stayed green against both spellings.
    expect(redactFreeText('write to mario.rossi@example.test.')).not.toContain('mario.rossi@')
    expect(redactFreeText('ping anna@mail.corp.example.com now')).not.toContain('anna@')
  })

  it('applies the key rule on a non-plain object too', () => {
    // `scrubRecord` had the key redaction and `scrubNonPlain` did not, so the
    // fix held for a plain object and evaporated one prototype over — and
    // `{ cause: new ApiError(...) }` is the shape scrubNonPlain exists for.
    const cause = Object.assign(new Error('boom'), {
      'carla.verdi@example.test': 'bounced',
    })

    const scrubbed = scrubSentryEvent(eventWith({ cause }))

    expect(JSON.stringify(scrubbed.extra)).not.toContain('carla.verdi@example.test')
  })
})

describe('a request body that is a raw STRING', () => {
  it('cuts it — a string has no key for the denylist to deny', () => {
    // Sentry's `request.data` is frequently a raw string, and `redactFreeText`
    // has nothing to grip on there: no slash, no `@`, no scheme. The same two
    // markers this file asserts are cut under `request.query` walked out one key
    // to the left.
    const scrubbed = scrubSentryEvent({
      request: {
        url: 'https://bo.test/x',
        data: '{"candidate_ref":"CR-99","q":"Ada Lovelace"}',
      },
    } as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.request)

    expect(encoded).not.toContain('CR-99')
    expect(encoded).not.toContain('Ada Lovelace')
  })
})

describe('the SECOND instance of every rule, which is where they went untested', () => {
  it('survives a null breadcrumb ELEMENT, not just a malformed container', () => {
    // The container guard was tested and the element guard was not. A `[null]`
    // throws on destructuring INSIDE beforeSend and loses the event whole.
    expect(() =>
      scrubSentryEvent({ breadcrumbs: [null] } as unknown as ScrubbableEvent)
    ).not.toThrow()
  })

  it('survives a null exception VALUE element', () => {
    expect(() =>
      scrubSentryEvent({ exception: { values: [null] } } as unknown as ScrubbableEvent)
    ).not.toThrow()
  })

  it('cuts request.fragment — the third name for the query', () => {
    const scrubbed = scrubSentryEvent({
      request: { url: 'https://bo.test/x', fragment: 'token=SECRETLEAK' },
    } as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.request)).not.toContain('SECRETLEAK')
  })

  it('cuts the http context fragment too, not only the request one', () => {
    const scrubbed = scrubSentryEvent({
      contexts: { http: { url: 'https://bo.test/x', fragment: 'token=SECRETLEAK' } },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.contexts)).not.toContain('SECRETLEAK')
  })

  it('drops the http context env — REMOTE_ADDR is the IP user context refuses to keep', () => {
    // The worst of the five. `REMOTE_ADDR` is not a denied key, so the generic
    // walk hands it straight through — and `user` is dropped right below
    // precisely so the client IP does not leave. The http context is the same
    // leak under a second name, which is why scrubHttpContext exists at all.
    const scrubbed = scrubSentryEvent({
      contexts: { http: { url: 'https://bo.test/x', env: { REMOTE_ADDR: '203.0.113.77' } } },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.contexts)).not.toContain('203.0.113.77')
  })
})

describe('the drops that were never pinned', () => {
  it('cuts a string OR array body on request and on the http context alike', () => {
    // `request` and `contexts.http` are the same shape under two names. A string
    // body has no key to deny; an array body walks with numeric keys, which deny
    // nothing either.
    const req = scrubSentryEvent({
      request: { url: 'https://bo.test/x', data: '{"candidate_ref":"CR-99"}' },
    } as ScrubbableEvent)

    // An ARRAY body is WALKED, not cut: `scrubBodyInner` maps its elements and
    // an OBJECT element is still scrubbed by key, so the diagnostic survives.
    // Cutting it wholesale was the wrong trade — an unusable error reporter is
    // the outcome this module calls worse than a scrubbed one.
    const arr = scrubSentryEvent({
      request: { url: 'https://bo.test/x', data: [{ candidate_ref: 'CR-9', status: 'ok' }] },
    } as unknown as ScrubbableEvent)

    const ctx = scrubSentryEvent({
      contexts: { http: { url: 'https://bo.test/x', data: '{"candidate_ref":"CR-77"}' } },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(req.request)).not.toContain('CR-99')
    expect(JSON.stringify(arr.request)).not.toContain('CR-9')
    expect(JSON.stringify(arr.request)).toContain('ok')
    expect(JSON.stringify(ctx.contexts)).not.toContain('CR-77')
  })

  it('redacts request.url, and redacts query_string, cookies and headers in place', () => {
    // The drops this file has always had, and never pinned — only the ones the
    // recent work ADDED were tested, which is the same half-applied shape the
    // comments keep naming.
    const scrubbed = scrubSentryEvent({
      request: {
        url: 'https://bo.test/interview/TOKENLEAK?token=TOKENLEAK',
        query_string: 'token=TOKENLEAK',
        cookies: { beai_refresh: 'RTLEAK' },
        headers: { 'x-trace-context': 'sess=HLEAK' },
      },
    } as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.request)

    expect(encoded).not.toContain('TOKENLEAK')
    expect(encoded).not.toContain('RTLEAK')
    expect(encoded).not.toContain('HLEAK')
  })
})

describe('shapes the module trusted and should not have', () => {
  it('survives a non-string request.url', () => {
    // `redactUrl`'s try wraps only `new URL()`; its catch calls
    // `redactAnalyticsPath`, which throws again on a non-string and propagates
    // out of beforeSend, losing the event whole. `scrubHttpContext` guards the
    // SAME field; the request branch did not.
    expect(() =>
      scrubSentryEvent({ request: { url: 123 } } as unknown as ScrubbableEvent)
    ).not.toThrow()
  })

  it('does not explode a raw string into a char-indexed map', () => {
    // `Object.entries` over a string makes every character its own key,
    // `redactFreeText` runs per character and cuts nothing, and the value
    // rejoins verbatim — the entry link and the name fully reconstructible.
    const scrubbed = scrubSentryEvent({
      extra: 'entry link https://bo.test/interview/TOKENLEAK for Ada Lovelace',
      tags: 'candidate CR-99 ada@acme.test',
    } as unknown as ScrubbableEvent)

    // REJOINED, not merely stringified: a char-indexed map does not contain the
    // marker as a substring, so `not.toContain` on the JSON passes while the
    // value is trivially reconstructible. This is the assertion that fails.
    const rejoin = (v: unknown) =>
      v !== null && typeof v === 'object' ? Object.values(v).join('') : String(v)

    expect(rejoin(scrubbed.extra)).not.toContain('TOKENLEAK')
    expect(rejoin(scrubbed.tags)).not.toContain('ada@acme.test')
  })

  it('scrubs a NON-array fingerprint, which leaked on a miss', () => {
    // Unlike the breadcrumbs guard, a miss here leaks rather than skips:
    // `fingerprint` is copied in by name and was only touched inside the
    // Array.isArray branch.
    const scrubbed = scrubSentryEvent({
      fingerprint: 'https://bo.test/interview/TOKENLEAK',
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.fingerprint)).not.toContain('TOKENLEAK')
  })
})

describe('a guard MISS on a handled field must not leak', () => {
  it('scrubs request, contexts, exception and tags when they are not objects', () => {
    // `HANDLED_EVENT_FIELDS` copies the value into the output BY NAME, so
    // falling past a type guard leaves it raw — a miss leaks rather than skips.
    // `fingerprint` already carried this reasoning; three branches did not.
    const scrubbed = scrubSentryEvent({
      request: 'url=https://bo.test/interview/TOKENLEAK candidate_ref=CR-99',
      contexts: 'candidate_ref=CR-99 ada@acme.test',
      // A URL-shaped marker: a bare word has no shape `redactFreeText` can
      // recognise, and a string field can only be redacted for what it LOOKS
      // like. The point here is that the branch runs at all.
      exception: 'entry link https://bo.test/interview/TOKENLEAK rejected',
      tags: 'candidate_ref=CR-99',
    } as unknown as ScrubbableEvent)

    const rejoin = (v: unknown) =>
      v !== null && typeof v === 'object' ? Object.values(v).join('') : String(v)

    expect(rejoin(scrubbed.request)).not.toContain('TOKENLEAK')
    expect(rejoin(scrubbed.contexts)).not.toContain('ada@acme.test')
    expect(rejoin(scrubbed.exception)).not.toContain('TOKENLEAK')
  })

  it('cuts a JSON string element inside an array body', () => {
    // An array ELEMENT has no key for the denylist either, and a JSON string
    // body inside one is the shape Sentry actually populates request.data with.
    const scrubbed = scrubSentryEvent({
      request: { url: 'https://bo.test/x', data: ['{"candidate_ref":"CR-99"}'] },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.request)).not.toContain('CR-99')
  })

  it('keeps an array breadcrumb data an ARRAY, scrubbed', () => {
    // `scrubRecord` flattened it into an index map — shape lost, payload intact.
    // A `message` in the SAME fixture: without it this test green-lit the branch
    // whose early return skipped message scrubbing entirely.
    const scrubbed = scrubBreadcrumb({
      data: ['{"candidate_ref":"CR-99"}'],
      message: 'failed https://bo.test/interview/TOKENLEAK for ada@acme.test',
    } as unknown as Parameters<typeof scrubBreadcrumb>[0])

    expect(JSON.stringify(scrubbed.data)).not.toContain('CR-99')
    expect(Array.isArray(scrubbed.data)).toBe(true)
    expect(String(scrubbed.message)).not.toContain('TOKENLEAK')
    expect(String(scrubbed.message)).not.toContain('ada@acme.test')
  })
})

describe('the third half of the plural rule', () => {
  it('denies the candidate-identifying plurals', () => {
    // The rule was applied to the credential keys and to the content keys and
    // skipped here. `redactFreeText('CR-99')` has nothing to grip on.
    const scrubbed = scrubSentryEvent(
      eventWith({
        candidate_refs: ['CR-99'],
        display_names: ['Ada Lovelace'],
        entry_urls: ['https://bo.test/interview/TOKENLEAK'],
      })
    )

    const encoded = JSON.stringify(scrubbed.extra)

    expect(encoded).not.toContain('CR-99')
    expect(encoded).not.toContain('Ada Lovelace')
    expect(encoded).not.toContain('TOKENLEAK')
  })

  it('scrubs a non-string transaction and message', () => {
    const scrubbed = scrubSentryEvent({
      transaction: { name: '/interview/TOKENLEAK' },
      message: { text: 'candidate CR-99 at ada@acme.test' },
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed)

    expect(encoded).not.toContain('TOKENLEAK')
    expect(encoded).not.toContain('ada@acme.test')
  })
})

describe('the else branch of every ternary', () => {
  it('scrubs non-string fingerprint elements and exception values', () => {
    // `typeof x === 'string' ? redact(x) : x` keeps the raw value on the else —
    // the miss-leaks shape this file names at `fingerprint` and then repeated.
    const scrubbed = scrubSentryEvent({
      fingerprint: [{ url: 'https://bo.test/interview/TOKENLEAK' }],
      exception: { values: [{ value: { text: 'entry https://bo.test/interview/TOKENLEAK' } }] },
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed)

    expect(encoded).not.toContain('TOKENLEAK')
  })

  it('survives a non-string request url rather than throwing', () => {
    // `redactFreeText` has a non-string fallthrough and `redactUrl` did not.
    expect(() =>
      scrubSentryEvent({ request: { url: { href: 'x' } } } as unknown as ScrubbableEvent)
    ).not.toThrow()
  })
})

describe('the branches the fixes added, each pinned', () => {
  it('cuts a JSON string ELEMENT of an array body while walking object elements', () => {
    const scrubbed = scrubSentryEvent({
      request: {
        url: 'https://bo.test/x',
        data: ['{"candidate_ref":"CR-99"}', { candidate_ref: 'CR-77', status: 'ok' }],
      },
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.request)

    expect(encoded).not.toContain('CR-99')
    expect(encoded).not.toContain('CR-77')
    expect(encoded).toContain('ok')
  })

  it('denies entry_urls, the plural of the bearer credential', () => {
    const scrubbed = scrubSentryEvent(
      eventWith({ entry_urls: ['https://bo.test/interview/TOKENLEAK'] })
    )

    expect(JSON.stringify(scrubbed.extra)).not.toContain('TOKENLEAK')
  })

  it("redacts an Error's NAME, not only its message", () => {
    // A custom `this.name = `NotFound: ${email}`` is reachable, and `name` was
    // the one field of the Error branch bypassing the free-text pass.
    const err = new Error('boom')
    err.name = 'NotFound: ada@acme.test'

    const scrubbed = scrubSentryEvent(eventWith({ cause: err }))

    expect(JSON.stringify(scrubbed.extra)).not.toContain('ada@acme.test')
  })

  it('redactUrl is safe called directly with a non-string — it is exported', () => {
    expect(() => redactUrl(123 as unknown as string)).not.toThrow()
  })

  it('gives contexts.response the request rules, like contexts.http', () => {
    // `response` carries the same shapes under a third name.
    const scrubbed = scrubSentryEvent({
      contexts: {
        response: {
          headers: { 'x-trace-context': 'sess=HLEAK' },
          cookies: { beai_refresh: 'RTLEAK' },
        },
      },
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.contexts)

    expect(encoded).not.toContain('HLEAK')
    expect(encoded).not.toContain('RTLEAK')
  })
})

describe('the four rules nothing had pinned', () => {
  it('denies entry_urls by KEY, not by the URL shape of its value', () => {
    // With a URL value the free-text pass redacts it anyway, so deleting the
    // key rule stayed green. A bare token has no shape to grip on: only the key
    // can catch it.
    const scrubbed = scrubSentryEvent(eventWith({ entry_urls: ['OPAQUETOKEN99'] }))

    expect(JSON.stringify(scrubbed.extra)).not.toContain('OPAQUETOKEN99')
  })

  it('keeps BOTH redacted sibling keys, not one', () => {
    // Drop the collision suffix and the second value vanishes silently — the
    // diagnostic loss the helper's docblock says it exists to prevent.
    const scrubbed = scrubSentryEvent(
      eventWith({ delivery: { 'ada@x.test': 'first', 'bob@y.test': 'second' } })
    )

    const delivery = (scrubbed.extra as Record<string, Record<string, unknown>>)['delivery']

    expect(Object.keys(delivery ?? {})).toHaveLength(2)
    expect(JSON.stringify(delivery)).not.toContain('@x.test')
  })

  it('walks a Map and a Set rather than shipping them raw', () => {
    const scrubbed = scrubSentryEvent(
      eventWith({
        m: new Map([['candidate_ref', 'CR-99']]),
        s: new Set(['https://bo.test/interview/TOKENLEAK']),
      })
    )

    const extra = scrubbed.extra as Record<string, unknown>

    // The SHAPE, because JSON.stringify erases both containers.
    expect(extra['m']).toEqual({ candidate_ref: '[redacted]' })
    // A Set ELEMENT is keyless, so under `extra` — which is on the body rule —
    // it is CUT rather than reduced to its origin. There is no key to deny.
    expect(extra['s']).toEqual(['[redacted]'])
  })

  it('keeps an Error cause chain, scrubbed', () => {
    // `cause` is own but NON-enumerable, so `Object.entries` missed it — the
    // very case `isPlainWalkable`'s docblock names as its motivation.
    const err = new Error('outer', { cause: new Error('failed on ada@acme.test') })

    const scrubbed = scrubSentryEvent(eventWith({ cause: err }))
    const encoded = JSON.stringify(scrubbed.extra)

    expect(encoded).toContain('cause')
    expect(encoded).not.toContain('ada@acme.test')
  })

  it('treats a non-string url the same on both request and http context', () => {
    const req = scrubSentryEvent({
      request: { url: { href: 'https://x.test/participants/42' } },
    } as unknown as ScrubbableEvent)

    const ctx = scrubSentryEvent({
      contexts: { http: { url: { href: 'https://x.test/participants/42' } } },
    } as unknown as ScrubbableEvent)

    expect((req.request as Record<string, unknown>)?.['url']).toBe('[redacted]')
    expect((ctx.contexts as Record<string, Record<string, unknown>>)?.['http']?.['url']).toBe(
      '[redacted]'
    )
  })
})

describe('a literal unset misses every other spelling', () => {
  it('denies queryString and Query-String, and everywhere not just on request', () => {
    // `unset` matches a literal key at two sites. The LIST runs through the
    // normalizer, which folds camelCase and hyphens — and applies in `extra`,
    // `tags`, a non-http context and `breadcrumb.data` alike.
    const scrubbed = scrubSentryEvent({
      request: { url: 'https://bo.test/x', queryString: 'token=TOKENLEAK' },
      extra: { 'Query-String': 'token=TOKENLEAK', env: { REMOTE_ADDR: '203.0.113.77' } },
      contexts: { custom: { fragment: 'token=TOKENLEAK' } },
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed)

    expect(encoded).not.toContain('TOKENLEAK')
    expect(encoded).not.toContain('203.0.113.77')
  })

  it('survives a non-string Error name or message', () => {
    const err = new Error('boom')
    Object.defineProperty(err, 'name', { value: { weird: 1 }, configurable: true })

    expect(() => scrubSentryEvent(eventWith({ cause: err }))).not.toThrow()
  })
})

describe('what the measurements settled', () => {
  it('scans a long hostile string in linear time', () => {
    // Unanchored, the local part re-ran from every start position: 24ms at 10k,
    // 393ms at 40k, 1,544ms at 80k — a second and a half of main-thread freeze
    // inside beforeSend. The leading lookbehind makes each start O(1) to reject.
    const hostile = 'x@' + 'a'.repeat(80_000)
    const started = performance.now()

    redactFreeText(hostile)

    expect(performance.now() - started).toBeLessThan(250)
  })

  it('redacts an address sitting in a URL PATH', () => {
    // `redactAnalyticsPath` collapses the segments it knows; an address in one
    // it does not survives, and a URL is client-controlled.
    expect(redactUrl('https://bo.test/participants/jane@acme.test/transcript')).not.toContain(
      'jane@acme.test'
    )
  })

  it('walks a Map by its ENTRIES, which a raw spread cannot reach', () => {
    // A bare token has no shape the free-text pass can grip, so only the Map
    // branch can catch it — with a URL value the test passed either way.
    const scrubbed = scrubSentryEvent(eventWith({ m: new Map([['candidate_ref', 'OPAQUEREF77']]) }))

    expect(JSON.stringify(scrubbed.extra)).not.toContain('OPAQUEREF77')
  })

  it('keeps the cause CHAIN, scrubbed by key', () => {
    // A bare ref inside the cause: only the walk reaches it.
    const err = new Error('outer', {
      cause: Object.assign(new Error('inner'), { candidate_ref: 'OPAQUEREF88' }),
    })

    const scrubbed = scrubSentryEvent(eventWith({ cause: err }))
    const encoded = JSON.stringify(scrubbed.extra)

    expect(encoded).toContain('cause')
    expect(encoded).not.toContain('OPAQUEREF88')
  })
})

describe('each branch pinned on its own, not jointly', () => {
  it('redacts an address in a path segment redactAnalyticsPath does NOT know', () => {
    // `/participants/:id` is collapsed by the path rule, so an address there
    // proves nothing about the address pass. `/downloads/` is not a rule it has.
    expect(redactUrl('https://bo.test/downloads/jane@acme.test/report.pdf')).not.toContain(
      'jane@acme.test'
    )
  })

  it('walks a Map', () => {
    const scrubbed = scrubSentryEvent(eventWith({ m: new Map([['candidate_ref', 'MAPREF77']]) }))

    expect(JSON.stringify(scrubbed.extra)).not.toContain('MAPREF77')
  })

  it('walks a Set into a scrubbed ARRAY', () => {
    // NOT via JSON.stringify: `JSON.stringify(new Set([...]))` is `{}`, so the
    // payload can never appear in the encoding — walked or not. The assertion
    // was true before the branch existed and true after it.
    const scrubbed = scrubSentryEvent(
      eventWith({ s: new Set(['https://bo.test/interview/SETLEAK88']) })
    )

    const walked = (scrubbed.extra as Record<string, unknown>)['s']

    expect(Array.isArray(walked)).toBe(true)
    expect(walked).toEqual(['[redacted]'])
  })

  it('keeps the cause CHAIN itself, which Object.entries cannot see', () => {
    // `cause` is own but NON-enumerable. Asserting on a value the outer walk
    // would reach anyway proves nothing — this asserts the chain is PRESENT.
    const err = new Error('outer', { cause: new Error('inner detail') })

    const scrubbed = scrubSentryEvent(eventWith({ cause: err }))
    const cause = (scrubbed.extra as Record<string, Record<string, unknown>>)?.['cause']

    expect(cause?.['cause']).toBeDefined()
  })

  it('denies a bare `query` key, not only `query_string`', () => {
    const scrubbed = scrubSentryEvent(eventWith({ query: 'token=QUERYLEAK99' }))

    expect(JSON.stringify(scrubbed.extra)).not.toContain('QUERYLEAK99')
  })
})

describe('the diagnostics the scrubber must not destroy', () => {
  it('keeps a stack usable — frames, not origins', () => {
    // `redactFreeText` reduces a URL to its bare origin, which strips filename,
    // line and column off EVERY frame. `scrubStacktrace` litigates exactly this
    // and fixes it for exception frames; the Error branch never got it.
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at f (https://bo.test/_nuxt/D1abc.js:12:3)'

    const scrubbed = scrubSentryEvent(eventWith({ cause: err }))
    const stack = String(
      (scrubbed.extra as Record<string, Record<string, unknown>>)?.['cause']?.['stack']
    )

    expect(stack).toContain('_nuxt/D1abc.js')
  })

  it('walks a Map under breadcrumb.data instead of flattening it', () => {
    // `scrubRecord` on a Map yields `{}` — the shape lost and nothing scrubbed.
    const scrubbed = scrubBreadcrumb({
      data: new Map([
        ['candidate_ref', 'BCREF99'],
        ['note', 'kept'],
      ]),
    } as unknown as Parameters<typeof scrubBreadcrumb>[0])

    const encoded = JSON.stringify(scrubbed.data)

    expect(encoded).not.toContain('BCREF99')
    expect(encoded).toContain('kept')
  })

  it('survives a throwing accessor rather than losing the event', () => {
    // `Object.entries` INVOKES getters, and a computed one on a Vue reactive
    // graph can throw — inside beforeSend, which loses the event whole.
    const hostile = {
      get boom(): string {
        throw new Error('nope')
      },
    }

    const scrubbed = scrubSentryEvent(eventWith({ bad: hostile }))

    // What the guard RETURNS, not merely that it returns. Replacing the catch
    // body with the raw object — the leak — left `not.toThrow()` green.
    expect(JSON.stringify(scrubbed.extra)).toContain('[redacted]')
  })

  it('redactFreeText is safe called directly with a non-string', () => {
    expect(() => redactFreeText(123 as unknown as string)).not.toThrow()
  })
})

describe('one rule for a raw string, wherever it sits', () => {
  it('cuts a JSON blob under extra and tags, not only under request.data', () => {
    // `redactFreeText` only catches what it RECOGNISES — a URL or an address.
    // A JSON blob of `candidate_ref` has neither and rejoined verbatim, while
    // the identical string under `request.data` was cut.
    const scrubbed = scrubSentryEvent({
      extra: '{"candidate_ref":"EXTRAREF99"}',
      tags: '{"display_name":"Ada Lovelace"}',
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed)

    expect(encoded).not.toContain('EXTRAREF99')
    expect(encoded).not.toContain('Ada Lovelace')
  })
})

describe('the two branches the last round left unpinned', () => {
  it('redacts an address in a RELATIVE path, not only an absolute URL', () => {
    // `redactUrl`'s catch branch — a bare path, the Vue Router breadcrumb shape
    // — runs the address pass too. Only the absolute exit was covered.
    expect(redactUrl('/downloads/jane@acme.test/report.pdf')).not.toContain('jane@acme.test')
  })

  it('survives a throwing getter on a NON-plain object', () => {
    // The guard in `scrubNonPlain`, distinct from the one in `scrubRecord`: an
    // Error or a class instance carrying a computed accessor that throws.
    const hostile = new Error('boom')

    Object.defineProperty(hostile, 'boom', {
      get() {
        throw new Error('nope')
      },
      enumerable: true,
    })

    const scrubbed = scrubSentryEvent(eventWith({ cause: hostile }))

    expect(JSON.stringify(scrubbed.extra)).toContain('[redacted]')
  })
})

describe('pinned on the branch delta, not on what another rule already cuts', () => {
  it('cuts a string data body under contexts.response', () => {
    // `headers`/`cookies` are denied by name, so asserting on those passes with
    // the whole branch deleted. The string `data` body IS the branch's delta.
    const scrubbed = scrubSentryEvent({
      contexts: { response: { data: '{"candidate_ref":"RESPREF99"}' } },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.contexts)).not.toContain('RESPREF99')
  })

  it('cuts a string data body under ANY context, not only the request-shaped two', () => {
    // Decided rather than discovered: a `data` key is a body wherever it sits.
    const scrubbed = scrubSentryEvent({
      contexts: { state: { data: '{"candidate_ref":"STATEREF88"}' } },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.contexts)).not.toContain('STATEREF88')
  })

  it('scrubs a NON-string breadcrumb message', () => {
    // The event-level twin is pinned; this one was not — the same rule, half
    // applied, which is the pattern this file keeps naming about itself.
    const scrubbed = scrubBreadcrumb({
      message: { candidate_ref: 'BCMSG77', u: 'https://bo.test/interview/BCTOKEN9' },
    } as unknown as Parameters<typeof scrubBreadcrumb>[0])

    const encoded = JSON.stringify(scrubbed.message)

    expect(encoded).not.toContain('BCMSG77')
    expect(encoded).not.toContain('BCTOKEN9')
  })

  it('anchors the address pass inside a URL path too', () => {
    // Without the lookbehind the scan restarts from every position — the same
    // deletion that is pinned on the prose pattern.
    const started = performance.now()

    redactUrl('/downloads/' + 'a'.repeat(60_000))

    expect(performance.now() - started).toBeLessThan(250)
  })
})

describe('the fast path and the miss path must answer the same', () => {
  it('redacts what trails the placeholder on a route HIT', () => {
    // `redactAnalyticsPath` keeps the trailing remainder verbatim, so the fast
    // path returned it raw: everything after `:id` never reached the address or
    // URL passes, while `redactUrl` — same threat model — cut it.
    // This app's route shape is `/interview/<token>`; `/participants` belongs to
    // the backoffice half and its path rule does not know it.
    const withAddress = redactFreeText('/interview/TOK123/notes/jane@acme.test')
    const withLink = redactFreeText('/interview/TOK123/x/https://bo.test/interview/FASTTOKEN')

    expect(withAddress).not.toContain('TOK123')
    expect(withAddress).not.toContain('jane@acme.test')
    expect(withLink).not.toContain('FASTTOKEN')
  })

  it('gives contexts.response its URL rules, which is its actual delta', () => {
    // The string `data` body is cut for EVERY context by the generic pre-pass,
    // so asserting that pinned nothing. `url` is what `response` adds.
    const scrubbed = scrubSentryEvent({
      contexts: { response: { url: 'https://bo.test/interview/RESPTOKEN?q=Ada' } },
    } as unknown as ScrubbableEvent)

    const url = String(
      (scrubbed.contexts as Record<string, Record<string, unknown>>)?.['response']?.['url']
    )

    expect(url).not.toContain('q=Ada')
    expect(url).not.toContain('RESPTOKEN')
    expect(url).toContain(':token')
  })

  it('does not invent keys the event never had', () => {
    const scrubbed = scrubSentryEvent({ message: 'hi' })

    // `user` is DELETED, not set to undefined — which is what its comment always
    // claimed and what `Object.keys` now shows.
    expect(Object.keys(scrubbed)).toEqual(['message'])
  })

  it('does not invent a url on a request that never had one', () => {
    const scrubbed = scrubSentryEvent({ request: { method: 'POST' } })

    // Every other `request` fixture in this suite carries a `url`, so the branch
    // had never been asked this question and spread `{ url: undefined }`.
    // `Object.keys` is the assertion that can see it — `toHaveProperty` and
    // `toEqual` both pass on an own key whose value is `undefined`.
    expect(Object.keys(scrubbed.request as object)).toEqual(['method'])
  })

  it('agrees with scrubHttpContext on a request with no url', () => {
    // The helper was extracted to match this branch. When they disagree on the
    // same input, one of them is wrong and nothing says which.
    const request = scrubSentryEvent({ request: { method: 'POST' } }).request
    const context = scrubSentryEvent({
      contexts: { http: { method: 'POST' } },
    }).contexts?.http

    expect(Object.keys(request as object)).toEqual(Object.keys(context as object))
  })
})

describe('the body rule holds at every depth, not only the first', () => {
  const BODY = '{"candidate_ref":"DEPTHREF99","q":"Ada Lovelace"}'

  it.each([
    ['extra, depth 1', { extra: [BODY] }],
    ['extra, nested in an envelope', { extra: { items: [BODY] } }],
    ['extra, array of arrays', { extra: [[BODY]] }],
    ['request.data envelope', { request: { url: 'https://bo.test/x', data: { items: [BODY] } } }],
    ['http context, array of arrays', { contexts: { http: { data: [[BODY]] } } }],
    ['any other context envelope', { contexts: { vue: { data: { items: [BODY] } } } }],
    ['tags envelope', { tags: { items: [BODY] } }],
  ])('cuts a keyless JSON body in %s', (_name, event) => {
    // `{items: […]}` is the ordinary envelope of a paginated list response —
    // the single most likely thing under request.data on the participants page.
    const scrubbed = scrubSentryEvent(event as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed)).not.toContain('DEPTHREF99')
    expect(JSON.stringify(scrubbed)).not.toContain('Ada Lovelace')
  })

  it('still keeps a plain string under a NAMED key', () => {
    // A key the denylist can deny is not the same as no key at all.
    const scrubbed = scrubSentryEvent({
      request: { url: 'https://bo.test/x', data: { items: [{ status: 'ok' }] } },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.request)).toContain('ok')
  })

  it('survives a circular body', () => {
    const loop: Record<string, unknown> = {}
    loop['self'] = loop

    expect(() =>
      scrubSentryEvent({ request: { url: 'https://bo.test/x', data: loop } } as ScrubbableEvent)
    ).not.toThrow()
  })
})

describe('the last three gaps', () => {
  it('denies the participants filter key', () => {
    // `q` is free text carrying the candidate's name — the reason the query
    // string drops wholesale — and the key itself was never denied.
    const scrubbed = scrubSentryEvent(eventWith({ q: 'Ada Lovelace' }))

    expect(JSON.stringify(scrubbed.extra)).not.toContain('Ada Lovelace')
  })

  it('keeps an ARRAY request an array rather than an index map', () => {
    // `typeof [] === 'object'`, so it took the map branch and came out
    // `{"0":{…}}` — shape lost. Same class `scrubBody` fixed one function over.
    const scrubbed = scrubSentryEvent({
      request: [{ candidate_ref: 'ARRREF99', method: 'GET' }],
    } as unknown as ScrubbableEvent)

    expect(Array.isArray(scrubbed.request)).toBe(true)
    expect(JSON.stringify(scrubbed.request)).not.toContain('ARRREF99')
  })

  it('survives a throwing getter at the ENTRY point', () => {
    const hostile = {
      get extra(): unknown {
        throw new Error('nope')
      },
    }

    const scrubbed = scrubSentryEvent(hostile as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed)).toContain('[redacted]')
  })
})

describe('the KEY is the only guard in these shapes', () => {
  // `extra` routes through `scrubBody`, whose keyless rule cuts array elements
  // regardless of the key — so an assertion on `{extra: {tokens: ['T1']}}`
  // proves the body rule, not the denylist entry. These three shapes have no
  // keyless rule to fall back on.
  const KEYS = ['tokens', 'passwords', 'secrets', 'candidate_refs', 'display_names', 'entry_urls']

  it.each(KEYS)('denies %s as a SCALAR under extra', (key) => {
    const scrubbed = scrubSentryEvent(eventWith({ [key]: 'KEYONLY99' }))

    expect(JSON.stringify(scrubbed.extra)).not.toContain('KEYONLY99')
  })

  it.each(KEYS)('denies %s under an unhandled top-level field', (key) => {
    const scrubbed = scrubSentryEvent({
      custom: { [key]: ['KEYONLY99'] },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed)).not.toContain('KEYONLY99')
  })

  it.each(KEYS)('denies %s on a breadcrumb rest field', (key) => {
    const scrubbed = scrubBreadcrumb({
      category: 'x',
      [key]: ['KEYONLY99'],
    } as unknown as Parameters<typeof scrubBreadcrumb>[0])

    expect(JSON.stringify(scrubbed)).not.toContain('KEYONLY99')
  })
})

describe('the guards the eventWith helper never reaches', () => {
  it('survives a throwing getter under an unhandled field', () => {
    // `eventWith()` puts every fixture under `extra`, which routes through
    // `scrubBody` — so `scrubRecord`'s own guard was never exercised.
    const hostile = {
      custom: {
        nested: {
          get boom(): string {
            throw new Error('x')
          },
        },
      },
    }

    const scrubbed = scrubSentryEvent(hostile as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed)).toContain('[redacted]')
  })

  it('survives a throwing getter under request', () => {
    const hostile = {
      request: {
        url: '/x',
        meta: {
          get boom(): string {
            throw new Error('x')
          },
        },
      },
    }

    const scrubbed = scrubSentryEvent(hostile as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed)).toContain('[redacted]')
  })

  it('treats a SHARED reference as shared, not circular', () => {
    // The ancestor-path guard releases on the way back up. As a visited set it
    // returned `b` as `[circular]` — the regression the docblock says was
    // already made once and fixed.
    const shared = { note: 'kept' }
    const scrubbed = scrubSentryEvent({
      custom: { a: shared, b: shared },
    } as unknown as ScrubbableEvent)

    const custom = (scrubbed as Record<string, Record<string, unknown>>)['custom']

    expect(custom?.['b']).toEqual({ note: 'kept' })
  })

  it('SCRUBS the exception wrapper rather than dropping it', () => {
    const scrubbed = scrubSentryEvent({
      exception: { mechanism: { type: 'onerror' }, candidate_ref: 'WRAPREF99', values: [] },
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.exception)

    expect(encoded).not.toContain('WRAPREF99')
    expect(encoded).toContain('onerror')
  })
})

describe('what outranks the walk, and what the walk cannot write', () => {
  it('denies an own toJSON — normalize() prefers it AFTER beforeSend', () => {
    // `@sentry/core`'s `normalize()` runs downstream of this callback and calls
    // `value.toJSON()` in preference to walking own props. A method closing over
    // unscrubbed data therefore outranked the entire scrubber.
    const carrier = {
      row: {
        id: 7,
        toJSON: () => ({ candidate_ref: 'TOJSON99', email: 'jane@acme.test' }),
      },
    }

    const scrubbed = scrubSentryEvent(eventWith(carrier))
    const row = (scrubbed.extra as Record<string, Record<string, unknown>>)?.['row']

    expect(typeof row?.['toJSON']).not.toBe('function')
    expect(JSON.stringify(row)).not.toContain('TOJSON99')
  })

  it('keeps a __proto__ entry instead of swallowing it', () => {
    // Plain assignment invokes the prototype setter, so the entry vanishes and
    // the accumulator's prototype is quietly swapped. `JSON.parse` produces
    // exactly this key.
    const parsed = JSON.parse('{"__proto__":{"candidate_ref":"PROTO99"},"keep":"ok"}') as Record<
      string,
      unknown
    >

    const scrubbed = scrubSentryEvent({ custom: parsed } as unknown as ScrubbableEvent)
    const custom = (scrubbed as Record<string, Record<string, unknown>>)['custom']

    expect(Object.keys(custom ?? {})).toContain('__proto__')
    expect(JSON.stringify(custom)).not.toContain('PROTO99')
  })
})

describe('a toJSON on the PROTOTYPE outranks the walk too', () => {
  it('shadows an inherited toJSON', () => {
    // `Object.entries` sees only own props, and `scrubNonPlain` deliberately
    // preserves the prototype — so a class method closing over unscrubbed data
    // survived exactly as an own one did.
    class Row {
      id = 7

      toJSON(): Record<string, string> {
        return { candidate_ref: 'PROTOJSON99', email: 'jane@acme.test' }
      }
    }

    const scrubbed = scrubSentryEvent(eventWith({ row: new Row() }))
    const row = (scrubbed.extra as Record<string, Record<string, unknown>>)?.['row']

    expect(typeof (row as { toJSON?: unknown })?.toJSON).not.toBe('function')
    expect(JSON.stringify(row)).not.toContain('PROTOJSON99')
  })
})

describe('__proto__ survives every write path, not just one', () => {
  it('keeps a __proto__ entry on a NON-PLAIN object, preserving its prototype', () => {
    // The fourth write path. Plain assignment there also SWAPPED the prototype,
    // which falsifies `scrubNonPlain`'s own promise that `instanceof` still
    // holds — and the inherited-toJSON check that runs afterwards then inspects
    // the swapped prototype, not the class's.
    const err = new Error('boom')

    Object.defineProperty(err, '__proto__', {
      value: { candidate_ref: 'NONPLAIN99' },
      enumerable: true,
      configurable: true,
    })

    const scrubbed = scrubSentryEvent(eventWith({ cause: err }))
    const cause = (scrubbed.extra as Record<string, unknown>)['cause']

    expect(cause).toBeInstanceOf(Error)
    expect(JSON.stringify(cause)).not.toContain('NONPLAIN99')
  })

  it.each([
    ['an unhandled top-level field', 'custom'],
    ['a context', 'contexts'],
  ])('keeps a __proto__ entry under %s', (_name, field) => {
    // `Object.assign` and plain assignment both invoke the prototype setter for
    // that key name, so the entry vanishes — the hole `defineOwn` closed in one
    // walker and left open in the neighbouring write.
    const parsed = JSON.parse('{"__proto__":{"candidate_ref":"PATH99"},"keep":"ok"}') as Record<
      string,
      unknown
    >

    const scrubbed = scrubSentryEvent({
      [field]: field === 'contexts' ? { app: parsed } : parsed,
    } as unknown as ScrubbableEvent)

    // SURVIVAL, which is what the block is named for. `not.toContain` passes
    // just as happily when the entry is silently dropped — the exact failure
    // `defineOwn` exists to prevent.
    const container = (
      field === 'contexts'
        ? (scrubbed.contexts as Record<string, Record<string, unknown>>)?.['app']
        : (scrubbed as Record<string, Record<string, unknown>>)['custom']
    ) as Record<string, unknown>

    expect(Object.keys(container ?? {})).toContain('__proto__')
    expect(JSON.stringify(scrubbed)).not.toContain('PATH99')
  })
})

describe('the last two write paths', () => {
  it('keeps a __proto__ entry inside a BODY', () => {
    // `scrubBodyInner`'s own write path — the body walk has its own accumulator.
    const parsed = JSON.parse('{"__proto__":{"candidate_ref":"BODY99"},"keep":"ok"}') as Record<
      string,
      unknown
    >

    const scrubbed = scrubSentryEvent({
      request: { url: 'https://bo.test/x', data: { items: [parsed] } },
    } as unknown as ScrubbableEvent)

    const item = (
      (scrubbed.request as Record<string, Record<string, unknown[]>>)?.['data']?.[
        'items'
      ] as Record<string, unknown>[]
    )?.[0]

    expect(Object.keys(item ?? {})).toContain('__proto__')
    expect(JSON.stringify(scrubbed.request)).not.toContain('BODY99')
  })

  it('redacts an Error name that lives on the PROTOTYPE', () => {
    // Assigning `err.name` creates an OWN enumerable property that
    // `Object.entries` already catches, so that shape pinned nothing. The line
    // is load-bearing only when the name is inherited.
    class ApiError extends Error {}
    ApiError.prototype.name = 'ApiError for jane@acme.test'

    const scrubbed = scrubSentryEvent(eventWith({ cause: new ApiError('boom') }))
    const cause = (scrubbed.extra as Record<string, Record<string, unknown>>)?.['cause']

    expect(String(cause?.['name'])).not.toContain('jane@acme.test')
  })
})

describe('every branch, on the input that distinguishes it', () => {
  it('scrubs the exception VALUE wrapper, not just its known fields', () => {
    const scrubbed = scrubSentryEvent({
      exception: {
        values: [{ type: 'FetchError', candidate_ref: 'EXCREF99', value: 'boom' }],
      },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.exception)).not.toContain('EXCREF99')
  })

  it.each([
    ['request', (g: object) => ({ request: g })],
    ['exception', (g: object) => ({ exception: g })],
    ['exception values', (g: object) => ({ exception: { values: [g] } })],
    ['contexts', (g: object) => ({ contexts: g })],
  ])('survives a throwing getter in a rest-spread on %s', (_name, build) => {
    // A rest spread INVOKES getters exactly as `Object.entries` does, and the
    // guards all sat on the latter.
    const hostile = {
      get boom(): string {
        throw new Error('nope')
      },
    }

    expect(() => scrubSentryEvent(build(hostile) as unknown as ScrubbableEvent)).not.toThrow()
  })

  it('survives a throwing getter on a breadcrumb', () => {
    const hostile = {
      get boom(): string {
        throw new Error('nope')
      },
    }

    expect(() =>
      scrubBreadcrumb(hostile as unknown as Parameters<typeof scrubBreadcrumb>[0])
    ).not.toThrow()
  })

  it('redacts the navigation breadcrumb to and from, not only url', () => {
    // `to`/`from` is what @sentry/vue's router integration emits — the single
    // most common breadcrumb in this app.
    const scrubbed = scrubBreadcrumb({
      category: 'navigation',
      data: { from: '/participants/42?q=NAVLEAK', to: '/interview/NAVTOKEN' },
    } as unknown as Parameters<typeof scrubBreadcrumb>[0])

    const encoded = JSON.stringify(scrubbed.data)

    expect(encoded).not.toContain('NAVLEAK')
    expect(encoded).not.toContain('NAVTOKEN')
  })

  it('cuts the query string off a frame URL in a stack', () => {
    // `redactStack`'s delta over the path pass is exactly the query string.
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at f (https://bo.test/_nuxt/a.js?token=STACKLEAK:1:2)'

    const scrubbed = scrubSentryEvent(eventWith({ cause: err }))

    expect(JSON.stringify(scrubbed.extra)).not.toContain('STACKLEAK')
  })

  it('keeps a Date a Date rather than flattening it to {}', () => {
    const scrubbed = scrubSentryEvent(eventWith({ when: new Date(0) }))

    // NOT `toBeInstanceOf` alone. The fallback walk builds
    // `Object.create(Date.prototype)`, and a hollow prototype-only clone IS
    // `instanceof Date` — it just has no `[[DateValue]]` slot, so the
    // serialised event carries `{"toJSON":"[redacted]"}` instead of the
    // timestamp. That is the flattening this test's title says it prevents,
    // and only the VALUE can see it.
    expect((scrubbed.extra as Record<string, unknown>)['when']).toBeInstanceOf(Date)
    expect(JSON.stringify(scrubbed.extra)).toContain('1970-01-01T00:00:00.000Z')
  })
})

describe('the URL sink answers like its twin', () => {
  it('cuts a reset credential the anchored rule does not name', () => {
    // `redactFreeText` was fixed for exactly this and pinned; `redactUrl` — the
    // PRIMARY url sink — got none of it. Two functions, one threat model.
    // `/x/interview/…` — this app's route shape behind a prefix the anchored
    // rule does not anticipate. `/reset-password` belongs to the backoffice.
    expect(redactUrl('/x/interview/LIVE-TOKEN')).not.toContain('LIVE-TOKEN')
    expect(redactFreeText('/x/interview/LIVE-TOKEN')).not.toContain('LIVE-TOKEN')
  })

  it('cuts it through a navigation breadcrumb too', () => {
    const scrubbed = scrubBreadcrumb({
      category: 'navigation',
      data: { to: '/x/interview/LIVE-TOKEN' },
    } as unknown as Parameters<typeof scrubBreadcrumb>[0])

    expect(JSON.stringify(scrubbed.data)).not.toContain('LIVE-TOKEN')
  })

  it('survives a non-enumerable throwing accessor on a breadcrumb url', () => {
    // Invisible to `safeClone` and `Object.entries`, so neither existing guard
    // fires — the two raw reads needed their own.
    const data: Record<string, unknown> = {}

    Object.defineProperty(data, 'to', {
      get() {
        throw new Error('boom')
      },
      enumerable: false,
      configurable: true,
    })

    expect(() =>
      scrubBreadcrumb({ data } as unknown as Parameters<typeof scrubBreadcrumb>[0])
    ).not.toThrow()
  })
})

describe('a multi-word denied key behind a prefix', () => {
  it.each([
    'candidate_ref',
    'candidate_refs',
    'display_name',
    'display_names',
    'entry_url',
    'entry_urls',
    'key_hash',
    'query_string',
  ])('denies %s under a namespaced prefix', (key) => {
    // The last-segment rule took only the text after the FINAL underscore, so no
    // two-word entry was reachable behind a prefix — and that is the
    // candidate-identifying half of the list.
    const scrubbed = scrubSentryEvent(eventWith({ [`participant.${key}`]: 'PREFIX99' }))

    expect(JSON.stringify(scrubbed.extra)).not.toContain('PREFIX99')
  })

  it('denies the camelCase spelling behind a prefix too', () => {
    const scrubbed = scrubSentryEvent({
      tags: { 'participant.candidateRef': 'CAMEL99', 'vue.propsData.displayName': 'Ada Lovelace' },
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.tags)

    expect(encoded).not.toContain('CAMEL99')
    expect(encoded).not.toContain('Ada Lovelace')
  })

  it.each([
    [
      'an Error under request.data',
      (body: unknown): Record<string, unknown> => {
        class ApiError extends Error {
          constructor(
            message: string,
            readonly items: unknown
          ) {
            super(message)
          }
        }

        return { request: { url: 'https://bo.test/x', data: new ApiError('boom', [body]) } }
      },
    ],
    [
      'an Error inside an extra array',
      (body: unknown): Record<string, unknown> => {
        class ApiError extends Error {
          constructor(
            message: string,
            readonly items: unknown
          ) {
            super(message)
          }
        }

        return { extra: { list: [new ApiError('boom', [body])] } }
      },
    ],
    [
      'a null-prototype request body',
      (body: unknown): Record<string, unknown> => {
        const bare = Object.create(null) as Record<string, unknown>

        bare['items'] = [body]

        return { request: { url: 'https://bo.test/x', data: bare } }
      },
    ],
    [
      'a Set carried BY an Error',
      (body: unknown): Record<string, unknown> => {
        class ApiError extends Error {
          constructor(
            message: string,
            readonly items: unknown
          ) {
            super(message)
          }
        }

        return {
          request: { url: 'https://bo.test/x', data: new ApiError('boom', new Set([body])) },
        }
      },
    ],
  ])(
    'keeps the body rule transitive through %s',
    (_name, build: (body: unknown) => ScrubbableEvent) => {
      // The body rule used to stop dead at the first non-plain object, because
      // `scrubBodyInner` delegated to `scrubValue` and `scrubValue` walked the
      // children with the GENERAL rule. `{items: [BODY]}` was cut and
      // `{err: new ApiError('boom', [BODY])}` shipped the identical blob
      // verbatim — and an Error is the likeliest non-plain object in a payload.
      const body = '{"candidate_ref":"CR-99","q":"Ada Lovelace"}'

      const scrubbed = scrubSentryEvent(build(body) as unknown as ScrubbableEvent)

      const encoded = JSON.stringify(scrubbed)

      expect(encoded).not.toContain('CR-99')
      expect(encoded).not.toContain('Ada Lovelace')
    }
  )

  it.each([
    ['extra', (err: Error): Record<string, unknown> => ({ extra: { err } })],
    [
      'contexts',
      (err: Error): Record<string, unknown> => ({ contexts: { vue: { propsData: err } } }),
    ],
    ['tags', (err: Error): Record<string, unknown> => ({ tags: { err } })],
    [
      'breadcrumbs',
      (err: Error): Record<string, unknown> => ({
        breadcrumbs: [{ category: 'x', data: { err } }],
      }),
    ],
  ])(
    'keeps the body rule through a container AT `cause`, under %s',
    (_name, build: (err: Error) => ScrubbableEvent) => {
      // A container sitting DIRECTLY at `cause` is the narrow case: an object
      // there is re-walked one level down and was always cut, but an array or a
      // Set fell back to the general rule and its keyless blob rejoined whole.
      // This is the ofetch shape — an error wrapping the response body.
      const blob = '{"candidate_ref":"CR-99","display_name":"Ada Lovelace"}'
      const err = new Error('request failed', { cause: [blob] })

      const encoded = JSON.stringify(scrubSentryEvent(build(err) as unknown as ScrubbableEvent))

      expect(encoded).not.toContain('CR-99')
      expect(encoded).not.toContain('Ada Lovelace')
    }
  )

  it('cuts a keyless blob inside a Set reached by the GENERAL rule', () => {
    // A Set element has no key, and that does not depend on which rule reached
    // the Set. The off-shape guards (`transaction`, `message`, `fingerprint`,
    // `breadcrumbs`) route through `scrubValue`, and that path shipped the blob
    // verbatim while the identical Set under `request.data` was cut.
    const scrubbed = scrubSentryEvent({
      transaction: new Set(['{"display_name":"Ada Lovelace"}']),
    } as unknown as ScrubbableEvent)

    // POSITIVE, not just `not.toContain`. A negative assertion cannot tell a
    // scrubbed Set from a destroyed one, and this module's own argument is that
    // destruction is the worse outcome: returning `{}` here passes any
    // absence check while losing the fact that a Set of one element existed.
    expect(scrubbed.transaction).toEqual(['[redacted]'])
  })

  it.each([
    [
      'an unhandled top-level field',
      { meta: { items: ['{"candidate_ref":"CR-99","display_name":"Ada Lovelace"}'] } },
    ],
    [
      "a stack frame's captured locals",
      {
        exception: {
          values: [
            {
              value: 'boom',
              stacktrace: {
                frames: [
                  {
                    filename: 'https://bo.test/_nuxt/a.js',
                    vars: {
                      items: ['{"candidate_ref":"CR-99","display_name":"Ada Lovelace"}'],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  ])('carries the body rule through `scrubRecord` into %s', (_name, event) => {
    // `scrubRecord` hands OBJECT children to `scrubBody`, not `scrubValue`.
    // Collapsing that to `scrubValue` leaves both of these shipping verbatim —
    // and a frame's `vars` are captured locals, which is exactly where a
    // response body sits when the request that produced it threw.
    const encoded = JSON.stringify(scrubSentryEvent(event as unknown as ScrubbableEvent))

    expect(encoded).not.toContain('CR-99')
    expect(encoded).not.toContain('Ada Lovelace')
  })

  it('denies a SINGLE-TOKEN key that only the substring rule can reach', () => {
    // `useremail` has no separator, so the run walk never sees the segment
    // `email`, and the value is a NAME, so `EMAIL_PATTERN` has nothing to match.
    // The `includes('email')` clause is the only thing standing here — and it
    // buys that reach at a stated cost (`emails_queued: 3` is cut too), so the
    // trade deserves a test rather than a comment.
    const scrubbed = scrubSentryEvent({
      extra: { useremail: 'Ada Lovelace' },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.extra)).not.toContain('Ada Lovelace')
  })

  it.each([
    ['request', 'request'],
    ['exception', 'exception'],
    ['breadcrumbs', 'breadcrumbs'],
    ['fingerprint', 'fingerprint'],
  ])('cuts a RAW STRING body under the off-shape %s guard', (_name, field) => {
    // The off-shape guards existed so a field arriving in an unexpected shape
    // was still scrubbed, and they reached for `scrubValue`. A raw string is the
    // likeliest off shape and the one `scrubValue` cannot help with: no key to
    // deny, and nothing in the blob for `redactFreeText` to recognise.
    //
    // The existing malformed-shape tests used an object and an array, whose
    // fixtures carried a path and an address — both caught either way, so the
    // assertion could not fail on this.
    const blob = '{"candidate_ref":"CR-99","display_name":"Ada Lovelace"}'

    const encoded = JSON.stringify(
      scrubSentryEvent({ [field]: blob } as unknown as ScrubbableEvent)
    )

    expect(encoded).not.toContain('CR-99')
    expect(encoded).not.toContain('Ada Lovelace')
  })

  it('keeps a fingerprint ARRAY readable, because grouping depends on it', () => {
    // The off-shape guard takes the body rule; the ARRAY branch deliberately
    // does not. Cutting `['my-route', 'v2']` destroys Sentry grouping, and an
    // error reporter that cannot group is the outcome this module calls worse
    // than a scrubbed one.
    const scrubbed = scrubSentryEvent({
      fingerprint: ['participants-list', 'v2'],
    } as unknown as ScrubbableEvent)

    expect(scrubbed.fingerprint).toEqual(['participants-list', 'v2'])
  })

  it.each([
    ['transaction', (blob: string): Record<string, unknown> => ({ transaction: [blob] })],
    ['message', (blob: string): Record<string, unknown> => ({ message: [blob] })],
    [
      "an exception value's `value`",
      (blob: string): Record<string, unknown> => ({ exception: { values: [{ value: [blob] }] } }),
    ],
    [
      "a breadcrumb's message",
      (blob: string): Record<string, unknown> => ({
        breadcrumbs: [{ category: 'x', message: [blob] }],
      }),
    ],
  ])(
    'cuts a keyless blob in a NON-STRING %s',
    (_name, build: (blob: string) => ScrubbableEvent) => {
      // These four fields are STRING-typed, so their guards kept
      // `redactFreeText` on both arms. The string arm is right — a route or a
      // thrown message is readable text and cutting it destroys grouping. The
      // non-string arm was not: an array's elements are keyless, and
      // `redactFreeText` has no slash, no `@` and no scheme to grip on.
      //
      // The tell was that a `Set` at `transaction` WAS cut, by
      // `scrubNonPlain`'s unconditional arm, while an array one line over
      // shipped whole. Same field, same threat, two answers.
      const blob = '{"candidate_ref":"CR-99","display_name":"Ada Lovelace"}'

      const encoded = JSON.stringify(scrubSentryEvent(build(blob) as unknown as ScrubbableEvent))

      expect(encoded).not.toContain('CR-99')
      expect(encoded).not.toContain('Ada Lovelace')
    }
  )

  it('keeps a STRING transaction readable, because grouping depends on it', () => {
    // The positive twin. The non-string arm takes the body rule; the string arm
    // must NOT, or every event groups under `[redacted]`.
    const scrubbed = scrubSentryEvent({
      transaction: 'participants-list',
    } as unknown as ScrubbableEvent)

    expect(scrubbed.transaction).toBe('participants-list')
  })

  it.each([
    [
      'an exception VALUE element',
      (blob: string): Record<string, unknown> => ({ exception: { values: [[blob]] } }),
    ],
    [
      '`event.exception` itself',
      (blob: string): Record<string, unknown> => ({ exception: [blob] }),
    ],
    [
      'a non-array `exception.values`',
      (blob: string): Record<string, unknown> => ({ exception: { values: blob } }),
    ],
  ])('cuts a keyless blob in %s', (_name, build: (blob: string) => Record<string, unknown>) => {
    // `typeof [] === 'object'`, so an ARRAY cleared every guard that spelled
    // out `x === null || typeof x !== 'object'` by hand. It then reached a
    // branch that spreads its argument and came out as `{"0": …}` — shape
    // lost, and every element under an index key that denies nothing.
    //
    // Seven guards asked this question, three forgot the array case. It is
    // one predicate now: `isWalkableObject`.
    const blob = '{"candidate_ref":"CR-99","entry_url":"https://bo.test/interview/TOK99"}'

    const encoded = JSON.stringify(scrubSentryEvent(build(blob) as unknown as ScrubbableEvent))

    expect(encoded).not.toContain('CR-99')
    expect(encoded).not.toContain('TOK99')
  })

  it('REDACTS a non-array `exception.values` rather than dropping the key', () => {
    // Every sibling guard in this file argues the key should survive carrying
    // the marker. A dropped key says the field never existed, which is a
    // different claim and a false one.
    const scrubbed = scrubSentryEvent({
      exception: { values: 'malformed' },
    } as unknown as ScrubbableEvent)

    // NOT `toHaveProperty` alone — that passes on `{values: undefined}`, which
    // serialises away and is indistinguishable from the drop this asserts
    // against. The marker has to be there.
    expect(JSON.stringify(scrubbed.exception)).toContain('"values"')
    expect(JSON.stringify(scrubbed.exception)).toContain('[redacted]')
  })

  // STATIC, and compared against the real set below. Iterating `DENIED_KEYS`
  // directly was a test that could not fail: deleting an entry deleted its own
  // case, and the suite went from 334 green to 333 green. A list the
  // implementation cannot edit is the only kind that holds it to account.
  const EXPECTED_DENIED_KEYS = [
    'token',
    'access_token',
    'refresh_token',
    'api_key',
    'key_hash',
    'password',
    'secret',
    'webhook_secret',
    'authorization',
    'cookie',
    'header',
    'to_json',
    'q',
    'search',
    'searches',
    'filter',
    'filters',
    'query',
    'query_string',
    'fragment',
    'env',
    'tokens',
    'api_keys',
    'passwords',
    'secrets',
    'cookies',
    'headers',
    'candidate_ref',
    'candidate_refs',
    'display_names',
    'entry_urls',
    'display_name',
    'email',
    'transcript',
    'transcripts',
    'prompt',
    'prompts',
    'answer',
    'answers',
    'excerpt',
    'excerpts',
    'utterance',
    'utterances',
    'content',
    'contents',
    'text',
    'messages',
    'explanation',
    'payload',
    'texts',
    'explanations',
    'payloads',
    'authorizations',
    'query_strings',
    'fragments',
    'envs',
    'key_hashes',
    'access_tokens',
    'refresh_tokens',
    'webhook_secrets',
    'queries',
    'emails',
    'entry_url',
  ]

  const EXPECTED_HANDLED_FIELDS = [
    'message',
    'threads',
    'tags',
    'transaction',
    'fingerprint',
    'exception',
    'request',
    'extra',
    'contexts',
    'breadcrumbs',
    'user',
  ]

  it('carries `api_keys`, the one entry that was in the api list and neither mirror', () => {
    // `api_keys` was in the api's list and not in this one, and two comments
    // here claimed otherwise. It survived only through the `_keys` convention —
    // a different mechanism with strictly weaker reach, matching the TAIL where
    // a two-word entry matches any contiguous run — so `api_keys_raw` and
    // `client.apiKeys.value` shipped from the browser while the api cut both.
    //
    // A leak class present on both sides, answered differently on one, is the
    // divergence the mirror contract exists to forbid. This list is the only
    // place that can notice.
    // ONE assertion, because the other was `expect([]).toEqual([])`. It read a
    // literal declared five lines above it, so no mutation of this file, of
    // `DENIED_KEYS`, or of the api mirror could turn it red — while its title
    // advertised exactly the drift direction it could not see.
    //
    // What remains has teeth: `api_keys` was in the api's list and in NEITHER
    // mirror, and deleting it here turns this red. Full file-level parity needs
    // a guard in the WRAPPER, which is the only place that can read both
    // submodules — recorded in `openspec/specs/observability/spec.md`.
    const mirrorOnlyDeltas = ['entry_url', 'entry_urls', 'to_json']

    const mirrorOnly = EXPECTED_DENIED_KEYS.filter((key) => !mirrorOnlyDeltas.includes(key))

    expect(mirrorOnly).toContain('api_keys')
  })

  it('carries BOTH spellings of every entry that has a plural', () => {
    // The rule this file states and then applied to two groups out of three:
    // `text`, `explanation`, `payload`, `authorization`, `query_string`,
    // `fragment` and `env` all shipped in the PLURAL while their singulars were
    // denied. Asserted structurally rather than by naming today's misses, so
    // tomorrow's cannot slip in the same way.
    const irregular: Record<string, string> = {
      key_hash: 'key_hashes',
      query: 'queries',
      search: 'searches',
    }

    // Entries with no plural anyone emits, exempted by name rather than by a
    // loose rule: `q` is a query PARAMETER name, `to_json` is a method name, and
    // `messages` is already the plural — its singular `message` is a Sentry
    // field this module must keep readable, not deny.
    const noPlural = [
      'q',
      'to_json',
      'messages',
      // Irregular plurals: the `+s` rule cannot recognise these as plurals, so
      // it asks them for a plural of their own.
      'key_hashes',
      'queries',
      'searches',
    ]

    const missing = EXPECTED_DENIED_KEYS.filter((key) => {
      // Only the singulars: a plural has no plural of its own here.
      if (key.endsWith('s') && EXPECTED_DENIED_KEYS.includes(key.slice(0, -1))) {
        return false
      }

      if (noPlural.includes(key)) {
        return false
      }

      return !EXPECTED_DENIED_KEYS.includes(irregular[key] ?? `${key}s`)
    })

    expect(missing).toEqual([])
  })

  it('denies EXACTLY the documented keys, no more and no fewer', () => {
    // Adding an entry without adding it here fails too, on purpose: a new
    // denial is a decision, and it should be visible in the test that says
    // which decisions were made.
    expect([...DENIED_KEYS].sort()).toEqual([...EXPECTED_DENIED_KEYS].sort())
  })

  it('handles EXACTLY the documented event fields', () => {
    expect([...HANDLED_EVENT_FIELDS].sort()).toEqual([...EXPECTED_HANDLED_FIELDS].sort())
  })

  it.each(EXPECTED_DENIED_KEYS)('denies the key `%s`, whatever else reaches it', (key) => {
    // Over the STATIC list, which the equality test above holds against the real
    // set. Six entries — `cookie`, `answer`, `excerpt`, `excerpts`,
    // `utterance`, `payload` — could each be deleted with the whole suite still
    // green, and four of those are candidate speech and BARS evidence excerpts.
    //
    // Naming today's six by hand would have left tomorrow's unpinned, and
    // iterating the real set would have been worse: that test shrinks instead of
    // failing. Static list plus equality check is the only pairing where adding
    // or removing an entry has to be decided twice, on purpose.
    const scrubbed = scrubSentryEvent({
      extra: { [key]: 'SECRET-VALUE-99' },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.extra)).not.toContain('SECRET-VALUE-99')
  })

  it.each(EXPECTED_HANDLED_FIELDS)(
    'routes `%s` to the handler that keeps a redacted PATH',
    (field) => {
      // Dropping a field from this set is silent: the value still gets the
      // generic walk, so nothing leaks — it just loses `redactUrl` and comes
      // back as a bare origin, which is the symbolication loss this module
      // calls worse than a scrubbed event. Only a POSITIVE assertion sees it.
      // An ADDRESS in the path, not a route id. `redactAnalyticsPath` is per-app
      // — the backoffice knows `/participants/:id`, the candidate app knows
      // `/interview/:token` — so a route fixture only proves one mirror. The
      // address pass in `redactUrl` is unconditional in both, which is exactly
      // the handler this test is checking these fields still reach.
      const url = 'https://x.test/participants/jane@acme.test/transcript'

      const shapes: Record<string, unknown> = {
        request: { request: { url } },
        breadcrumbs: { breadcrumbs: [{ category: 'fetch', data: { url } }] },
        contexts: { contexts: { http: { url } } },
        exception: { exception: { values: [{ value: 'boom', stacktrace: { frames: [] } }] } },
        threads: { threads: { values: [{ value: 'boom', stacktrace: { frames: [] } }] } },
        extra: { extra: { url } },
        tags: { tags: { url } },
        message: { message: `failed on ${url}` },
        transaction: { transaction: url },
        fingerprint: { fingerprint: [url] },
        user: { user: { id: '1' } },
        spans: { spans: [] },
      }

      const shape = shapes[field]

      if (shape === undefined) {
        // A field this test does not model yet still has to be in the set —
        // failing here is the reminder to model it, not a licence to skip.
        expect(HANDLED_EVENT_FIELDS.has(field)).toBe(true)

        return
      }

      const encoded = JSON.stringify(scrubSentryEvent(shape as unknown as ScrubbableEvent))

      expect(encoded).not.toContain('jane@acme.test')
    }
  )

  it.each([
    ['body', 'body'],
    ['raw', 'raw'],
    ['detail', 'detail'],
    ['result', 'result'],
    ['note', 'note'],
    ['data', 'data'],
  ])('scrubs a JSON DOCUMENT under the unlisted key `%s`', (_name, key) => {
    // The denylist reads KEYS and a serialised body has none. `payload` happens
    // to be on the list; `body`, `raw`, `detail` are not, and the set of names
    // nobody thought of is unbounded — four earlier rounds of this file were
    // spent adding the name someone missed. So the rule is the document, not
    // the key.
    const scrubbed = scrubSentryEvent({
      extra: { [key]: '{"candidate_ref":"CR-99","display_name":"Ada Lovelace"}' },
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.extra)

    expect(encoded).not.toContain('CR-99')
    expect(encoded).not.toContain('Ada Lovelace')
  })

  it("scrubs ofetch's UNPARSED error body, the shape that reaches Sentry for real", () => {
    // ofetch hangs the raw response text on `FetchError.data` when the response
    // is not JSON — a Laravel error page served as `text/plain`. The PARSED
    // form was always safe, because its keys reach the denylist. Only this one
    // walked.
    const err = new Error('[GET] "/api/participants": 500') as Error & { data?: unknown }

    err.data = '{"candidate_ref":"CR-99","display_name":"Ada Lovelace"}'

    const encoded = JSON.stringify(
      scrubSentryEvent({ extra: { err } } as unknown as ScrubbableEvent)
    )

    expect(encoded).not.toContain('CR-99')
    expect(encoded).not.toContain('Ada Lovelace')
  })

  it('keeps a HARMLESS JSON document readable', () => {
    // The positive twin. Cutting every JSON-looking string outright would be
    // the destruction this module calls the worse outcome — `{"status":"ok"}`
    // is exactly the diagnostic an operator needs.
    const scrubbed = scrubSentryEvent({
      extra: { body: '{"status":"ok","count":3}' },
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.extra)

    expect(encoded).toContain('ok')
    expect(encoded).toContain('3')
  })

  it('leaves a string that only LOOKS like JSON to the free-text pass', () => {
    // `{` alone is not a document. The parse fails, and the fallback must be
    // the free-text redactor rather than the marker — otherwise every brace in
    // a log line becomes `[redacted]`.
    const scrubbed = scrubSentryEvent({
      extra: { note: '{not json at all, but mentions jane@acme.test}' },
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.extra)

    expect(encoded).not.toContain('jane@acme.test')
    expect(encoded).toContain('not json at all')
  })

  it.each([
    [
      'an exception value',
      (blob: string): Record<string, unknown> => ({
        exception: {
          values: [{ value: `[POST] "/api/score": 422 Unprocessable — ${blob}` }],
        },
      }),
    ],
    [
      'a breadcrumb message',
      (blob: string): Record<string, unknown> => ({
        breadcrumbs: [{ category: 'fetch', message: `response ${blob} for 422` }],
      }),
    ],
    [
      'a top-level message',
      (blob: string): Record<string, unknown> => ({
        message: `request failed with 422: ${blob}`,
      }),
    ],
  ])(
    'redacts a denied key EMBEDDED in %s',
    (_name, build: (blob: string) => Record<string, unknown>) => {
      // `scrubJsonString` only fires when the whole string IS a document, and
      // the carrier that matters most is not: an ofetch error embeds the
      // response body in prose. `redactFreeText` cut URLs and addresses and had
      // nothing to say about a denied KEY in the middle of a sentence.
      const blob = '{"candidate_ref":"CR-99","display_name":"Ada Lovelace"}'

      const encoded = JSON.stringify(scrubSentryEvent(build(blob) as unknown as ScrubbableEvent))

      expect(encoded).not.toContain('CR-99')
      expect(encoded).not.toContain('Ada Lovelace')
      // And the DIAGNOSTIC survives — the status is why anyone opens this.
      expect(encoded).toContain('422')
    }
  )

  it.each([
    ['an ARRAY value', '{"transcript":["step one, then", "TRANSCRIPT-SECRET-99"],"status":422}'],
    [
      'an OBJECT value',
      '{"payload":{"note":"step one, then","answer_summary":"ANSWER-SECRET-99"},"status":422}',
    ],
    [
      'a NESTED structure',
      '{"payload":{"note":"step one, then","answers":[{"text":"ANSWER-SECRET-99"}]},"status":422}',
    ],
    ['an UNTERMINATED structure', '{"transcript":["step one, then", "TRANSCRIPT-SECRET-99"'],
    // A different fail-closed branch from the one above, and one a truncated
    // body hits just as often.
    ['an UNTERMINATED string', '{"transcript":"step one, then TRANSCRIPT-SECRET-99'],
  ])('redacts a denied key holding %s, not only a scalar', (_name, blob) => {
    // The first version of this pass matched only SCALAR values, so a denied key
    // holding structure passed through untouched — and structure is exactly what
    // the worst keys hold. `transcript` and `payload` are a candidate's spoken
    // answers, which is the single thing this module exists to stop.
    const encoded = JSON.stringify(
      scrubSentryEvent({
        message: `[POST] "/api/score": 422 — ${blob}`,
      } as unknown as ScrubbableEvent)
    )

    expect(encoded).not.toContain('TRANSCRIPT-SECRET-99')
    expect(encoded).not.toContain('ANSWER-SECRET-99')
  })

  it.each([
    ['an escaped scalar', String.raw`{\"transcript\":\"step one, then TRANSCRIPT-SECRET-99\"}`],
    [
      'an escaped array',
      String.raw`{\"transcript\":[\"step one, then\", \"TRANSCRIPT-SECRET-99\"]}`,
    ],
    [
      'an escaped nested object',
      String.raw`{\"payload\":{\"note\":\"a, b\",\"answer_summary\":\"ANSWER-SECRET-99\"}}`,
    ],
    [
      'a key longer than 64 characters',
      `{"${'x'.repeat(60)}_transcript":"step one, then TRANSCRIPT-SECRET-99"}`,
    ],
  ])('redacts a denied key behind %s', (_name, blob) => {
    // A document nested inside another JSON string arrives ESCAPED — the
    // ordinary shape once an error body has been serialised twice — and the
    // plain-quote scanner walked straight past it. `String.raw` because a plain
    // literal would unescape `\"` back to `"` and the fixture would not be
    // testing the escaped form at all.
    //
    // The key cap was the same fail-open direction: a key longer than the bound
    // was never tested against the denylist.
    const encoded = JSON.stringify(
      scrubSentryEvent({
        message: `[POST] "/api/score": 422 — ${blob}`,
      } as unknown as ScrubbableEvent)
    )

    expect(encoded).not.toContain('TRANSCRIPT-SECRET-99')
    expect(encoded).not.toContain('ANSWER-SECRET-99')
  })

  it.each([
    [
      'an escaped array',
      String.raw`{\"transcript\":[\"a, b\", \"TRANSCRIPT-SECRET-99\"],\"other\":\"keep-this\"}`,
    ],
    [
      'an escaped nested object',
      String.raw`{\"payload\":{\"note\":\"a, b\",\"x\":\"TRANSCRIPT-SECRET-99\"},\"other\":\"keep-this\"}`,
    ],
  ])('does not swallow sibling fields after %s', (_name, blob) => {
    // Fail-closed was never in question; the defect was over-reach. Deducing
    // escaped mode from the VALUE's opener left it false for a structure — a
    // structure opens with a bare `{` — so the brace walker read the inner `\"`
    // as non-terminating and ran to the end of the string, taking every sibling
    // field with it. An error reporter that deletes the context around the
    // secret is the outcome this module calls worse than a scrubbed one.
    const encoded = JSON.stringify(
      scrubSentryEvent({ message: `422 — ${blob}` } as unknown as ScrubbableEvent)
    )

    expect(encoded).not.toContain('TRANSCRIPT-SECRET-99')
    expect(encoded).toContain('keep-this')
  })

  it('fails CLOSED on a graph too deep to walk, instead of losing the event', () => {
    // The cycle guard catches cycles, not DEPTH. A non-cyclic graph nested past
    // roughly 3000 levels raises `RangeError` out of `beforeSend`, which loses
    // the event whole — the failure every guard in this file is individually
    // written against and the one it cannot enumerate. The api mirror answers
    // the same class with a depth cap, after a self-referential ARRAY took the
    // PHP process down with SIGSEGV.
    let deep: Record<string, unknown> = { candidate_ref: 'DEEP-SECRET-99' }

    for (let i = 0; i < 20_000; i += 1) {
      deep = { nested: deep }
    }

    let scrubbed: ScrubbableEvent | null = null

    expect(() => {
      scrubbed = scrubSentryEvent({ extra: { deep } } as unknown as ScrubbableEvent)
    }).not.toThrow()

    // And a marker event, not the original: failing closed is the point.
    expect(JSON.stringify(scrubbed)).not.toContain('DEEP-SECRET-99')
  })

  it('cuts a denied key in the STACK, not only in the message', () => {
    // `redactStack` chained the path, address and URL passes and never ran
    // `redactEmbeddedPairs`. Every other free-text sink gets it through
    // `redactFreeText`, so the same string came back cut under `message` and
    // verbatim under `stack` — on the same clone, one field over.
    //
    // And this is the ORDINARY shape: ofetch builds its message as
    // `[${method}] ${JSON.stringify(url)}: …` with the response body appended,
    // and that message IS the first line of `.stack`.
    const err = new Error('POST /api/score failed: {"transcript":"STACK-SECRET-99"}')

    err.stack = `Error: POST /api/score failed: {"transcript":"STACK-SECRET-99"}\n    at scoreCandidate (https://bo.test/_nuxt/a.js:12:9)`

    const scrubbed = scrubSentryEvent({ extra: { err } } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.extra)

    expect(encoded).not.toContain('STACK-SECRET-99')
    // The FRAME must survive — a stack reduced to bare origins is the
    // symbolication loss this module calls worse than a scrubbed event.
    expect(encoded).toContain('a.js')
  })

  it('cuts a bare ARRAY at `Error.cause`, which has no keys to deny', () => {
    // The existing `cause` tests all put a JSON-OBJECT string in the array, so
    // `redactEmbeddedPairs` cut it and `walkChild` never had to. A bare array of
    // PLAIN strings is the keyless case: nothing to deny, nothing for the
    // free-text pass to recognise, and swapping `walkChild` for `scrubValue`
    // shipped `{"0":"…","1":"CR-99"}` with the suite green.
    const err = new Error('scoring failed', {
      cause: ['CAUSE-SPEECH-99', 'CR-99'],
    })

    const encoded = JSON.stringify(
      scrubSentryEvent({ extra: { err } } as unknown as ScrubbableEvent)
    )

    expect(encoded).not.toContain('CAUSE-SPEECH-99')
    expect(encoded).not.toContain('CR-99')
  })

  it('cuts a JSON ARRAY document, the only shape `scrubJsonString` alone can reach', () => {
    // `redactEmbeddedPairs` masks the object-document case — it finds
    // `"key": value` pairs — so the behaviour unique to `scrubJsonString` is the
    // KEYLESS one. Forcing it to always return null left the suite green
    // because every fixture was an object.
    const scrubbed = scrubSentryEvent({
      extra: { note: '["JSON-ARRAY-SPEECH-99","jane@acme.test"]' },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.extra)).not.toContain('JSON-ARRAY-SPEECH-99')
  })

  it('cuts a raw STRING body under `contexts.http.data`', () => {
    // The branch `feature/scrubber-http-context` is named for. Its keyless
    // string-body rule borrowed its coverage from `scrubbedDataEntry`, which was
    // itself untested — two unpinned guards covering each other read as one
    // tested guard, which is worse than one missing guard because it looks
    // covered.
    // PLAIN prose, not a JSON document. A `[...]` body is cut by
    // `scrubJsonString` whatever this branch does, which is how both guards
    // stayed green while each was individually removable. A raw string has no
    // key to deny and nothing for `redactFreeText` to recognise — no slash, no
    // `@`, no scheme — so the keyless cut is the only thing standing here.
    const scrubbed = scrubSentryEvent({
      contexts: { http: { url: 'https://bo.test/x', data: 'HTTP BODY SPEECH 99' } },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.contexts)).not.toContain('HTTP BODY SPEECH 99')
  })

  it('cuts a raw STRING body under `request.data` too', () => {
    // The twin of the `contexts.http` case, in the request branch. Each cuts
    // `data` explicitly and each was individually removable while the other
    // stayed green — the same two-guards-covering-each-other shape, one branch
    // over. Plain prose again: an object body is covered by the walk and a JSON
    // one by `scrubJsonString`, so neither can see this guard.
    const scrubbed = scrubSentryEvent({
      request: { url: 'https://bo.test/x', data: 'REQ BODY SPEECH 99' },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.request)).not.toContain('REQ BODY SPEECH 99')
  })

  it('walks an ARRAY-shaped context as an array, not as an index map', () => {
    // `typeof [] === 'object'`, so without the `Array.isArray` arm `safeClone`
    // spreads it into `{"0":…,"1":…}` — index keys deny nothing and
    // `redactFreeText` has no slash, no `@` and no scheme to grip on. Both
    // defect classes this file names by hand, in one input.
    const scrubbed = scrubSentryEvent({
      contexts: { proctor: ['Ada Lovelace', 'CR-99'] },
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.contexts)

    expect(encoded).not.toContain('Ada Lovelace')
    expect(encoded).not.toContain('CR-99')
    // The SHAPE, positively: an index map passes both checks above while having
    // lost the fact that this was ever an array.
    expect(scrubbed.contexts).toEqual({ proctor: ['[redacted]', '[redacted]'] })
  })

  it('contains a throwing getter on `contexts.http` to that context alone', () => {
    // `not.toThrow()` would pass against the mutant too: the guard's job is not
    // merely to survive, it is to keep the REST of the event. Replace the
    // `safeClone === null` branch with the raw context and the later rest-spread
    // re-invokes the getter, collapsing an event whose `message` had nothing to
    // do with the throw.
    const http = {
      get url(): unknown {
        throw new Error('url boom')
      },
    }

    const scrubbed = scrubSentryEvent({
      message: 'login failed',
      contexts: { http },
    } as unknown as ScrubbableEvent)

    expect(scrubbed.message).toBe('login failed')
    expect(JSON.stringify(scrubbed.contexts)).toContain('[redacted]')
  })

  it.each([
    ['extra', 'extra'],
    ['tags', 'tags'],
    ['contexts', 'contexts'],
    ['fingerprint', 'fingerprint'],
  ])('cuts a BARE keyless value under off-shape `%s`', (_name, field) => {
    // BARE, not a JSON blob. Every earlier fixture for these four sites used
    // `{"candidate_ref":"CR-99"}`, which `redactEmbeddedPairs` and
    // `scrubJsonString` cut whatever the body rule does — so all four could be
    // swapped from `scrubBody` to `scrubValue` with the whole suite green while
    // `['CR-99']` shipped as `{"0":"CR-99"}` and `'candidate_ref=CR-99'` shipped
    // whole.
    // `fingerprint` NESTED, because its top-level array elements are meaningful
    // strings kept on purpose — cutting them destroys Sentry grouping, which
    // this module calls the worse outcome. A nested array inside one is off
    // shape and takes the keyless cut like the rest.
    const payload = field === 'fingerprint' ? [['CR-99']] : ['CR-99']

    const encoded = JSON.stringify(
      scrubSentryEvent({ [field]: payload } as unknown as ScrubbableEvent)
    )

    expect(encoded).not.toContain('CR-99')
  })

  it.each([
    ['extra', 'extra'],
    ['tags', 'tags'],
    ['contexts', 'contexts'],
  ])('cuts a bare STRING under off-shape `%s`', (_name, field) => {
    // The other off shape: not an array, a raw string. `redactFreeText` has no
    // slash, no `@` and no scheme to grip on in `candidate_ref=CR-99`.
    const encoded = JSON.stringify(
      scrubSentryEvent({ [field]: 'candidate_ref=CR-99' } as unknown as ScrubbableEvent)
    )

    expect(encoded).not.toContain('CR-99')
  })

  it('keeps the body rule for a CONTAINER under a Map key', () => {
    // The Map arm splits containers (`scrubBody`) from primitives
    // (`scrubValue`). Collapsing both to `scrubValue` shipped
    // `{"0":"…LEAKSPEECH"}` — candidate words verbatim AND the array flattened
    // into an index map. The Set arm one branch up IS pinned, which is exactly
    // what made this one read as covered.
    const scrubbed = scrubSentryEvent({
      request: {
        url: 'https://bo.test/x',
        data: new Map<string, unknown>([['items', ['MAP-CONTAINER-SPEECH-99']]]),
      },
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.request)

    expect(encoded).not.toContain('MAP-CONTAINER-SPEECH-99')
    // And the SHAPE: an index map passes the check above while having lost the
    // fact that this was ever an array.
    expect(encoded).toContain('["[redacted]"]')
  })

  it('contains a throwing getter at the `contexts` TOP level', () => {
    // The guard against the worst failure was the untested one. Replacing
    // `safeClone(next.contexts)` with the raw value loses the ENTIRE event —
    // including a `message` unrelated to the throw — and `not.toThrow()` can
    // never see it, because the outer net does not throw either.
    const contexts = {
      get vue(): unknown {
        throw new Error('reactive boom')
      },
    }

    const scrubbed = scrubSentryEvent({
      message: 'login failed',
      contexts,
    } as unknown as ScrubbableEvent)

    expect(scrubbed.message).toBe('login failed')
    expect(JSON.stringify(scrubbed.contexts)).toContain('[redacted]')
  })

  it('cuts a NON-JSON string body under a generic context', () => {
    // `request.data` and `contexts.http.data` are both pinned; the generic
    // per-context one was not, and the comment defending it cited a JSON
    // document — which `scrubJsonString` now cuts on both paths, so the
    // documented reason had stopped holding. The reason that DOES hold is a
    // keyless string with nothing for the free-text pass to grip.
    const scrubbed = scrubSentryEvent({
      contexts: { vue: { data: 'CTX DATA SPEECH 99 led the migration alone' } },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.contexts)).not.toContain('CTX DATA SPEECH 99')
  })

  it.each(['to', 'from'])(
    'keeps a redacted PATH on a breadcrumb `%s`, not a bare origin',
    (field) => {
      // Not a leak — symbolication loss. Shrinking the field list to `['url']`
      // drops these to the bare origin, which is the diagnostic collapse the
      // `HANDLED_EVENT_FIELDS` comment says got caught one level up. The
      // breadcrumb level never was.
      const scrubbed = scrubSentryEvent({
        breadcrumbs: [
          {
            category: 'navigation',
            data: { [field]: 'https://bo.test/participants/jane@acme.test/transcript' },
          },
        ],
      } as unknown as ScrubbableEvent)

      const encoded = JSON.stringify(scrubbed.breadcrumbs)

      expect(encoded).not.toContain('jane@acme.test')
      expect(encoded).toContain('/transcript')
    }
  )

  it('marks a cycle reached through `scrubBody` with the circular marker', () => {
    // The marker VALUE was unpinned. Returning `undefined` instead keeps the
    // suite green because `JSON.stringify` drops it — so the key does not carry
    // a marker, it DISAPPEARS, and the report silently stops saying a cycle was
    // there. The two shared-reference tests assert the marker is ABSENT;
    // nothing asserted it is present.
    const node: Record<string, unknown> = { display_name: 'Ada Lovelace', note: 'kept' }

    node['self'] = node

    const scrubbed = scrubSentryEvent({ extra: { a: node } } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.extra)

    expect(encoded).toContain('[circular]')
    expect(encoded).toContain('kept')
    expect(encoded).not.toContain('Ada Lovelace')
  })

  it('marks a cycle reached through `scrubValue` with the circular marker', () => {
    // The other entry point: a non-plain object routes here, not through
    // `scrubBody`, and each has its own guard.
    const err = new Error('boom') as Error & { cause?: unknown }

    err.cause = err

    const encoded = JSON.stringify(
      scrubSentryEvent({ extra: { err } } as unknown as ScrubbableEvent)
    )

    expect(encoded).toContain('[circular]')
  })

  it.each([
    ['event.message', (doc: string): Record<string, unknown> => ({ message: doc })],
    ['event.transaction', (doc: string): Record<string, unknown> => ({ transaction: doc })],
    [
      'exception.values[].value',
      (doc: string): Record<string, unknown> => ({ exception: { values: [{ value: doc }] } }),
    ],
    [
      'breadcrumb.message',
      (doc: string): Record<string, unknown> => ({
        breadcrumbs: [{ category: 'console', message: doc }],
      }),
    ],
    [
      'Error.stack',
      (doc: string): Record<string, unknown> => {
        const err = new Error('boom')

        err.stack = `Error: ${doc}\n    at x (https://bo.test/_nuxt/a.js:1:1)`

        return { extra: { err } }
      },
    ],
  ])(
    'cuts a bare JSON DOCUMENT reaching %s',
    (_name, build: (doc: string) => Record<string, unknown>) => {
      // `scrubJsonString` had exactly one caller — `scrubValue`'s string branch
      // — while these five sinks reach `redactFreeText` directly. A bare JSON
      // ARRAY has no key for the denylist and nothing for the free-text passes
      // to grip, so `console.error(JSON.stringify(utterances))` shipped
      // candidate speech verbatim while the identical string one key over was
      // cut.
      const doc = '["SINK-SPEECH-99"]'

      const encoded = JSON.stringify(scrubSentryEvent(build(doc) as unknown as ScrubbableEvent))

      expect(encoded).not.toContain('SINK-SPEECH-99')
    }
  )

  it('leaves a bracketed run that is NOT JSON alone', () => {
    // The embedded-document pass replaces only spans that actually PARSE. That
    // is what keeps it from eating `at [native code]` or a bracketed log prefix
    // — those are not JSON, the parse fails, and the text is left as it is. A
    // pass that ate every bracket would be the destruction this module calls
    // worse than a leak.
    const scrubbed = scrubSentryEvent({
      message: '[worker] retry 3 at [native code] after {unbalanced',
    } as unknown as ScrubbableEvent)

    expect(scrubbed.message).toBe('[worker] retry 3 at [native code] after {unbalanced')
  })

  it('keeps the FRAMES intact while cutting a document in the stack head', () => {
    // Split, not blanket. The first line of a stack IS the error message and
    // gets the document rule; the frames keep the path-preserving chain,
    // because reducing them is the symbolication loss this module calls worse.
    const err = new Error('boom')

    err.stack = 'Error: ["HEAD-SPEECH-99"]\n    at scoreCandidate (https://bo.test/_nuxt/a.js:12:9)'

    const encoded = JSON.stringify(
      scrubSentryEvent({ extra: { err } } as unknown as ScrubbableEvent)
    )

    expect(encoded).not.toContain('HEAD-SPEECH-99')
    expect(encoded).toContain('a.js')
    expect(encoded).toContain('12:9')
  })

  it.each([
    ['transaction', (p: string): Record<string, unknown> => ({ transaction: p })],
    ['extra', (p: string): Record<string, unknown> => ({ extra: { note: p } })],
    [
      'a breadcrumb',
      (p: string): Record<string, unknown> => ({
        breadcrumbs: [{ category: 'navigation', message: `redirect to ${p} failed` }],
      }),
    ],
    [
      'an exception value',
      (p: string): Record<string, unknown> => ({
        exception: { values: [{ value: `redirect to ${p} failed` }] },
      }),
    ],
  ])(
    'cuts a RELATIVE `?token=` reaching %s',
    (_name, build: (p: string) => Record<string, unknown>) => {
      // `redactUrl` cuts at `?`; the free-text URL pass was anchored to
      // `https?://` and only ever saw an ABSOLUTE one, so the two disagreed on
      // the same string. The transaction is the sharpest case — Sentry's
      // tracing middleware seeds it with the raw client-controlled path and
      // only replaces it once a ROUTE matches, so on a 404 it stays as typed.
      // Three shapes, because the first version of the pattern kept the query
      // whenever a `#` or a second `?` followed: the path class was greedy and
      // backtracked to the LAST delimiter. `redactUrl` cuts at the FIRST of
      // either, and these two passes must not disagree.
      const paths = [
        '/auth/magic?token=eyJhbGciOi.PAYLOAD.SIG',
        '/auth/magic?token=eyJhbGciOi.PAYLOAD.SIG#frag',
        '/auth/magic?a=1?token=eyJhbGciOi.PAYLOAD.SIG',
      ]

      const encoded = paths
        .map((path) => JSON.stringify(scrubSentryEvent(build(path) as unknown as ScrubbableEvent)))
        .join('')

      expect(encoded).not.toContain('PAYLOAD')
      // And the PATH survives — a route reduced to nothing is the diagnostic
      // loss this module calls worse than a scrubbed event.
      expect(encoded).toContain('/auth/magic')
    }
  )

  it('REDACTS an oversized embedded span rather than skipping it', () => {
    // The length bound exists so a huge span is not parsed — a cost decision.
    // Skipping turned it into a disclosure decision: a bare JSON list over the
    // bound walked out whole while a smaller one was cut.
    const huge = `["${'x'.repeat(120_000)}","OVERSIZE-SPEECH-99"]`

    const scrubbed = scrubSentryEvent({
      message: `body: ${huge}`,
    } as unknown as ScrubbableEvent)

    // The EXACT shape, because `not.toContain` + `toContain('body:')` is true on
    // BOTH sides of the bound — the under-limit form redacts the inner value and
    // keeps the brackets, so the old pair of assertions passed vacuously and
    // raising the bound to infinity stayed green.
    expect(scrubbed.message).toBe('body: [redacted]')
  })

  it.each([
    'transcript_lines',
    'prompt_body',
    'answer_1',
    'excerpt_1',
    'utterance_3',
    // BOTH spellings. `DENIED_KEYS` carries singular and plural for every one of
    // these, and the content list carried only the singulars — so `answers_1`
    // was allowed while `answer_1` was denied.
    'transcripts_lines',
    'prompts_body',
    'answers_1',
    'excerpts_1',
    'utterances_3',
  ])('denies the candidate-content word in `%s`, prefix position included', (key) => {
    // The single-word rule matched the whole key or its LAST segment, which is
    // right for generic words — matching `content` anywhere redacted
    // `content_type`. It is wrong for these five: there is no innocent key
    // shaped like `answer_1` or `prompt_body`.
    const scrubbed = scrubSentryEvent({
      extra: { [key]: 'CONTENT-SPEECH-99' },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.extra)).not.toContain('CONTENT-SPEECH-99')
  })

  it.each(['content_type', 'content_length'])('still spares the GENERIC word in `%s`', (key) => {
    // The collateral the narrow list avoids. Widening the first rule instead
    // of adding a second list would have taken these with it.
    const scrubbed = scrubSentryEvent({
      extra: { [key]: 'application/json' },
    } as unknown as ScrubbableEvent)

    expect((scrubbed.extra as Record<string, unknown>)[key]).toBe('application/json')
  })

  it('cuts the COPY inside a ui.click selector, keeping the selector', () => {
    // `@sentry/core`'s `_htmlElementAsString` appends `aria-label`, `title` and
    // `alt` VALUES into every `ui.click` breadcrumb message, and that copy is
    // interpolated — `$t('nav.profileLabel', { name: currentUserName })` puts a
    // person's name into the selector. This module drops `event.user` arguing an
    // identity adds nothing to a stack trace, and the identity walked back in
    // one field over.
    const scrubbed = scrubSentryEvent({
      user: { email: 'ada@acme.test', id: 7 },
      breadcrumbs: [
        {
          category: 'ui.click',
          message:
            'div#app > a.nav-item[aria-label="Open profile for Ada Lovelace"][type="button"]',
        },
      ],
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.breadcrumbs)

    expect(encoded).not.toContain('Ada Lovelace')
    // The SELECTOR survives — it is the whole diagnostic value — and `type` is
    // structural, not copy.
    expect(encoded).toContain('a.nav-item')
    expect(encoded).toContain('type=')
  })

  it.each(['candidate ref', 'display name', 'entry  url'])(
    'denies `%s`, where the separator is WHITESPACE',
    (key) => {
      // `-` and `.` were folded so the denylist reaches `X-Api-Key` and
      // `auth.token`; a space was not. Sentry's TAG charset would reject these,
      // but `extra`, `contexts` and `breadcrumb.data` have no charset limit.
      const scrubbed = scrubSentryEvent({
        extra: { [key]: 'WHITESPACE-SECRET-99' },
      } as unknown as ScrubbableEvent)

      expect(JSON.stringify(scrubbed.extra)).not.toContain('WHITESPACE-SECRET-99')
    }
  )

  it('cuts a JSON document trailing a stack FRAME line', () => {
    // `redactStack` splits head from frames so the frames keep their paths, and
    // the document rule was applied to only one half.
    const err = new Error('boom')

    err.stack = 'Error: boom\n    at f (https://bo.test/_nuxt/D1.js:1:1) ["FRAME-SPEECH-99"]'

    const encoded = JSON.stringify(
      scrubSentryEvent({ extra: { err } } as unknown as ScrubbableEvent)
    )

    expect(encoded).not.toContain('FRAME-SPEECH-99')
    expect(encoded).toContain('D1.js')
  })

  it('returns the MARKER for a breadcrumb it cannot enumerate', () => {
    // NOT a test of the outer net — every read inside `scrubBreadcrumbInner` is
    // already guarded, so nothing has been found that reaches it, and the
    // docblock says so rather than this test pretending to pin it.
    //
    // What this DOES pin is the fail-closed answer when the clone itself is
    // impossible: the marker, not the raw breadcrumb.
    const hostile = {
      get category(): unknown {
        throw new Error('category boom')
      },
    }

    let result: unknown

    expect(() => {
      result = scrubBreadcrumb(hostile as unknown as Parameters<typeof scrubBreadcrumb>[0])
    }).not.toThrow()

    expect(JSON.stringify(result)).toContain('[redacted]')
  })

  it('gives `threads` frames the same treatment as `exception` frames', () => {
    // `threads` carries the IDENTICAL `{values:[{stacktrace:{frames}}]}` shape,
    // and it sat in `HANDLED_EVENT_FIELDS` with no branch to handle it — which
    // in this walker means "copied raw". Its frames took `redactFreeText`
    // instead of `redactUrl` and collapsed to the bare origin.
    const frame = { filename: 'https://bo.test/_nuxt/D1abc.js', lineno: 7 }

    const scrubbed = scrubSentryEvent({
      exception: { values: [{ value: 'boom', stacktrace: { frames: [frame] } }] },
      threads: { values: [{ value: 'boom', stacktrace: { frames: [{ ...frame }] } }] },
    } as unknown as ScrubbableEvent)

    // The PATH survives on both, which is the whole point of the dedicated
    // branch — a bare origin cannot symbolicate anything.
    expect(JSON.stringify(scrubbed.exception)).toContain('D1abc.js')
    expect(JSON.stringify(scrubbed.threads)).toContain('D1abc.js')
  })

  it('scrubs a denied key inside a `threads` frame', () => {
    const scrubbed = scrubSentryEvent({
      threads: {
        values: [
          {
            value: 'boom',
            stacktrace: {
              frames: [{ filename: 'https://bo.test/a.js', vars: { candidate_ref: 'THREAD99' } }],
            },
          },
        ],
      },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.threads)).not.toContain('THREAD99')
  })

  it.each(['exception', 'threads'])(
    'returns the MARKER when `%s` cannot be cloned, rather than dropping it',
    (field) => {
      // `safeClone` returning null left the rest-spread as `{}` and the whole
      // field evaporated, while `request` one branch over returned the marker on
      // the identical input. This file argues the case by hand four lines down:
      // a dropped key says the field never existed, which is a different claim
      // and a false one.
      const hostile = {
        get values(): unknown {
          throw new Error('values boom')
        },
      }

      const scrubbed = scrubSentryEvent({
        message: 'render failed',
        [field]: hostile,
      } as unknown as ScrubbableEvent)

      expect(JSON.stringify(scrubbed[field as 'exception'])).toContain('[redacted]')
      // And the REST of the event survives the throw.
      expect(scrubbed.message).toBe('render failed')
    }
  )

  it.each([
    ['a relative `?token=`', '/auth/magic?token=SECRET-FRAME-99', 'SECRET-FRAME-99'],
    ['selector COPY', 'a[title="Ada Lovelace"]', 'Ada Lovelace'],
    ['a JSON document', '["DOC-FRAME-99"]', 'DOC-FRAME-99'],
  ])('cuts %s inside a stack FRAME line, not only in the message', (_name, payload, secret) => {
    // `redactStack` splits head from frames, and the two halves were two
    // hand-written chains. They drifted three times — the document rule, the
    // relative-query cut, the selector-copy cut — each leaving the same string
    // cut under `message` and verbatim inside `.stack`, one field over.
    //
    // They share one chain now, so a new pass cannot reach half of it. The only
    // thing they still differ on is the absolute URL: free text reduces it to
    // its origin, a frame keeps the redacted PATH.
    const err = new Error('boom')

    err.stack = `Error: boom\n    at f (https://bo.test/_nuxt/D1.js:1:1) ${payload}`

    const encoded = JSON.stringify(
      scrubSentryEvent({ extra: { err } } as unknown as ScrubbableEvent)
    )

    expect(encoded).not.toContain(secret)
    // The frame PATH survives — that is the one difference the two chains keep.
    expect(encoded).toContain('D1.js')
  })

  it.each(['answer1', 'token1', 'excerpt2', 'transcript9'])(
    'denies `%s`, where the separator is the letter-to-DIGIT boundary',
    (key) => {
      // The normalizer folded hyphens, dots, whitespace and the camelCase
      // boundary, and not this one — so `answer1` was ONE segment, in no list
      // and unreachable by the run walk, while `answer_1` was denied. Same
      // field, one character away, and the shape a template literal or an
      // index-suffixed form field produces most naturally.
      const scrubbed = scrubSentryEvent({
        extra: { [key]: 'DIGIT-SECRET-99' },
      } as unknown as ScrubbableEvent)

      expect(JSON.stringify(scrubbed.extra)).not.toContain('DIGIT-SECRET-99')
    }
  )

  it.each(['content1', 'utf8', 'sha256'])('still spares `%s`', (key) => {
    // The collateral the boundary must not create: a generic word plus a digit
    // is an ordinary diagnostic, and so is a name that IS a digit suffix.
    const scrubbed = scrubSentryEvent({
      extra: { [key]: 'application/json' },
    } as unknown as ScrubbableEvent)

    expect((scrubbed.extra as Record<string, unknown>)[key]).toBe('application/json')
  })

  it('scans a long BRACE RUN in linear time', () => {
    // The embedded-document scan called `embeddedValueEnd` at every `{`, and on
    // an unbalanced opener that scan runs to the end of the string — O(n^2),
    // with the length check sitting AFTER it so it bounded `JSON.parse` and
    // nothing else. Measured before the fix: 671 ms at 20k, 2.3 s at 40k,
    // 14.1 s at 99k — fourteen seconds of blocked main thread inside
    // `beforeSend`, on the operator's tab.
    //
    // Same shape as the two timing assertions this suite already carries, for
    // the same reason: a bound only a performance test can see.
    const hostile = '{'.repeat(99_000)

    const started = performance.now()

    scrubSentryEvent({ message: hostile } as unknown as ScrubbableEvent)

    expect(performance.now() - started).toBeLessThan(250)
  })

  it('gives the stack HEAD the free-text rule and the FRAMES the url rule', () => {
    // The split is what makes `redactStack` two things at once, and collapsing it
    // to one chain left 441 tests green. The cost: the message line inherits the
    // FRAME rule, and `redactUrl` returns a path shape that neither
    // `redactAnalyticsPath` nor the embedded-route pass anchors VERBATIM.
    //
    // So the head must reduce an absolute URL to its bare origin, and a frame
    // must keep its redacted path — otherwise Sentry cannot symbolicate.
    const err = new Error('boom')

    err.stack =
      'Error: upload to https://bo.test/x/unknown-shape/SECRET-99 failed\n    at foo (https://bo.test/_nuxt/D1abc.js:1:2)'

    const stack = (
      (
        scrubSentryEvent({ extra: { err } } as unknown as ScrubbableEvent).extra as Record<
          string,
          Record<string, unknown>
        >
      )['err'] as Record<string, unknown>
    )['stack'] as string

    // HEAD: reduced to the origin, so the unanchored path cannot ride out.
    expect(stack).not.toContain('SECRET-99')
    // FRAME: path, line and column intact.
    expect(stack).toContain('/_nuxt/D1abc.js:1:2')
  })

  // STATIC, and compared against the real set — the same pairing `DENIED_KEYS`
  // uses, and for the same reason: a test that derives its cases from the thing
  // under test shrinks instead of failing.
  const EXPECTED_CONTENT_WORDS = [
    'header',
    'headers',
    'env',
    'envs',
    'fragment',
    'fragments',
    'password',
    'passwords',
    'token',
    'tokens',
    'secret',
    'secrets',
    'authorization',
    'authorizations',
    'cookie',
    'cookies',
    'q',
    'query',
    'queries',
    'search',
    'searches',
    'filter',
    'filters',
    'text',
    'texts',
    'messages',
    'explanation',
    'explanations',
    'payload',
    'payloads',
    'transcript',
    'transcripts',
    'prompt',
    'prompts',
    'answer',
    'answers',
    'excerpt',
    'excerpts',
    'utterance',
    'utterances',
  ]

  it('carries BOTH spellings in the any-position list too', () => {
    // The same rule as the denylist, asserted the same way — `authorization`
    // was on this list and `authorizations` was not, which is the half-applied
    // shape this module keeps finding in itself, one list over.
    // The same irregular/no-plural carve-outs the denylist check carries: `q` is
    // a parameter name, and `queries`/`searches` are plurals the `+s` rule
    // cannot recognise as such.
    const irregular: Record<string, string> = { query: 'queries', search: 'searches' }
    const noPlural = ['q', 'queries', 'searches']

    const missing = EXPECTED_CONTENT_WORDS.filter((word) => {
      if (noPlural.includes(word) || word.endsWith('s')) {
        return false
      }

      return !EXPECTED_CONTENT_WORDS.includes(irregular[word] ?? `${word}s`)
    })

    expect(missing).toEqual([])
  })

  it('puts every CREDENTIAL word on BOTH lists', () => {
    // `header`, `env` and `fragment` sat on the denylist only, so `headers_raw`
    // shipped a bearer token, `env_dump` shipped an APP_KEY and `fragment_raw`
    // shipped an entry-link token, while `cookie_raw` one key over was cut —
    // every other credential word was on both.
    //
    // Named here rather than derived, because "is this a credential" is a
    // judgement: `content` is deliberately last-segment-only, and the list is
    // where that decision lives.
    const credentials = [
      'password',
      'token',
      'secret',
      'authorization',
      'cookie',
      'header',
      'env',
      'fragment',
    ]

    const missing = credentials.filter(
      (word) =>
        !EXPECTED_CONTENT_WORDS.includes(word) || !EXPECTED_CONTENT_WORDS.includes(`${word}s`)
    )

    expect(missing).toEqual([])
  })

  it('matches EXACTLY the documented any-position words', () => {
    expect([...DENIED_CONTENT_WORDS].sort()).toEqual([...EXPECTED_CONTENT_WORDS].sort())
  })

  it.each(EXPECTED_CONTENT_WORDS)(
    'denies `%s` in PREFIX position, which is the whole point of this list',
    (word) => {
      // Eight of the nine credential entries were unpinned: deleting
      // `password` left the suite green while `password_confirmation` shipped
      // the plaintext. The list whose entire reason for existing is
      // prefix-position credentials was the one half not held to the file's own
      // discipline.
      const scrubbed = scrubSentryEvent({
        extra: { [`${word}_suffix`]: 'ANYPOS-SECRET-99' },
      } as unknown as ScrubbableEvent)

      expect(JSON.stringify(scrubbed.extra)).not.toContain('ANYPOS-SECRET-99')
    }
  )

  it('resolves a COLLIDING key map in linear time', () => {
    // Every colliding key restarted the suffix search at 2, so n keys redacting
    // to the same marker cost O(n^2) probes — 82 ms at 1000, 806 ms at 4000,
    // 2.9 s at 8000, inside `beforeSend` on the main thread. A map keyed by
    // address is the ordinary shape of a delivery-result map, and a map keyed by
    // absolute URL collides just as hard.
    const extra: Record<string, unknown> = {}

    for (let i = 0; i < 8_000; i += 1) {
      extra[`user${i}@acme.test`] = 'x'
    }

    const started = performance.now()

    scrubSentryEvent({ extra } as unknown as ScrubbableEvent)

    expect(performance.now() - started).toBeLessThan(400)
  })

  it('cuts a whole JWT query, and ends a prose query at the space', () => {
    // The boundary this module and `redactUrl` answer differently, made visible
    // rather than silently traded. `redactUrl` is handed a URL, so everything
    // after `?` is query; this pass is handed prose, where a URL ends at the
    // first space.
    //
    // A JWT contains no space, so the credential case is cut whole — which is
    // the one that matters.
    expect(redactFreeText('redirect to /auth/magic?token=eyJhbGciOi.PAY.SIG failed')).toBe(
      'redirect to /auth/magic failed'
    )

    // And a FREE-TEXT key carrying a raw space takes the rest of the line: `q`
    // is the participants filter, so a surviving tail is a candidate's surname.
    // The cost — losing ` failed` — is paid only on these keys.
    expect(redactFreeText('GET /participants?q=Ada Lovelace failed')).toBe('GET /participants')
  })

  it('contains a DEPTH failure inside `scrubBreadcrumb` to that breadcrumb', () => {
    // The outer net on this hook, which nothing pinned. It IS reachable: the
    // cycle guard catches cycles, not depth, so a non-cyclic graph nested past
    // the engine's frame limit raises `RangeError` — and `beforeBreadcrumb` has
    // the same failure mode as `beforeSend`, the breadcrumb is lost whole.
    let deep: Record<string, unknown> = { candidate_ref: 'DEEP-BC-99' }

    for (let i = 0; i < 20_000; i += 1) {
      deep = { nested: deep }
    }

    let result: unknown

    expect(() => {
      result = scrubBreadcrumb({ category: 'x', data: deep } as never)
    }).not.toThrow()

    // And a MARKER breadcrumb, not the raw one: failing closed is the point.
    expect(JSON.stringify(result)).toBe('{"message":"[redacted]"}')
  })

  it.each([
    ['q', 'GET /participants?q=Ada Lovelace failed', 'GET /participants'],
    ['query', 'GET /participants?query=Ada Lovelace failed', 'GET /participants'],
    ['search', 'GET /p?search=Ada Lovelace failed', 'GET /p'],
  ])('takes the line after a FREE-TEXT `%s` query', (_name, input, expected) => {
    // `q` is the participants filter and carries a candidate's NAME, so a tail
    // surviving past the space is a leak rather than a curiosity.
    expect(redactFreeText(input)).toBe(expected)
  })

  it.each([
    ['a JWT', 'redirect to /auth/magic?token=eyJhbGciOi.PAY.SIG failed'],
    ['an api key', 'GET /x?api_key=AKIAIOSFODNN7 failed'],
  ])('keeps the prose after a CREDENTIAL query (%s)', (_name, input) => {
    // The narrowing that makes the rule above affordable: a credential is a
    // single token — a JWT, a signature, an api key all contain no space — so
    // cutting at the first space already takes the whole value, and the words
    // after it are ordinary diagnostics worth keeping.
    const out = redactFreeText(input)

    expect(out).not.toContain('PAY.SIG')
    expect(out).not.toContain('AKIAIOSFODNN7')
    expect(out).toContain('failed')
  })

  it('contains a throwing PROTOTYPE `toJSON` to that object', () => {
    // The read walks the PRESERVED prototype chain, so a getter-only `toJSON`
    // that throws propagated straight out of `beforeSend` and the whole event
    // went — including a `message` with nothing to do with it. The guard
    // reached `name`, `cause`, `message` and `stack` and stopped one line short.
    class Hostile extends Error {}

    Object.defineProperty(Hostile.prototype, 'toJSON', {
      get(): unknown {
        throw new Error('toJSON boom')
      },
      configurable: true,
    })

    const scrubbed = scrubSentryEvent({
      message: 'ordinary message',
      extra: { err: new Hostile('failed') },
    } as unknown as ScrubbableEvent)

    expect(scrubbed.message).toBe('ordinary message')
  })

  it('contains a throwing Map KEY coercion to that entry', () => {
    // A Map keyed by OBJECTS is ordinary, and `String(key)` calls `toString()`.
    // A throwing one took the event down whole, while every sibling walker in
    // this file wraps its enumeration.
    const hostileKey = {
      toString(): string {
        throw new Error('toString boom')
      },
    }

    const scrubbed = scrubSentryEvent({
      message: 'ordinary message',
      extra: {
        m: new Map<unknown, unknown>([
          [hostileKey, 'v'],
          ['candidate_ref', 'CR-99'],
        ]),
      },
    } as unknown as ScrubbableEvent)

    expect(scrubbed.message).toBe('ordinary message')
    // And the SIBLING entry is still scrubbed — one bad key must not cost the
    // rest of the map.
    expect(JSON.stringify(scrubbed.extra)).not.toContain('CR-99')
  })

  it.each(['signing_keys', 'stripe_keys', 'rotation_keys'])(
    'denies `%s` by the `_keys` CONVENTION, not by the list',
    (key) => {
      // The convention is live code that nothing pinned: deleting it left the
      // suite green while a signing key shipped. Only `api_keys` is reachable by
      // the run walk, because it is literally in `DENIED_KEYS` — these three are
      // redacted by the convention and nothing else.
      //
      // Its neighbour `_key` WAS pinned. Same half-applied shape, one line over.
      const scrubbed = scrubSentryEvent({
        extra: { [key]: 'SIGNING-SECRET-99' },
      } as unknown as ScrubbableEvent)

      expect(JSON.stringify(scrubbed.extra)).not.toContain('SIGNING-SECRET-99')
    }
  )

  it('cuts an entry-link token of ANY length embedded in prose', () => {
    // The token segment was bounded at 256 characters, which looked like a
    // safety valve and was a leak: a candidate magic-link JWT carries
    // candidateRef, project, role, lang and exp, and runs past that routinely —
    // so the tail rejoined the message after the `:token` placeholder.
    //
    // A signature tail is not a usable credential on its own, but this module's
    // contract is that the entry link IS a bearer credential, and "mostly cut"
    // is not that promise.
    const token = `eyJhbGciOi.${'A'.repeat(300)}.SIG`

    const out = redactFreeText(`entry link /interview/${token} rejected`)

    expect(out).not.toContain('AAAA')
    expect(out).toContain('/interview/:token')
    expect(out).toContain('rejected')
  })

  it.each([
    ['a colon lead', 'x:/auth/magic?token=SECRET-LEAD-99', 'x:/auth/magic'],
    ['an equals lead', 'navigate to=/participants?q=Ada Lovelace', 'navigate to=/participants'],
    ['a comma lead', 'tried,/auth/magic?token=SECRET-LEAD-99', 'tried,/auth/magic'],
  ])('cuts a relative query behind %s', (_name, input, expected) => {
    // The lead was a hand-written delimiter list — whitespace, quote, bracket,
    // start-of-string — and anything else meant the pass never fired at all. A
    // live bearer token shipped, and so did a candidate's surname, because the
    // free-text query cut lives INSIDE this pass.
    //
    // Every existing case used a whitespace or quote lead, so it had never been
    // asked the question it got wrong.
    expect(redactFreeText(input)).toBe(expected)
  })

  it('still leaves a mid-token slash and ordinary prose alone', () => {
    // The other half of widening the lead: `foo/bar?x=1` is a fragment inside a
    // word, not a rooted path, and a sentence ending in `?` is a sentence.
    expect(redactFreeText('module foo/bar?x=1 failed')).toBe('module foo/bar?x=1 failed')
    expect(redactFreeText('is that /the right one?')).toBe('is that /the right one?')
    expect(redactFreeText('Vue warn: #app not found')).toBe('Vue warn: #app not found')
  })

  it('finds a document after a STRAY quote in the prose', () => {
    // One unmatched `"` latched the scanner's string flag on for the rest of the
    // input, so every later `{` or `[` read as string content and no document
    // was ever attempted. An error message carrying a lone double quote is
    // ordinary — `Unexpected token " in JSON at position 5` — and the head of a
    // stack goes through this pass.
    const out = redactFreeText('at Foo (a"b) then ["QUOTE-LATCH-SPEECH-99"]')

    expect(out).not.toContain('QUOTE-LATCH-SPEECH-99')
    expect(out).toContain('at Foo')
  })

  it.each([
    ['a stray BRACE', 'Unexpected token { in JSON then ["STRAY-SPEECH-99"]'],
    ['a stray BRACKET', 'at Foo [native code then ["STRAY-SPEECH-99"]'],
    ['both', 'oops { and [ then ["STRAY-SPEECH-99"]'],
  ])('finds a document after %s in the prose', (_name, input) => {
    // The exact sibling of the stray-QUOTE latch, and only one of the two was
    // fixed. A depth counter only attempted a span when it returned to zero, so
    // ONE unmatched `{` or `[` latched it open and every later document went
    // unattempted. `Unexpected token '{' …` is an ordinary V8 message, and a
    // truncated body leaves an unmatched opener by construction.
    const out = redactFreeText(input)

    expect(out).not.toContain('STRAY-SPEECH-99')
    // And the prose around it survives — the stray opener is not the secret.
    expect(out).toContain('then')
  })

  it('rewrites the OUTERMOST span once, not the nested one twice', () => {
    // Recording pairs means a nested span closes before its parent. Replacing
    // the inner one first would rewrite text the outer parse then reads.
    expect(redactFreeText('body {"transcript":["speech"],"ok":1} end')).toBe(
      'body {"transcript":"[redacted]","ok":1} end'
    )
  })

  it.each(['text_raw', 'messages_json', 'explanation_raw', 'payload_json', 'transcript_lines'])(
    'denies `%s`, the content words that were left off the any-position list',
    (key) => {
      // The single-word rule fires on the whole key or its LAST segment unless the
      // word is on the any-position list — and `text`, `messages`, `explanation`
      // and `payload` were not, so all four shipped behind a prefix while
      // `transcript_lines` one key over redacted correctly.
      //
      // This file's own comments name them as the worst entries: `text` is what
      // this PRODUCT calls transcribed speech, `messages` is the AI conversation,
      // `explanation` is the LLM's rationale on `indicator_scores`.
      const scrubbed = scrubSentryEvent({
        extra: { [key]: 'PREFIX-SPEECH-99' },
      } as unknown as ScrubbableEvent)

      expect(JSON.stringify(scrubbed.extra)).not.toContain('PREFIX-SPEECH-99')
    }
  )

  it.each(['content_type', 'content_length', 'content_encoding'])(
    'still spares `%s` — the line the content list draws',
    (key) => {
      // `content` is deliberately NOT on the any-position list, and this is why:
      // these are ordinary diagnostics. `content` keeps the last-segment rule
      // while `text` does not, and that asymmetry is the decision, not an
      // oversight.
      const scrubbed = scrubSentryEvent({
        extra: { [key]: 'application/json' },
      } as unknown as ScrubbableEvent)

      expect((scrubbed.extra as Record<string, unknown>)[key]).toBe('application/json')
    }
  )

  it.each(['q_value', 'query_value', 'search_term', 'filter_input', 'queryValue'])(
    'denies the filter carrier `%s` in prefix position',
    (key) => {
      // These name the participants filter, which by this module's own header
      // carries a candidate's NAME — and the module already cut the identical
      // value inside a query string while handing it over under a key one
      // position left. `search` and `filter` were in neither list at all.
      //
      // Unlike `content`, there is no `q_type` or `query_length` diagnostic to
      // protect, so the any-position rule costs almost nothing here.
      const scrubbed = scrubSentryEvent({
        extra: { [key]: 'Ada Lovelace' },
      } as unknown as ScrubbableEvent)

      expect(JSON.stringify(scrubbed.extra)).not.toContain('Ada Lovelace')
    }
  )

  it('keeps an Error `name` readable, the carrier deliberately NOT denied', () => {
    // `name` is a free-text filter key too, and it is NOT on either list on
    // purpose: `scrubNonPlain` writes `clone.name` for every Error, so denying
    // it would redact `TypeError` on every event this module touches.
    const scrubbed = scrubSentryEvent({
      extra: { err: new TypeError('boom') },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.extra)).toContain('TypeError')
  })

  it.each([
    ['V8', 'Error: boom\n    at f (https://bo.test/_nuxt/D1abc.js:12:3)'],
    [
      'WebKit',
      'boom\nf@https://bo.test/_nuxt/D1abc.js:12:3\ng@https://bo.test/_nuxt/D1abc.js:20:5',
    ],
  ])('keeps %s frames symbolicatable', (_name, raw) => {
    // ` at ` is the V8 marker; WebKit and Firefox write `fn@url:line:col` with
    // no `at` anywhere. Searching only for the V8 form returned -1 there, so the
    // WHOLE stack was classified as the message head and went through the
    // free-text pass — which reduces every absolute URL to its bare origin and
    // takes file, line and column off every frame.
    //
    // CLAUDE.md names Safari as supported and gives it its own WebKit E2E
    // project, so this was the symbolication loss on a browser we ship to.
    const err = new Error('boom')

    err.stack = raw

    const scrubbed = scrubSentryEvent({ extra: { err } } as unknown as ScrubbableEvent)
    const stack = (
      (scrubbed.extra as Record<string, Record<string, unknown>>)['err'] as Record<string, unknown>
    )['stack'] as string

    expect(stack).toContain('D1abc.js:12:3')
  })

  it('keeps the message head and the frames on their own rules', () => {
    // The WebKit alternative is anchored on `:line:col` precisely so
    // `invite to jane@acme.test failed` stays in the head and gets the free-text
    // pass rather than being treated as the first frame.
    const err = new Error('boom')

    // On a LATER line, because `\n\s*` already excludes the first one — this is
    // the shape the `:line:col` anchor actually defends: a multi-line message
    // whose second line carries an address.
    // A line that STARTS with the address, because `\n\s*\S*@\S+` needs the run
    // to begin right after the newline — that is the shape the `:line:col`
    // anchor actually defends, and a wrapped message produces it.
    err.stack = 'invite failed\njane@acme.test rejected\n    at f (https://bo.test/a.js:1:1)'

    const scrubbed = scrubSentryEvent({ extra: { err } } as unknown as ScrubbableEvent)
    const stack = (
      (scrubbed.extra as Record<string, Record<string, unknown>>)['err'] as Record<string, unknown>
    )['stack'] as string

    expect(stack).not.toContain('jane@acme.test')
    expect(stack).toContain('a.js:1:1')
  })

  it('runs a frame URL through `redactUrl` — address in the PATH', () => {
    // The backoffice twin uses a route id (`/participants/42,Ada-Lovelace/`),
    // which only ITS `redactAnalyticsPath` knows how to collapse. This app's
    // route catalogue is `/interview/:token` and is already a declared mirror
    // delta, so the shape both halves cut unconditionally is the one asserted
    // here: an ADDRESS sitting in the path.
    const err = new Error('boom')

    err.stack = 'Error: boom\n    at s (https://fe.test/u/jane@acme.test/x.js:1:1)'

    const scrubbed = scrubSentryEvent({ extra: { err } } as unknown as ScrubbableEvent)
    const stack = (
      (scrubbed.extra as Record<string, Record<string, unknown>>)['err'] as Record<string, unknown>
    )['stack'] as string

    expect(stack).not.toContain('jane@acme.test')
    // And the frame is still a frame — file, line and column intact.
    expect(stack).toContain('x.js:1:1')
  })

  it.each(['filter', 'name'])('takes the line after a free-text `%s` query too', (key) => {
    // `q`, `query` and `search` were each pinned; these two carried the same
    // claim with no test. They decide whether `?name=Ada Lovelace failed` cuts
    // to end-of-line or leaves ` Lovelace` standing.
    expect(redactFreeText(`GET /p?${key}=Ada Lovelace failed`)).toBe('GET /p')
  })

  it('keeps a frame SOURCE CONTEXT readable', () => {
    // `pre_context` and `post_context` are arrays, an array element is keyless,
    // and the body rule cuts a keyless string outright — so every source line of
    // every frame reached Sentry as the marker. Pure diagnostic loss with no
    // leak class behind it: these hold the compiled bundle's own code, not
    // candidate data, and this module's argument is that a stack Sentry cannot
    // symbolicate is worse than a scrubbed one.
    const scrubbed = scrubSentryEvent({
      exception: {
        values: [
          {
            value: 'boom',
            stacktrace: {
              frames: [
                {
                  filename: 'https://bo.test/_nuxt/a.js',
                  pre_context: [
                    'const a = 1',
                    'const email = "jane@acme.test"',
                    'const token = "https://bo.test/interview/TOK99"',
                  ],
                  context_line: 'throw new Error("boom")',
                  post_context: ['return a + b'],
                },
              ],
            },
          },
        ],
      },
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.exception)

    // BOTH halves. Cutting these to the marker was the original bug; restoring
    // them RAW was the over-correction, and it gave source lines the only
    // zero-redaction path in the whole event — a bundled line reads
    // `const email = "jane@acme.test"` as readily as `const a = 1`.
    expect(encoded).toContain('const a = 1')
    expect(encoded).toContain('return a + b')
    expect(encoded).toContain('throw new Error')

    expect(encoded).not.toContain('jane@acme.test')
    expect(encoded).not.toContain('TOK99')
  })

  it.each(['app_env', 'node_env', 'build_env'])(
    'denies `%s`, because nothing distinguishes it from a request env dump',
    (key) => {
      // The RULING, pinned so the comment beside it cannot drift again: an
      // earlier version claimed `app.env` was spared. It is not — the dot folds
      // to `_`, `env` is the last segment, and denial is the safe side of an
      // ambiguity this module cannot resolve.
      const scrubbed = scrubSentryEvent({
        extra: { [key]: 'production' },
      } as unknown as ScrubbableEvent)

      expect(JSON.stringify(scrubbed.extra)).not.toContain('production')
    }
  )

  it('bounds the denied-key run walk, so a long key cannot freeze beforeSend', () => {
    // The bound is a performance guard and only a performance test can see it.
    // Unbounded, the walk is cubic — every start, every end, and a `join` inside
    // both — on a key whose length a request body influences: measured 845 ms of
    // main-thread freeze inside `beforeSend` against 1 ms with the bound.
    //
    // The twin guard already had this test ('scans a long hostile string in
    // linear time'); the key walk never got it.
    const hostileKey = Array.from({ length: 600 }, (_, i) => `seg${i}`).join('_')

    const started = performance.now()

    scrubSentryEvent({ extra: { [hostileKey]: 'x' } } as unknown as ScrubbableEvent)

    expect(performance.now() - started).toBeLessThan(250)
  })

  it('quotes the marker the way the DOCUMENT is quoted', () => {
    // A plain-quoted marker inside an escaped document closes the outer string
    // early and the rest of the payload stops being parseable — an error report
    // nobody can read, which is the outcome this module calls worse than a
    // scrubbed one.
    const blob = String.raw`{\"transcript\":\"TRANSCRIPT-SECRET-99\",\"other\":\"keep-this\"}`

    const scrubbed = scrubSentryEvent({
      message: `422 — ${blob}`,
    } as unknown as ScrubbableEvent)

    const message = scrubbed.message as unknown as string

    expect(message).not.toContain('TRANSCRIPT-SECRET-99')
    expect(message).toContain(String.raw`\"[redacted]\"`)
    expect(message).toContain('keep-this')
  })

  it('keeps an UNDENIED structure readable next to a denied one', () => {
    // The positive twin. Redacting the denied subtree must not swallow what
    // follows it — the scanner has to find the END of the value, not give up.
    const scrubbed = scrubSentryEvent({
      message:
        '422 — {"transcript":["step one, then", "SPEECH-SECRET-99"],"attempt":3,"route":"/score"}',
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.message)

    expect(encoded).not.toContain('SPEECH-SECRET-99')
    expect(encoded).toContain('attempt')
    expect(encoded).toContain('3')
  })

  it('redacts a TRUNCATED embedded document', () => {
    // Why pairs and not a parse: Sentry and most HTTP clients cap the body they
    // attach, so the embedded document routinely arrives cut off mid-value, and
    // a parse of that fails — which would hand the whole string back.
    const encoded = JSON.stringify(
      scrubSentryEvent({
        message: 'response truncated: {"candidate_ref":"CR-99","display_name":"Ada Love',
      } as unknown as ScrubbableEvent)
    )

    expect(encoded).not.toContain('CR-99')
  })

  it.each(['content_type', 'content_length', 'contentType'])(
    'keeps the ORDINARY diagnostic key `%s` out of the run walk',
    (key) => {
      // The run walk matches any contiguous segment, and a bare word like
      // `content` then matched inside every compound — redacting `content_type`
      // and `content_length`, which are exactly the diagnostics this module says
      // it must not destroy. Single-word entries match only the whole key or the
      // LAST segment.
      const scrubbed = scrubSentryEvent({
        extra: { [key]: 'application/json' },
      } as unknown as ScrubbableEvent)

      expect((scrubbed.extra as Record<string, unknown>)[key]).toBe('application/json')
    }
  )

  it('carries the body rule into a NULL-PROTOTYPE container', () => {
    // Under the GENERAL rule, which is the only place the two prototypes can
    // diverge. `scrubRecord` sends object values to `scrubBody`; `scrubNonPlain`
    // without `bodyRule` sends them to `scrubValue`. So a null-prototype map
    // shipped its keyless blob verbatim while the identical plain object was cut.
    const bare = Object.create(null) as Record<string, unknown>

    bare['items'] = ['{"candidate_ref":"CR-99","display_name":"Ada Lovelace"}']

    const encoded = JSON.stringify(
      scrubSentryEvent({ transaction: bare } as unknown as ScrubbableEvent)
    )

    expect(encoded).not.toContain('CR-99')
    expect(encoded).not.toContain('Ada Lovelace')
    expect(encoded).toContain('items')
  })

  it('scrubs an ARRAY-shaped stacktrace instead of shipping it', () => {
    // The off-shape guard for `stacktrace`. Removing it ships every denied key
    // raw — and `entry_url` is a bearer credential by this module's own header,
    // not merely diagnostic context.
    const scrubbed = scrubSentryEvent({
      exception: {
        values: [
          {
            value: 'boom',
            stacktrace: [
              {
                candidate_ref: 'CR-99',
                display_name: 'Ada Lovelace',
                vars: { entry_url: 'https://bo.test/interview/TOKEN99' },
              },
            ],
          },
        ],
      },
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.exception)

    expect(encoded).not.toContain('CR-99')
    expect(encoded).not.toContain('Ada Lovelace')
    expect(encoded).not.toContain('TOKEN99')
  })

  it('keeps a Map a walked object rather than flattening it to {}', () => {
    // A Map must come back as a walked OBJECT, not flattened to `{}` —
    // `Object.entries(new Map(...))` is empty, which is the allowlist damage
    // this module argues against. The positive assertion is the point: the
    // denied key is cut AND the diagnostic key survives.
    const scrubbed = scrubSentryEvent({
      transaction: new Map([
        ['candidate_ref', 'MAPARM99'],
        ['route', '/participants'],
      ]),
    } as unknown as ScrubbableEvent)

    expect(scrubbed.transaction).toEqual({
      candidate_ref: '[redacted]',
      route: '/participants',
    })
  })

  it('scrubs a NULL-PROTOTYPE object through the non-plain path', () => {
    // `isPlainObject` deliberately answers `Object.prototype` ONLY, and the
    // comment there claims a null-prototype object comes back identically
    // scrubbed via `scrubNonPlain`. Nothing backed that claim; this does.
    const bare = Object.create(null) as Record<string, unknown>

    bare['candidate_ref'] = 'NULLPROTO99'

    const scrubbed = scrubSentryEvent({
      extra: { bare },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.extra)).not.toContain('NULLPROTO99')
  })

  it('survives a throwing `frames` accessor on a stacktrace', () => {
    // A plain read here throws straight OUT of `beforeSend` and the event is
    // lost whole — the exact failure the cycle-guard docblock calls "monitoring
    // dying silently on the richest events". Nothing else in the suite walks
    // this door, so without this test the guard can be deleted in silence.
    const stacktrace = {}

    Object.defineProperty(stacktrace, 'frames', {
      get(): unknown {
        throw new Error('frames boom')
      },
      enumerable: true,
      configurable: true,
    })

    // The SURVIVING EVENT, not `not.toThrow()`. The mutant does not throw
    // either — it loses the whole event, which is the outcome this guard
    // exists to prevent, and an absence-of-throw assertion cannot see that.
    const scrubbed = scrubSentryEvent({
      message: 'render failed',
      exception: { values: [{ value: 'x', stacktrace }] },
    } as unknown as ScrubbableEvent)

    expect(scrubbed.message).toBe('render failed')
    expect(scrubbed.exception).toBeDefined()
  })

  it('keeps a SHARED non-cyclic reference under a non-string `message`', () => {
    // `seen` is the ancestor PATH, not a visited set. As a visited set it
    // destroyed `{ a: shared, b: shared }`, returning the second one as
    // `[circular]` — a real diagnostic erased by a privacy guard.
    //
    // Named for the FIELD, not a function. An earlier title claimed this
    // exercised `scrubValue`'s guard; it does not — a non-string `message`
    // routes `scrubOffShape` → `scrubBody`, whose own guard does the work.
    // Asserting under a function that never runs is how a deleted guard stays
    // green.
    const shared = { note: 'diagnostic context' }

    const scrubbed = scrubSentryEvent({
      message: [shared, shared],
    } as unknown as ScrubbableEvent)

    const message = scrubbed.message as unknown as Record<string, unknown>[]

    expect(message[1]).toEqual({ note: 'diagnostic context' })
  })

  it('survives a throwing getter INSIDE a context, and still scrubs it', () => {
    // `contexts.vue.propsData` on a reactive graph — the case this file cites by
    // name — was the one level the per-context spread left unguarded.
    //
    // The denied SIBLING is the point. A fixture that is nothing but a throwing
    // getter makes "did not throw" and "shipped the original unscrubbed" the
    // same green, so the null fallback could hand back the raw context and no
    // assertion would notice.
    const vue = {
      candidate_ref: 'CTXFALLBACK99',
      get propsData(): unknown {
        throw new Error('reactive boom')
      },
    }

    let scrubbed: ScrubbableEvent | null = null

    expect(() => {
      scrubbed = scrubSentryEvent({ contexts: { vue } } as unknown as ScrubbableEvent)
    }).not.toThrow()

    expect(JSON.stringify(scrubbed)).not.toContain('CTXFALLBACK99')
  })

  it('redacts, never drops, a property read that throws', () => {
    // `readGuarded` returning `undefined` on failure instead of the marker is a
    // silent hole: the key vanishes and the event still looks scrubbed. Pin the
    // marker itself, not merely the absence of a crash.
    // NON-enumerable on purpose. An enumerable throwing `cause` breaks the
    // spread instead, so `safeClone` fails first and the whole object comes
    // back as the marker — which is green whatever `readGuarded` returns.
    // Hidden from the spread, `cause` reaches `readGuarded` and nothing else,
    // and the key must come back PRESENT and redacted, not quietly missing.
    const boom = new Error('outer')

    Object.defineProperty(boom, 'cause', {
      get(): unknown {
        throw new Error('cause boom')
      },
      enumerable: false,
      configurable: true,
    })

    const scrubbed = scrubSentryEvent({
      contexts: { http: { url: 'https://bo.test/x', err: boom } },
    } as unknown as ScrubbableEvent)

    const err = (scrubbed.contexts as Record<string, Record<string, unknown>>)['http']?.[
      'err'
    ] as Record<string, unknown>

    expect(err).toHaveProperty('cause', '[redacted]')
  })
})

describe('the branch deltas nothing distinguished', () => {
  it('scrubs a NON-object stacktrace', () => {
    // Fixtured with the JSON BLOB, not `at /interview/STACKSTR99`. The route
    // fixture was a string `redactFreeText` can recognise, so the assertion
    // passed whichever helper the branch used — while the adjacent `contexts`
    // test one line below already used the blob and asserted the stronger rule.
    // Two adjacent tests, two standards, and the weaker one was guarding the
    // branch that was actually broken.
    const scrubbed = scrubSentryEvent({
      exception: {
        values: [{ value: 'boom', stacktrace: '{"candidate_ref":"STACKSTR99"}' }],
      },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.exception)).not.toContain('STACKSTR99')
  })

  it.each([
    ['a STRING breadcrumb element', (blob: string): unknown[] => [blob]],
    ['an ARRAY breadcrumb element', (blob: string): unknown[] => [[blob]]],
  ])('cuts a keyless blob in %s', (_name, build: (blob: string) => unknown[]) => {
    // A breadcrumb element is keyless — nothing for `isDeniedKey` to deny. And
    // `typeof [] === 'object'`, so the ARRAY case cleared the element guard
    // entirely: `safeClone` spread it into `{"0": …}` and every element landed
    // under an index key that denies nothing. Shape lost AND the blob shipped.
    const blob = '{"candidate_ref":"CR-99","display_name":"Ada Lovelace"}'

    const encoded = JSON.stringify(
      scrubSentryEvent({ breadcrumbs: build(blob) } as unknown as ScrubbableEvent)
    )

    expect(encoded).not.toContain('CR-99')
    expect(encoded).not.toContain('Ada Lovelace')
  })

  it('cuts a raw JSON string under contexts, like extra and tags', () => {
    const scrubbed = scrubSentryEvent({
      contexts: '{"candidate_ref":"CTXSTR99"}',
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed)).not.toContain('CTXSTR99')
  })

  it('redacts a frame abs_path, not only its filename', () => {
    const scrubbed = scrubSentryEvent({
      exception: {
        values: [
          {
            value: 'boom',
            stacktrace: {
              // An ABSOLUTE url: a route path is collapsed by the generic
              // free-text pass anyway, so the old fixture passed with the rule
              // deleted. This one needs it — without, the path is reduced to the
              // bare origin and Sentry cannot symbolicate.
              frames: [
                { filename: 'https://bo.test/a.js', abs_path: 'https://bo.test/_nuxt/D1abc.js' },
              ],
            },
          },
        ],
      },
    } as unknown as ScrubbableEvent)

    const frame = (
      scrubbed.exception?.values?.[0] as {
        stacktrace?: { frames?: { abs_path?: string }[] }
      }
    )?.stacktrace?.frames?.[0]

    expect(frame?.abs_path).toBe('https://bo.test/_nuxt/D1abc.js')
  })

  it('gives to and from the URL treatment, keeping the route', () => {
    // `redactFreeText` would reduce these to nothing useful; `redactUrl` keeps
    // the redacted route, which is most of a navigation breadcrumb's worth.
    const scrubbed = scrubBreadcrumb({
      category: 'navigation',
      data: { from: '/interview/NAVFROM99', to: '/interview/NAVTO99' },
    } as unknown as Parameters<typeof scrubBreadcrumb>[0])

    const data = scrubbed.data as Record<string, unknown>

    expect(String(data['from'])).toBe('/interview/:token')
    expect(String(data['to'])).toBe('/interview/:token')
  })

  it('cuts a STRING element of exception.values rather than char-splitting it', () => {
    const scrubbed = scrubSentryEvent({
      exception: { values: ['{"candidate_ref":"VALSTR99"}'] },
    } as unknown as ScrubbableEvent)

    const rejoined = JSON.stringify(scrubbed.exception)

    expect(rejoined).not.toContain('VALSTR99')
  })
})

describe('the two reads that bypassed their own guard', () => {
  it.each(['data', 'message'])(
    'survives a non-enumerable throwing %s accessor on a breadcrumb',
    (field) => {
      // A spread cannot see a non-enumerable accessor, so `safeClone` succeeds
      // and the raw read detonates — the throw escapes beforeSend and the event
      // is lost. The earlier test named these two reads and then pointed at the
      // url loop, which already had a guard.
      const crumb: Record<string, unknown> = { category: 'ui.click' }

      Object.defineProperty(crumb, field, {
        get() {
          throw new Error('boom')
        },
        enumerable: false,
        configurable: true,
      })

      expect(() =>
        scrubBreadcrumb(crumb as unknown as Parameters<typeof scrubBreadcrumb>[0])
      ).not.toThrow()
    }
  )
})

describe('a context key that is not called data', () => {
  it.each(['propsData', 'state', 'anything'])(
    'cuts a keyless JSON body under contexts.vue.%s',
    (key) => {
      // `propsData` is the key this module names by hand in its cycle-guard
      // docblock, and `state` is what Sentry's Pinia/Vuex integration writes.
      // The identical body was cut under `data` and shipped under these.
      const scrubbed = scrubSentryEvent({
        contexts: { vue: { [key]: { items: ['{"candidate_ref":"CTXKEY99"}'] } } },
      } as unknown as ScrubbableEvent)

      expect(JSON.stringify(scrubbed.contexts)).not.toContain('CTXKEY99')
    }
  )
})

describe('the body rule is TRANSITIVE', () => {
  const BODY = '{"candidate_ref":"TRANS99","q":"Ada Lovelace"}'

  it('cuts a nested envelope under breadcrumb.data', () => {
    // A top-level array `data` was cut and a NESTED one was not — `{items: […]}`
    // is the envelope this file names by hand one function over.
    const scrubbed = scrubBreadcrumb({
      data: { items: [BODY] },
    } as unknown as Parameters<typeof scrubBreadcrumb>[0])

    expect(JSON.stringify(scrubbed.data)).not.toContain('TRANS99')
  })

  it('cuts an ARRAY-valued context', () => {
    // `isMap` required `!Array.isArray`, so an array context skipped the context
    // handling entirely.
    const scrubbed = scrubSentryEvent({
      contexts: { audit: [BODY] },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.contexts)).not.toContain('TRANS99')
  })

  it('cuts a keyless string inside a Set within a body', () => {
    const scrubbed = scrubSentryEvent({
      request: { url: 'https://bo.test/x', data: { items: new Set([BODY]) } },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.request)).not.toContain('TRANS99')
  })

  it('cuts a container on an exception VALUE', () => {
    const scrubbed = scrubSentryEvent({
      exception: { values: [{ value: 'boom', data: [BODY] }] },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.exception)).not.toContain('TRANS99')
  })

  it('cuts a nested fingerprint array', () => {
    const scrubbed = scrubSentryEvent({
      fingerprint: [[BODY]],
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.fingerprint)).not.toContain('TRANS99')
  })

  it('still keeps a Map entry readable — an entry HAS a key', () => {
    const scrubbed = scrubBreadcrumb({
      data: new Map([
        ['candidate_ref', 'MAPREF99'],
        ['note', 'kept'],
      ]),
    } as unknown as Parameters<typeof scrubBreadcrumb>[0])

    const encoded = JSON.stringify(scrubbed.data)

    expect(encoded).not.toContain('MAPREF99')
    expect(encoded).toContain('kept')
  })
})

describe('the guards assert their OUTPUT, not merely that they returned', () => {
  const hostile = (): Record<string, unknown> => {
    const o: Record<string, unknown> = { candidate_ref: 'GUARD99' }

    Object.defineProperty(o, 'boom', {
      get() {
        throw new Error('nope')
      },
      enumerable: true,
      configurable: true,
    })

    return o
  }

  it.each([
    ['breadcrumb', (h: object) => JSON.stringify(scrubBreadcrumb(h as never))],
    [
      'exception value',
      (h: object) => JSON.stringify(scrubSentryEvent({ exception: { values: [h] } } as never)),
    ],
    ['context', (h: object) => JSON.stringify(scrubSentryEvent({ contexts: { c: h } } as never))],
    [
      'http context',
      (h: object) => JSON.stringify(scrubSentryEvent({ contexts: { http: h } } as never)),
    ],
  ])('does not ship the raw original from the %s guard', (_name, run) => {
    // `not.toThrow()` and "shipped the raw original" are the same green. The
    // sibling key is what distinguishes them.
    expect(run(hostile())).not.toContain('GUARD99')
  })

  it('denies a bare _key suffix the segment loop cannot reach', () => {
    // `provider_api_key` resolves through the suffix loop as `api_key`; only
    // `signing_key` / `session_key` need this clause.
    const scrubbed = scrubSentryEvent(eventWith({ signing_key: 'SIGN99', session_key: 'SESS99' }))

    const encoded = JSON.stringify(scrubbed.extra)

    expect(encoded).not.toContain('SIGN99')
    expect(encoded).not.toContain('SESS99')
  })

  it('renames a context key that CARRIES an address', () => {
    // The documented context-key rename: `scrubRecord(prepared)` is what applies
    // it, and replacing that with `prepared` passed.
    const scrubbed = scrubSentryEvent({
      contexts: { 'jane@acme.test': { note: 'x' } },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.contexts)).not.toContain('jane@acme.test')
  })

  it('keeps a __proto__ key written at the TOP level, not one nested inside', () => {
    // The earlier `it.each` put `__proto__` one level below the write it named.
    const parsed = JSON.parse('{"__proto__":{"candidate_ref":"TOP99"},"keep":"ok"}') as Record<
      string,
      unknown
    >

    const scrubbed = scrubSentryEvent(parsed as unknown as ScrubbableEvent)

    expect(Object.keys(scrubbed)).toContain('__proto__')
    expect(JSON.stringify(scrubbed)).not.toContain('TOP99')
  })
})

describe('the four branches still resolving through a neighbour', () => {
  it('returns the MARKER when a context cannot be cloned at all', () => {
    // A Proxy whose ownKeys throws defeats `safeClone` itself, so the fallback
    // is the only thing standing between the raw context and the wire.
    const hostile = new Proxy(
      { candidate_ref: 'PROXY99' },
      {
        ownKeys() {
          throw new Error('nope')
        },
      }
    )

    const scrubbed = scrubSentryEvent({
      contexts: { c: hostile },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.contexts)).not.toContain('PROXY99')
  })

  it('keeps the body rule through a Map VALUE that is a container', () => {
    // A Map entry follows the object rule, but its CONTAINERS stay on the body
    // rule — a keyless JSON blob inside one has nothing to deny.
    const scrubbed = scrubSentryEvent({
      request: {
        url: 'https://bo.test/x',
        data: new Map([['items', ['{"candidate_ref":"MAPVAL99"}']]]),
      },
    } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.request)).not.toContain('MAPVAL99')
  })

  it.each([
    ['Map', () => new Map([['candidate_ref', 'NONPLAIN99']])],
    ['Set', () => new Set(['OPAQUESET99'])],
  ])('walks a %s reached through the NON-PLAIN path', (_name, build) => {
    // Through `transaction`, an OFF-SHAPE field, which is the narrowest route a
    // container can take into the walk. It does NOT reach `scrubNonPlain` —
    // `scrubBodyInner` catches Map and Set first, which is why the arms that
    // used to sit there were dead code and why this test's earlier comment
    // naming them was wrong. What it asserts is the behaviour: a container
    // arriving on the off-shape path is still walked, not flattened.
    const scrubbed = scrubSentryEvent({
      transaction: build(),
    } as unknown as ScrubbableEvent)

    const encoded = JSON.stringify(scrubbed.transaction)

    expect(encoded).not.toContain('NONPLAIN99')
    expect(encoded).not.toContain('OPAQUESET99')

    // And the container SURVIVED as a container. Replacing either arm's body
    // with `return {}` satisfies both absence checks above while erasing the
    // walk entirely — which is how both arms read as dead code.
    expect(scrubbed.transaction).not.toEqual({})
  })
})

describe('the defence-in-depth branch for shapes nobody named', () => {
  it('cuts an absolute URL that new URL() refuses to parse', () => {
    // `ABSOLUTE_URL_PATTERN` matches an out-of-range port; `new URL()` throws on
    // it. The known shapes survive because the path pass runs first — this is
    // the branch for the ones nobody named, and it must return the marker, not
    // the raw match.
    const out = redactFreeText('entry link https://bo.test:99999/download/SECRETABC rejected')

    expect(out).not.toContain('SECRETABC')
    expect(out).toContain('[redacted]')
  })

  it('scrubs a null-prototype object identically', () => {
    // The clause claiming this needed special handling is gone; the behaviour it
    // claimed is asserted here instead.
    const bare = Object.create(null) as Record<string, unknown>
    bare['candidate_ref'] = 'BARE99'
    bare['keep'] = 'ok'

    const scrubbed = scrubSentryEvent({ custom: bare } as unknown as ScrubbableEvent)
    const encoded = JSON.stringify(scrubbed)

    expect(encoded).not.toContain('BARE99')
    expect(encoded).toContain('ok')
  })
})

describe('a getter-only accessor on the PROTOTYPE', () => {
  it.each(['name', 'message'])('survives an Error subclass whose %s is getter-only', (field) => {
    // `scrubNonPlain` preserves the prototype on purpose, so `[[Set]]` walks
    // the chain — and in strict mode a plain assignment onto a getter-only
    // accessor THROWS rather than no-opping. This is the shape of the error
    // class most likely to be thrown.
    class ValidationError extends Error {}

    Object.defineProperty(ValidationError.prototype, field, {
      get() {
        return 'ValidationError for ada@acme.test'
      },
      configurable: true,
    })

    const scrubbed = scrubSentryEvent(eventWith({ cause: new ValidationError('boom') }))

    expect(JSON.stringify(scrubbed.extra)).not.toContain('ada@acme.test')
  })

  it('keeps an ARRAY stacktrace an array', () => {
    const scrubbed = scrubSentryEvent({
      exception: {
        values: [{ value: 'boom', stacktrace: [{ filename: 'https://bo.test/a.js' }] }],
      },
    } as unknown as ScrubbableEvent)

    const stack = (scrubbed.exception?.values?.[0] as { stacktrace?: unknown })?.stacktrace

    expect(Array.isArray(stack)).toBe(true)
  })
})

describe('the miss that inequality could not detect', () => {
  it.each([
    ['a query string', '/x/interview/LIVE-TOKEN?email=a@b.test'],
    ['a trailing slash', '/x/interview/LIVE-TOKEN/'],
  ])('cuts the credential when the path carries %s', (_name, path) => {
    // `redactAnalyticsPath` strips the query and trailing slashes, so the value
    // came back CHANGED with no pattern having matched — it read as a hit, the
    // unanchored fallback never ran, and a single-use token shipped verbatim.
    expect(redactUrl(path)).not.toContain('LIVE-TOKEN')
    expect(redactFreeText(path)).not.toContain('LIVE-TOKEN')
  })

  it.each([
    [
      'breadcrumb rest',
      (b: unknown) => JSON.stringify(scrubBreadcrumb({ category: 'x', foo: b } as never)),
    ],
    [
      'request rest',
      (b: unknown) =>
        JSON.stringify(scrubSentryEvent({ request: { url: '/x', other: b } } as never).request),
    ],
    [
      'exception rest',
      (b: unknown) =>
        JSON.stringify(
          scrubSentryEvent({ exception: { other: b, values: [] } } as never).exception
        ),
    ],
  ])('cuts a keyless JSON body in the %s', (_name, run) => {
    expect(run(['{"candidate_ref":"REST99"}'])).not.toContain('REST99')
  })
})

describe('a denied name sitting anywhere inside a compound key', () => {
  it.each(['candidate_ref_original', 'display_name_raw', 'entry_url_copy', 'x_candidate_ref_y'])(
    'denies %s',
    (key) => {
      // Suffix-only matching left the prefix side open, and a denied name is
      // still that name wherever it sits in a compound key.
      const scrubbed = scrubSentryEvent(eventWith({ [key]: 'COMPOUND99' }))

      expect(JSON.stringify(scrubbed.extra)).not.toContain('COMPOUND99')
    }
  )

  it.each(['name', 'message', 'cause', 'stack'])(
    'survives a throwing %s accessor on an Error',
    (field) => {
      // These four are NON-ENUMERABLE, so neither `safeClone` nor
      // `Object.entries` ever reached them and a plain read killed the event.
      const err = new Error('boom')

      Object.defineProperty(err, field, {
        get() {
          throw new Error('nope')
        },
        configurable: true,
      })

      expect(() => scrubSentryEvent(eventWith({ cause: err }))).not.toThrow()
    }
  )

  it('returns the MARKER when a context cannot be cloned, not the raw context', () => {
    const hostile = new Proxy(
      { candidate_ref: 'FALLBACK99' },
      {
        ownKeys() {
          throw new Error('nope')
        },
      }
    )

    const scrubbed = scrubSentryEvent({ contexts: { c: hostile } } as unknown as ScrubbableEvent)

    expect(JSON.stringify(scrubbed.contexts)).not.toContain('FALLBACK99')
    expect(JSON.stringify(scrubbed.contexts)).toContain('[redacted]')
  })
})
