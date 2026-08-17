/**
 * app/middleware/candidate-session.ts — sync entry gate on /interview/session
 * (Task 2.4 RED / candidate-session-auth D-E)
 *
 * Client-only, synchronous, no network: reads `localStorage` directly via
 * `useCandidateSession().read()` (which already purges an expired session on
 * read) and `replace`-redirects to the expired-session terminal when absent
 * or expired. Zero milliseconds — no flash, no skeleton-for-a-decision.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useCandidateSession } from '~/app/composables/useCandidateSession'

// ---------------------------------------------------------------------------
// defineNuxtRouteMiddleware / navigateTo are Nuxt auto-imports (globals) —
// the middleware file itself imports neither, matching the project's
// existing convention (definePageMeta/useHead used the same way elsewhere).
// ---------------------------------------------------------------------------

const mockDefineNuxtRouteMiddleware = vi.fn((fn: (...args: unknown[]) => unknown) => fn)
const mockNavigateTo = vi.fn((to: string, opts?: unknown) => ({ __navigateTo: to, opts }))
// Verification Finding #5: an IDENTITY stub here is exactly what let a
// regression (calling bare navigateTo(path) instead of
// navigateTo(localePath(path))) go undetected — the assertion below would
// have matched either way. This stub applies a DISTINGUISHABLE transform
// (a marker prefix) so the test can only pass if the middleware's output
// actually passed through this function — reverting to a bare navigateTo
// call now produces the UN-prefixed path and fails the assertion.
const LOCALE_MARKER = '/__locale-marker__'
const mockLocalePath = vi.fn((path: string) => `${LOCALE_MARKER}${path}`)

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function makeCandidateJwt(exp: number): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({ typ: 'candidate', candidate_ref: 'cand-1', project_id: 1, exp })
  )
  return `${header}.${payload}.sig`
}

const NOW_SECONDS = Math.floor(Date.now() / 1000)

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.stubGlobal('defineNuxtRouteMiddleware', mockDefineNuxtRouteMiddleware)
  vi.stubGlobal('navigateTo', mockNavigateTo)
  vi.stubGlobal(
    'useLocalePath',
    vi.fn(() => mockLocalePath)
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadMiddleware() {
  vi.resetModules()
  const mod = await import('~/app/middleware/candidate-session')
  return mod.default as (...args: unknown[]) => unknown
}

describe('candidate-session middleware — sync gate on /interview/session (D-E)', () => {
  it('a valid stored session → allows navigation through (no redirect)', async () => {
    useCandidateSession().store(makeCandidateJwt(NOW_SECONDS + 3600))

    const middleware = await loadMiddleware()
    const result = middleware({}, {})

    expect(result).toBeUndefined()
    expect(mockNavigateTo).not.toHaveBeenCalled()
  })

  it('no stored session → replace-redirects to /interview/terminal?reason=session_expired, THROUGH useLocalePath', async () => {
    const middleware = await loadMiddleware()
    const result = middleware({}, {})

    // Asserts the CALL, not just the eventual string — a bare
    // navigateTo('/interview/terminal?...') that bypassed useLocalePath
    // entirely would fail this, even though (with an identity stub) it
    // would have produced the same-looking path.
    expect(mockLocalePath).toHaveBeenCalledWith('/interview/terminal?reason=session_expired')
    expect(mockNavigateTo).toHaveBeenCalledWith(
      `${LOCALE_MARKER}/interview/terminal?reason=session_expired`,
      { replace: true }
    )
    expect(result).toEqual({
      __navigateTo: `${LOCALE_MARKER}/interview/terminal?reason=session_expired`,
      opts: { replace: true },
    })
  })

  it('an EXPIRED stored session → replace-redirects to the expired-session terminal, THROUGH useLocalePath', async () => {
    useCandidateSession().store(makeCandidateJwt(NOW_SECONDS - 60))

    const middleware = await loadMiddleware()
    middleware({}, {})

    expect(mockLocalePath).toHaveBeenCalledWith('/interview/terminal?reason=session_expired')
    expect(mockNavigateTo).toHaveBeenCalledWith(
      `${LOCALE_MARKER}/interview/terminal?reason=session_expired`,
      { replace: true }
    )
  })

  it('makes no network call — the gate is synchronous localStorage-only (D-E)', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const middleware = await loadMiddleware()
    middleware({}, {})

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
