/**
 * useReusableLinkRedeem — unit tests (reusable-interview-links, AD-16)
 *
 * `POST /api/reusable-links/redeem` exchanges the link token for a candidate
 * access token. The token is a live, non-expiring credential, so the contract
 * this pins is mostly about where it must NOT go:
 *
 *  - it travels in the JSON BODY as `link_token` — never in the URL or a query
 *    string (an access log would keep it), never under a field named `token`
 *    (the api's default guard parses that name before the controller runs);
 *  - it never comes back out: not in a result, not in a log line.
 *
 * Since reusable-link-visitor-identity the body also carries the visitor's
 * `display_name` and `email`, which are personal data held to the same rule: they
 * travel only in the JSON body and never come back out of a result or a log line.
 *
 * The composable never throws. It maps the api's documented answers —
 * 200 / 403 / 404 / 409 / 422 / 429 — and everything else onto seven outcomes the
 * page can switch on, so the page cannot forget a case.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetchImpl } = vi.hoisted(() => ({ mockFetchImpl: vi.fn() }))

vi.mock('ofetch', () => ({ $fetch: mockFetchImpl }))

// eslint-disable-next-line import/first
import { useReusableLinkRedeem } from '~/app/composables/useReusableLinkRedeem'
// eslint-disable-next-line import/first
import { REUSABLE_LINK_TOKEN } from './fixtures/reusable-link-scrub-cases'

const ACCESS_TOKEN = 'header.payload.signature'

/** Sentinels no other string in this file contains, so a leak is a substring match. */
const IDENTITY = { displayName: 'Ada Sentinel Lovelace', email: 'ada.sentinel@example.test' }

/** What ofetch throws for an HTTP error: a FetchError with the response status and parsed body. */
function httpError(status: number, data?: unknown): Error {
  return Object.assign(new Error(`${status} error`), {
    status,
    statusCode: status,
    data,
    // ofetch keeps the request it sent, body included. A result built from this
    // object would carry the token out; the composable must not.
    options: {
      method: 'POST',
      body: {
        link_token: REUSABLE_LINK_TOKEN,
        display_name: IDENTITY.displayName,
        email: IDENTITY.email,
      },
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal(
    'useRuntimeConfig',
    vi.fn(() => ({ public: { apiBase: 'https://api.test' } }))
  )
})

describe('useReusableLinkRedeem — the request', () => {
  it('POSTs EXACTLY {link_token, display_name, email} in the JSON body, to /reusable-links/redeem', async () => {
    mockFetchImpl.mockResolvedValueOnce({ access_token: ACCESS_TOKEN })

    await useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)

    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
    const [url, options] = mockFetchImpl.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('https://api.test/reusable-links/redeem')
    expect(options['method']).toBe('POST')
    expect(options['body']).toEqual({
      link_token: REUSABLE_LINK_TOKEN,
      display_name: IDENTITY.displayName,
      email: IDENTITY.email,
    })
    expect(Object.keys(options['body'] as Record<string, unknown>).sort()).toEqual([
      'display_name',
      'email',
      'link_token',
    ])
  })

  it('never puts the token or the identity in the URL, in a query string or under a field named `token`', async () => {
    mockFetchImpl.mockResolvedValueOnce({ access_token: ACCESS_TOKEN })

    await useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)

    const [url, options] = mockFetchImpl.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).not.toContain('beai_rl_')
    expect(url).not.toContain(IDENTITY.email)
    expect(url).not.toContain(encodeURIComponent(IDENTITY.email))
    expect(url).not.toContain(encodeURIComponent(IDENTITY.displayName))
    expect(url).not.toContain('?')
    expect(options['params']).toBeUndefined()
    expect(options['query']).toBeUndefined()
    expect(Object.keys(options['body'] as Record<string, unknown>)).not.toContain('token')
    // No credential header either: this endpoint ignores Authorization, and the
    // composable must not invent one from a stored session.
    expect(options['headers']).toBeUndefined()
  })

  it('sends the same token and identity again on a second call, because the caller owns retry', async () => {
    mockFetchImpl.mockResolvedValue({ access_token: ACCESS_TOKEN })
    const { redeem } = useReusableLinkRedeem()

    await redeem(REUSABLE_LINK_TOKEN, IDENTITY)
    await redeem(REUSABLE_LINK_TOKEN, IDENTITY)

    expect(mockFetchImpl).toHaveBeenCalledTimes(2)
    for (const call of mockFetchImpl.mock.calls as Array<[string, Record<string, unknown>]>) {
      expect(call[1]['body']).toEqual({
        link_token: REUSABLE_LINK_TOKEN,
        display_name: IDENTITY.displayName,
        email: IDENTITY.email,
      })
    }
  })
})

