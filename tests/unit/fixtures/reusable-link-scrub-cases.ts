/**
 * Shared Sentry-scrubber fixtures for the reusable interview link token
 * (observability spec: "A Credential Carried In A URL Fragment Or A Request
 * Body Is Redacted Before Any Error Sink").
 *
 * THIS FILE EXISTS IN TWO COPIES, byte-identical: here and in
 * `frontend/tests/unit/fixtures/reusable-link-scrub-cases.ts`. The two Nuxt
 * scrubbers must apply the same rule, and one fixture set pinned in both is
 * what stops them drifting apart ("The two Nuxt scrubbers agree"). The
 * wrapper compares the copies with `cmp`.
 *
 * It is deliberately framework-free: plain data, no import from either app, so
 * the copies can be identical. Each suite imports it and runs it through its
 * own `scrubSentryEvent`.
 *
 * `REUSABLE_LINK_SCRUB_CASES`: after scrubbing, the serialised event must hold
 * neither the whole token nor its 43-character secret part.
 * `REUSABLE_LINK_UNTOUCHED_CASES`: strings that merely look like the token and
 * must survive, because an over-eager scrubber that eats ordinary text makes
 * the error report useless.
 * `REUSABLE_LINK_REDACTION_CASES`: exact input to output pairs for the value
 * pattern alone. The project-wide pattern (api, frontend, backoffice) is
 * `beai_rl_[A-Za-z0-9_-]{16,}`: deliberately over-inclusive, neither anchored
 * at the end nor fixed at 43 characters, so a token that is a little short, a
 * little long, or followed by more base64url text is cut whole rather than
 * leaving a readable tail. Only the 8-character display prefix (`beai_rl_`
 * plus 8) and other short look-alikes stay readable.
 */

/** The 43 base64url characters after the marker, `-` and `_` included. */
export const REUSABLE_LINK_SECRET = '9AuXUvnfk8dgg-mOHfBcWFbQ98k_MXZ5SChgVAqzCpY'

/** A complete token: `beai_rl_` + 43 characters. */
export const REUSABLE_LINK_TOKEN = `beai_rl_${REUSABLE_LINK_SECRET}`

/** The lookup hash the api stores: 64 hex characters, only ever denied BY KEY. */
export const REUSABLE_LINK_HASH = '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881'

/** What the scrubbers put where a value was cut. */
export const REUSABLE_LINK_REDACTED = '[redacted]'

/**
 * `length` characters of the base64url alphabet, `-` and `_` included, built
 * from the real secret so the fixture holds no second literal to drift.
 */
export function reusableLinkTail(length: number): string {
  return REUSABLE_LINK_SECRET.repeat(Math.ceil(length / REUSABLE_LINK_SECRET.length)).slice(
    0,
    length
  )
}

export interface ReusableLinkScrubCase {
  readonly name: string
  readonly event: Record<string, unknown>
}

export interface ReusableLinkUntouchedCase {
  readonly name: string
  readonly event: Record<string, unknown>
  /** The exact text that must still be present after scrubbing. */
  readonly survives: string
}

export const REUSABLE_LINK_SCRUB_CASES: readonly ReusableLinkScrubCase[] = [
  {
    name: 'a bare token in an event message',
    event: { message: `copy failed for ${REUSABLE_LINK_TOKEN}` },
  },
  {
    name: 'a token in an exception value',
    event: {
      exception: { values: [{ type: 'Error', value: `cannot open ${REUSABLE_LINK_TOKEN}` }] },
    },
  },
  {
    name: 'a token under an ordinary extra key',
    event: { extra: { note: `clipboard now holds ${REUSABLE_LINK_TOKEN}` } },
  },
  {
    name: 'a token inside an array under an ordinary extra key',
    event: { extra: { history: ['one', `two ${REUSABLE_LINK_TOKEN}`] } },
  },
  {
    name: 'a token in a fetch breadcrumb data field',
    event: {
      breadcrumbs: [
        {
          category: 'fetch',
          data: { url: '/api/projects/3/reusable-links', result: REUSABLE_LINK_TOKEN },
        },
      ],
    },
  },
  {
    name: 'a token in a breadcrumb message',
    event: { breadcrumbs: [{ category: 'console', message: `link ${REUSABLE_LINK_TOKEN}` }] },
  },
  {
    name: 'a token deep inside nested contexts',
    event: {
      contexts: { share: { nested: { deeper: [`x ${REUSABLE_LINK_TOKEN} y`] } } },
    },
  },
  {
    name: 'a token as the fragment of a relative interview path',
    event: { extra: { page: `/en/interview/reusable#${REUSABLE_LINK_TOKEN}` } },
  },
  {
    name: 'a token as the fragment of an absolute interview url',
    event: {
      extra: { page: `https://interview.example.test/interview/reusable#${REUSABLE_LINK_TOKEN}` },
    },
  },
  {
    name: 'a token as the fragment of a request url',
    event: {
      request: { url: `https://interview.example.test/interview/reusable#${REUSABLE_LINK_TOKEN}` },
    },
  },
  {
    name: 'a token in a transaction name',
    event: { transaction: `/interview/reusable#${REUSABLE_LINK_TOKEN}` },
  },
  {
    name: 'a token in a link_token request body field',
    event: { extra: { body: { link_token: REUSABLE_LINK_TOKEN } } },
  },
  {
    name: 'a token inside a JSON document embedded in prose',
    event: { message: `redeem failed: {"unrelated":"${REUSABLE_LINK_TOKEN}"}` },
  },
  {
    name: 'a token in an error stack message line',
    event: {
      extra: { cause: Object.assign(new Error(`bad ${REUSABLE_LINK_TOKEN}`), { name: 'Error' }) },
    },
  },
  {
    name: 'a token_hash value under its own key, at any depth',
    event: {
      extra: {
        token_hash: REUSABLE_LINK_HASH,
        tokenHash: REUSABLE_LINK_HASH,
        token_hashes: [REUSABLE_LINK_HASH],
        link: { token_hash: REUSABLE_LINK_HASH },
      },
    },
  },
]

