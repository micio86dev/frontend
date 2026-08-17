/**
 * app/pages/interview/[token].vue — entry route (Task 2.2 RED / D-A, D1)
 *
 * `[token].vue` is the sso-link entry route: it performs the exchange AT MOST
 * ONCE and `replace`-redirects to the token-free session route. Refreshing
 * this route after the exchange has completed — or refreshing the session
 * route at any point — must NEVER trigger a second exchange call, because the
 * exchange consumes the sso-link's `jti` BEFORE evaluating any gate.
 *
 * Coverage targets:
 *  - a stored, unexpired session whose candidate_ref + project_id match the
 *    sso-link's own claims → ZERO exchange calls, direct navigation to
 *    /interview/session
 *  - no stored session → EXACTLY ONE GET /api/sso/exchange call, the
 *    returned token is persisted, then `replace`-navigation to
 *    /interview/session
 *  - exchange 401 (spent link) → terminal, reason=spent_link, no retry
 *  - exchange 403 (gate/status refusal) → terminal, reason=403 (generic)
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

function makeSsoLinkToken(overrides: Record<string, unknown> = {}): string {
  return makeJwt({
    typ: 'sso-link',
    candidate_ref: 'cand-001',
    project_id: 42,
    org_id: 7,
    exp: NOW_SECONDS + 1800,
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
  // Verification Finding #5: an IDENTITY stub here is exactly what let a
  // regression (bare navigateTo(path) instead of navigateTo(localePath(path)))
  // go undetected — real bug found via E2E: navigateTo('/interview/session')
  // without useLocalePath() silently drops the candidate's locale back to
  // the default. This stub applies a DISTINGUISHABLE marker so the test can
  // only pass if the route's output actually passed through this function.
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

async function mountEntryPage(token: string) {
  vi.stubGlobal(
    'useRoute',
    vi.fn(() => ({ params: { token }, query: {} }))
  )
  const { default: Page } = await import('~/app/pages/interview/[token].vue')
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

describe('interview/[token].vue — entry route (D-A, D1)', () => {
  it('a valid stored session with matching claims → ZERO exchange calls, navigates directly to /interview/session', async () => {
    useCandidateSession().store(makeCandidateJwt())
    const ssoToken = makeSsoLinkToken()

    await mountEntryPage(ssoToken)

    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(mockNavigateTo).toHaveBeenCalledWith(`${LOCALE_MARKER}/interview/session`, {
      replace: true,
    })
  })

  it('a stored session with a DIFFERENT candidate_ref → exchange still proceeds (claims mismatch)', async () => {
    useCandidateSession().store(makeCandidateJwt({ candidate_ref: 'someone-else' }))
    const ssoToken = makeSsoLinkToken({ candidate_ref: 'cand-001' })
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })

    await mountEntryPage(ssoToken)

    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
  })

  it('no stored session → EXACTLY ONE GET /api/sso/exchange call', async () => {
    const ssoToken = makeSsoLinkToken()
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })

    await mountEntryPage(ssoToken)

    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
    const [url, options] = mockFetchImpl.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('https://api.test/sso/exchange')
    expect(options).toMatchObject({ params: { token: ssoToken } })
  })

  it('persists the returned access_token and navigates to /interview/session with replace:true', async () => {
    const ssoToken = makeSsoLinkToken()
    const candidateToken = makeCandidateJwt()
    mockFetchImpl.mockResolvedValueOnce({ access_token: candidateToken })

    await mountEntryPage(ssoToken)

    expect(useCandidateSession().read()?.accessToken).toBe(candidateToken)
    expect(mockNavigateTo).toHaveBeenCalledWith(`${LOCALE_MARKER}/interview/session`, {
      replace: true,
    })
  })

  it('exchange 401 (spent link) → terminal with reason=spent_link, no retry, no session stored', async () => {
    const ssoToken = makeSsoLinkToken()
    const err = new Error('Unauthenticated.') as Error & { status: number }
    err.status = 401
    mockFetchImpl.mockRejectedValueOnce(err)

    await mountEntryPage(ssoToken)

    expect(mockNavigateTo).toHaveBeenCalledWith(
      `${LOCALE_MARKER}/interview/terminal?reason=spent_link`,
      { replace: true }
    )
    expect(useCandidateSession().read()).toBeNull()
  })

  it('exchange 403 (gate/status refusal) → terminal with reason=403 (generic, no detail disclosed)', async () => {
    const ssoToken = makeSsoLinkToken()
    const err = new Error('Access denied.') as Error & { status: number }
    err.status = 403
    mockFetchImpl.mockRejectedValueOnce(err)

    await mountEntryPage(ssoToken)

    expect(mockNavigateTo).toHaveBeenCalledWith(`${LOCALE_MARKER}/interview/terminal?reason=403`, {
      replace: true,
    })
  })
})