describe('useReusableLinkRedeem — the outcome', () => {
  it('200 -> ok, carrying the access token', async () => {
    mockFetchImpl.mockResolvedValueOnce({ access_token: ACCESS_TOKEN })

    await expect(useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)).resolves.toEqual({
      kind: 'ok',
      accessToken: ACCESS_TOKEN,
    })
  })

  it.each([
    ['an empty body', {}],
    ['a null body', null],
    ['a numeric access_token', { access_token: 42 }],
    ['an empty access_token', { access_token: '' }],
  ])('a 200 with %s is a failure, never an ok without a token', async (_name, body) => {
    mockFetchImpl.mockResolvedValueOnce(body)

    await expect(useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)).resolves.toEqual({
      kind: 'failed',
    })
  })

  it('404 -> not_found (unknown, malformed and disabled links are one answer)', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(404, { message: 'Not found.' }))

    await expect(useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)).resolves.toEqual({
      kind: 'not_found',
    })
  })

  it('403 with a redirect_url -> forbidden, carrying that url', async () => {
    mockFetchImpl.mockRejectedValueOnce(
      httpError(403, { message: 'Access denied.', redirect_url: 'https://client.example/closed' })
    )

    await expect(useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)).resolves.toEqual({
      kind: 'forbidden',
      redirectUrl: 'https://client.example/closed',
    })
  })

  it.each([
    ['null', { message: 'Access denied.', redirect_url: null }],
    ['absent', { message: 'Access denied.' }],
    ['not a string', { message: 'Access denied.', redirect_url: 123 }],
    ['no body at all', undefined],
  ])('403 with a redirect_url that is %s -> forbidden with no url', async (_name, data) => {
    mockFetchImpl.mockRejectedValueOnce(httpError(403, data))

    await expect(useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)).resolves.toEqual({
      kind: 'forbidden',
      redirectUrl: null,
    })
  })

  it('429 -> busy, which is retryable and says nothing about the link', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(429, { message: 'Too many attempts.' }))

    await expect(useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)).resolves.toEqual({
      kind: 'busy',
    })
  })

  it.each([500, 502, 503, 504])('a %i from the api -> failed (retryable)', async (status) => {
    mockFetchImpl.mockRejectedValueOnce(httpError(status))

    await expect(useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)).resolves.toEqual({
      kind: 'failed',
    })
  })

  it('a network failure with no status -> failed (retryable)', async () => {
    mockFetchImpl.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await expect(useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)).resolves.toEqual({
      kind: 'failed',
    })
  })

  it('reads the status from `statusCode` too, which is what ofetch exposes on some errors', async () => {
    mockFetchImpl.mockRejectedValueOnce(Object.assign(new Error('x'), { statusCode: 404 }))

    await expect(useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)).resolves.toEqual({
      kind: 'not_found',
    })
  })

  it.each([400, 401, 405, 410])(
    'an unexpected %i is a retryable failure, never a claim that the link is invalid',
    async (status) => {
      // The api documents 200, 403, 404, 409, 422 and 429 for this endpoint. Anything else
      // is not the link's fault, and `not_found` would be untrue.
      mockFetchImpl.mockRejectedValueOnce(httpError(status))

      await expect(useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)).resolves.toEqual({
        kind: 'failed',
      })
    }
  )
})