export const REUSABLE_LINK_UNTOUCHED_CASES: readonly ReusableLinkUntouchedCase[] = [
  {
    name: 'the marker followed by only 10 characters',
    event: { extra: { note: 'saw beai_rl_0123456789 once' } },
    survives: 'beai_rl_0123456789',
  },
  {
    name: 'ordinary text containing rl_',
    event: { extra: { note: 'the rl_limit counter was reset' } },
    survives: 'rl_limit',
  },
  {
    // The VALUE pattern leaves the display prefix alone. A key literally named
    // `token_prefix` is a different matter: both scrubbers already cut any key
    // carrying the word `token`, so the carrier here is a neutral key.
    name: 'the 16-character display prefix, which is an identification aid',
    event: { extra: { prefix: 'beai_rl_AbCdEfGh' } },
    survives: 'beai_rl_AbCdEfGh',
  },
]

export interface ReusableLinkRedactionCase {
  readonly name: string
  readonly input: string
  /** The exact output of the value pattern alone. */
  readonly expected: string
  /**
   * Substrings that must be absent from a whole event carrying `input`, after
   * the complete scrubber ran (every other pass included). Empty when the case
   * is one that must survive.
   */
  readonly leaked: readonly string[]
}

const R = REUSABLE_LINK_REDACTED

export const REUSABLE_LINK_REDACTION_CASES: readonly ReusableLinkRedactionCase[] = [
  {
    name: 'a 16-character tail (the shortest the pattern cuts)',
    input: `see beai_rl_${reusableLinkTail(16)} here`,
    expected: `see ${R} here`,
    leaked: [reusableLinkTail(16)],
  },
  {
    name: 'a 42-character tail, one short of the real token',
    input: `see beai_rl_${reusableLinkTail(42)} here`,
    expected: `see ${R} here`,
    leaked: [reusableLinkTail(42)],
  },
  {
    name: 'the real 43-character token',
    input: `see ${REUSABLE_LINK_TOKEN} here`,
    expected: `see ${R} here`,
    leaked: [REUSABLE_LINK_SECRET],
  },
  {
    name: 'a 60-character tail is cut whole, with no readable remainder',
    input: `see beai_rl_${reusableLinkTail(60)} here`,
    expected: `see ${R} here`,
    leaked: [reusableLinkTail(60), reusableLinkTail(60).slice(43)],
  },
  {
    name: 'a token inside a url fragment',
    input: `https://interview.example.test/interview/reusable#${REUSABLE_LINK_TOKEN}`,
    expected: `https://interview.example.test/interview/reusable#${R}`,
    leaked: [REUSABLE_LINK_SECRET],
  },
  {
    name: 'a token inside a JSON string',
    input: `{"link_token":"${REUSABLE_LINK_TOKEN}","ok":true}`,
    expected: `{"link_token":"${R}","ok":true}`,
    leaked: [REUSABLE_LINK_SECRET],
  },
  {
    name: 'a token inside a query string',
    input: `/interview/reusable?ref=${REUSABLE_LINK_TOKEN}&lang=it`,
    expected: `/interview/reusable?ref=${R}&lang=it`,
    leaked: [REUSABLE_LINK_SECRET],
  },
  {
    name: 'two tokens in one string, each cut',
    input: `${REUSABLE_LINK_TOKEN} and beai_rl_${reusableLinkTail(20)}.`,
    expected: `${R} and ${R}.`,
    leaked: [REUSABLE_LINK_SECRET, reusableLinkTail(20)],
  },
  {
    name: 'the 8-character display prefix is an identification aid and stays readable',
    input: 'row beai_rl_AbCdEfGh is enabled',
    expected: 'row beai_rl_AbCdEfGh is enabled',
    leaked: [],
  },
  {
    name: 'a 15-character tail is below the minimum and stays readable',
    input: `saw beai_rl_${reusableLinkTail(15)} once`,
    expected: `saw beai_rl_${reusableLinkTail(15)} once`,
    leaked: [],
  },
]
