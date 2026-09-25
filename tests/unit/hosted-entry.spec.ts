/**
 * app/pages/i/[token].vue — public-api hosted entry route (step 5, G-32, G-33)
 *
 * `/i/{token}` is the hosted-interview entry route: the token is a public-api
 * SESSION token (SPEC §3.5, `sub=int_…`, `aud=embed`), not the sso-link JWT
 * `interview/[token].vue` consumes. It exchanges the session token AT MOST
 * ONCE against `GET /api/embed/exchange` (G-32 — the api mints the SAME
 * candidate JWT shape the sso-link exchange returns, no cookie is set) and
 * `replace`-redirects to the token-free session route, mirroring
 * `interview/[token].vue`'s refresh-safety structure.
 *
 * Coverage targets (T-TOK-011..014):
 *  - T-TOK-011: no stored session → EXACTLY ONE GET /api/embed/exchange call;
 *    the returned access_token is persisted and replace-navigated to
 *    /interview/session.
 *  - T-TOK-012: exchange 410 (token_consumed) → terminal, reason=link_used.
 *  - T-TOK-013: exchange 401 (token_invalid) → terminal, reason=link_invalid.
 *  - T-TOK-014: a stored session whose `interviewId` (captured from a PRIOR
 *    exchange of the SAME session token's `sub`) matches this token's `sub`
 *    claim → ZERO exchange calls, direct navigation (the session token is
 *    single-use — re-exchanging on a revisit would burn it and 410).
 *  - network/other error → falls through to the existing generic terminal
 *    (reason=403), mirroring interview/[token].vue's own fallback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockFetchImpl } = vi.hoisted(() => ({
  mockFetchImpl: vi.fn(),
}))

vi.mock('ofetch', () => ({
  $fetch: mockFetchImpl,
}))

// eslint-disable-next-line import/first
import { useCandidateSession } from '~/app/composables/useCandidateSession'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

const NOW_SECONDS = Math.floor(Date.now() / 1000)

function makeJwt(claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify(claims))
  return `${header}.${payload}.sig`
}

function makeSessionToken(overrides: Record<string, unknown> = {}): string {
  return makeJwt({
    iss: 'beai',
    sub: 'int_abc123',
    org: 'org_7',
    mode: 'live',
    aud: 'embed',
    exp: NOW_SECONDS + 900,
    ...overrides,
  })
}

function makeCandidateJwt(overrides: Record<string, unknown> = {}): string {
  return makeJwt({
    typ: 'candidate',
    candidate_ref: 'cand-001',
    project_id: 42,
    exp: NOW_SECONDS + 3600,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const mockNavigateTo = vi.fn()
const LOCALE_MARKER = '/__locale-marker__'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.stubGlobal('navigateTo', mockNavigateTo)
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useHead', vi.fn())
  vi.stubGlobal(
    'useLocalePath',
    vi.fn(() => (path: string) => `${LOCALE_MARKER}${path}`)
  )
  vi.stubGlobal(
    'useRuntimeConfig',
    vi.fn(() => ({
      public: { apiBase: 'https://api.test', interviewProviderMock: 'false' },
    }))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function mountHostedEntryPage(token: string) {
  vi.stubGlobal(
    'useRoute',
    vi.fn(() => ({ params: { token }, query: {} }))
  )
  const { default: Page } = await import('~/app/pages/i/[token].vue')
  const wrapper = mount(Page, { global: { mocks: { $t: (key: string) => key } } })
  // Flush the onMounted microtask chain (exchange or skip → navigateTo)
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
  }
  return wrapper
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('i/[token].vue — hosted entry route (public-api step 5, G-32, G-33)', () => {
  it('T-TOK-011: no stored session → EXACTLY ONE GET /api/embed/exchange call, persists access_token, navigates with replace:true', async () => {
    const sessionToken = makeSessionToken()
    const candidateToken = makeCandidateJwt()
    mockFetchImpl.mockResolvedValueOnce({ access_token: candidateToken })

    await mountHostedEntryPage(sessionToken)

    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
    const [url, options] = mockFetchImpl.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('https://api.test/embed/exchange')
    expect(options).toMatchObject({ params: { token: sessionToken } })

    expect(useCandidateSession().read()?.accessToken).toBe(candidateToken)
    expect(mockNavigateTo).toHaveBeenCalledWith(`${LOCALE_MARKER}/interview/session`, {
      replace: true,
    })
  })

  it('T-TOK-011b: the stored session records interviewId from the session token sub claim', async () => {
    const sessionToken = makeSessionToken({ sub: 'int_xyz789' })
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })

    await mountHostedEntryPage(sessionToken)

    expect(useCandidateSession().read()?.interviewId).toBe('int_xyz789')
  })

  it('T-TOK-012: exchange 410 (token_consumed) → terminal reason=link_used, no session stored', async () => {
    const sessionToken = makeSessionToken()
    const err = new Error('Gone.') as Error & { status: number }
    err.status = 410
    mockFetchImpl.mockRejectedValueOnce(err)

    await mountHostedEntryPage(sessionToken)

    expect(mockNavigateTo).toHaveBeenCalledWith(
      `${LOCALE_MARKER}/interview/terminal?reason=link_used`,
      {
        replace: true,
      }
    )
    expect(useCandidateSession().read()).toBeNull()
  })

  it('T-TOK-013: exchange 401 (token_invalid) → terminal reason=link_invalid, no session stored', async () => {
    const sessionToken = makeSessionToken()
    const err = new Error('Unauthorized.') as Error & { status: number }
    err.status = 401
    mockFetchImpl.mockRejectedValueOnce(err)

    await mountHostedEntryPage(sessionToken)

    expect(mockNavigateTo).toHaveBeenCalledWith(
      `${LOCALE_MARKER}/interview/terminal?reason=link_invalid`,
      { replace: true }
    )
    expect(useCandidateSession().read()).toBeNull()
  })

  it('T-TOK-014: a stored session whose interviewId matches this token sub → ZERO exchange calls, navigates directly', async () => {
    useCandidateSession().store(makeCandidateJwt(), { interviewId: 'int_abc123' })
    const sessionToken = makeSessionToken({ sub: 'int_abc123' })

    await mountHostedEntryPage(sessionToken)

    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(mockNavigateTo).toHaveBeenCalledWith(`${LOCALE_MARKER}/interview/session`, {
      replace: true,
    })
  })

  it('a stored session whose interviewId is for a DIFFERENT interview → exchange still proceeds', async () => {
    useCandidateSession().store(makeCandidateJwt(), { interviewId: 'int_someone_else' })
    const sessionToken = makeSessionToken({ sub: 'int_abc123' })
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })

    await mountHostedEntryPage(sessionToken)

    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a stored session with no interviewId (e.g. from the sso-link flow) → exchange still proceeds', async () => {
    useCandidateSession().store(makeCandidateJwt())
    const sessionToken = makeSessionToken()
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })

    await mountHostedEntryPage(sessionToken)

    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
  })

  it('network/other error → falls through to the existing generic terminal (reason=403)', async () => {
    const sessionToken = makeSessionToken()
    const err = new Error('Network error.') as Error & { status?: number }
    mockFetchImpl.mockRejectedValueOnce(err)

    await mountHostedEntryPage(sessionToken)

    expect(mockNavigateTo).toHaveBeenCalledWith(`${LOCALE_MARKER}/interview/terminal?reason=403`, {
      replace: true,
    })
  })
})