describe('useReusableLinkRedeem — 422 and 409 (the visitor identity)', () => {
  it('422 -> invalid, carrying ONLY the known field keys from errors', async () => {
    mockFetchImpl.mockRejectedValueOnce(
      httpError(422, {
        message: 'The email field must be a valid email address.',
        errors: { email: ['The email field must be a valid email address.'] },
      })
    )

    await expect(useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)).resolves.toEqual({
      kind: 'invalid',
      fields: ['email'],
    })
  })

  it('422 on both fields -> both, in display_name then email order', async () => {
    mockFetchImpl.mockRejectedValueOnce(
      httpError(422, { errors: { email: ['x'], display_name: ['y'] } })
    )

    await expect(useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)).resolves.toEqual({
      kind: 'invalid',
      fields: ['display_name', 'email'],
    })
  })

  it('422 ignores a key it does not know and keeps no server message', async () => {
    mockFetchImpl.mockRejectedValueOnce(
      httpError(422, {
        message: 'SERVER-TEXT-MUST-NOT-SURVIVE',
        errors: { email: ['SERVER-TEXT-MUST-NOT-SURVIVE'], link_token: ['nope'], other: ['nope'] },
      })
    )

    const outcome = await useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)

    expect(outcome).toEqual({ kind: 'invalid', fields: ['email'] })
    expect(JSON.stringify(outcome)).not.toContain('SERVER-TEXT')
  })

  it.each([
    ['no errors key', { message: 'x' }],
    ['an empty errors object', { errors: {} }],
    ['only unknown keys', { errors: { link_token: ['x'] } }],
    ['errors that is not an object', { errors: 'x' }],
    ['no body at all', undefined],
  ])('422 with %s -> failed (retryable), never a silent no-op', async (_name, data) => {
    mockFetchImpl.mockRejectedValueOnce(httpError(422, data))

    await expect(useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)).resolves.toEqual({
      kind: 'failed',
    })
  })

  it('409 with message duplicate_enrolment -> duplicate', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(409, { message: 'duplicate_enrolment' }))

    await expect(useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)).resolves.toEqual({
      kind: 'duplicate',
    })
  })

  it.each([
    ['another message', { message: 'something_else' }],
    ['no message', {}],
    ['no body at all', undefined],
  ])('409 with %s -> failed, not a claim that the address is taken', async (_name, data) => {
    mockFetchImpl.mockRejectedValueOnce(httpError(409, data))

    await expect(useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)).resolves.toEqual({
      kind: 'failed',
    })
  })
})

describe('useReusableLinkRedeem — the token and the identity never leak', () => {
  it.each([
    ['a 404', httpError(404)],
    ['a 403', httpError(403, { redirect_url: 'https://client.example/x' })],
    ['a 429', httpError(429)],
    ['a 500', httpError(500)],
    ['a 422', httpError(422, { errors: { email: ['x'], display_name: ['y'] } })],
    ['a 409', httpError(409, { message: 'duplicate_enrolment' })],
  ])(
    '%s: no outcome contains the token, the name or the email, and nothing is logged',
    async (_name, error) => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined)
      )
      mockFetchImpl.mockRejectedValueOnce(error)

      const outcome = await useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)

      const serialised = JSON.stringify(outcome)
      expect(serialised).not.toContain('beai_rl_')
      expect(serialised).not.toContain(IDENTITY.displayName)
      expect(serialised).not.toContain(IDENTITY.email)
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled()
        spy.mockRestore()
      }
    }
  )

  it('a success outcome carries the access token and nothing of the link token or the identity', async () => {
    mockFetchImpl.mockResolvedValueOnce({ access_token: ACCESS_TOKEN })

    const outcome = await useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)

    const serialised = JSON.stringify(outcome)
    expect(serialised).not.toContain('beai_rl_')
    expect(serialised).not.toContain(IDENTITY.displayName)
    expect(serialised).not.toContain(IDENTITY.email)
  })

  it('does not return or rethrow the HTTP client error, whose options carry the request body', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(500))

    const outcome = await useReusableLinkRedeem().redeem(REUSABLE_LINK_TOKEN, IDENTITY)

    expect(Object.keys(outcome)).toEqual(['kind'])
  })
})
