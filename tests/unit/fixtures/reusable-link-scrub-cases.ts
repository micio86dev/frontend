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
 */

/** The 43 base64url characters after the marker, `-` and `_` included. */
export const REUSABLE_LINK_SECRET = '9AuXUvnfk8dgg-mOHfBcWFbQ98k_MXZ5SChgVAqzCpY'

/** A complete token: `beai_rl_` + 43 characters. */
export const REUSABLE_LINK_TOKEN = `beai_rl_${REUSABLE_LINK_SECRET}`

/** The lookup hash the api stores: 64 hex characters, only ever denied BY KEY. */
export const REUSABLE_LINK_HASH = '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881'

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
