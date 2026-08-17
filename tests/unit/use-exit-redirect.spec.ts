/**
 * useExitRedirect — unit tests (C10 PR7, Task 14.1 RED)
 *
 * D10: fetches GET /api/candidate/session once, caches project.exit_redirect_url,
 * and redirects only for a validated https:// URL (open-redirect / downgrade hardening).
 *
 * Coverage targets:
 *  - fetchSession() calls $fetch GET /candidate/session and caches exit_redirect_url
 *  - fetchSession() failure degrades to null (no throw) — static done branch fallback
 *  - null/empty exit_redirect_url → redirect() is a no-op, no navigateTo call
 *  - https:// URL → redirect() calls navigateTo(url, { external: true, replace: true })
 *  - http:// URL → refused, no navigateTo call, console.warn logged (open-redirect hardening)
 *  - malformed URL → refused, no navigateTo call, console.warn logged
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before any other imports using vi.hoisted
//
// useExitRedirect now goes through candidateFetch (D-B / Task 1.6), which
// requires a stored candidate session before it will even attempt a network
// call — so these tests mock candidate-api directly rather than raw ofetch.
// ---------------------------------------------------------------------------

const { mockCandidateFetch, mockClearSession, MockCandidateUnauthorizedError } = vi.hoisted(() => {
  const mockCandidateFetch = vi.fn()
  const mockClearSession = vi.fn()
  // A real class (not just a spy) — useExitRedirect does `instanceof` checks
  // against this (Task 3.1/3.2), so the test and the source must share the
  // exact same class reference via the mocked module.
  class MockCandidateUnauthorizedError extends Error {
    constructor(message = 'Candidate session unauthorized') {
      super(message)
      this.name = 'CandidateUnauthorizedError'
    }
  }
  return { mockCandidateFetch, mockClearSession, MockCandidateUnauthorizedError }
})

vi.mock('~/app/utils/candidate-api', () => ({
  candidateFetch: mockCandidateFetch,
  CandidateUnauthorizedError: MockCandidateUnauthorizedError,
}))

// Verification Finding #1: "cleared ... immediately before an exit or error
// redirect fires" is a literal requirement on THIS function, not just on the
// interview state machine — useExitRedirect must clear defensively on its
// own, since it is a general-purpose composable that should not assume its
// caller already cleared.
vi.mock('~/app/composables/useCandidateSession', () => ({
  useCandidateSession: () => ({ clear: mockClearSession, read: vi.fn(), store: vi.fn() }),
}))

// eslint-disable-next-line import/first
import { useExitRedirect } from '~/app/composables/useExitRedirect'

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const mockNavigateTo = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('navigateTo', mockNavigateTo)
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useExitRedirect', () => {
  describe('fetchSession()', () => {
    it('calls candidateFetch with the /candidate/session endpoint', async () => {
      mockCandidateFetch.mockResolvedValueOnce({ project: { exit_redirect_url: null } })

      const { fetchSession } = useExitRedirect()
      await fetchSession()

      // candidateFetch resolves the URL internally (D-B) — the caller passes
      // the API-relative path, not a pre-built absolute URL.
      expect(mockCandidateFetch).toHaveBeenCalledWith('/candidate/session', expect.any(Object))
    })

    it('caches project.exit_redirect_url from the response', async () => {
      mockCandidateFetch.mockResolvedValueOnce({
        project: { exit_redirect_url: 'https://hr.acme.com/beai/done' },
      })

      const { fetchSession, exitRedirectUrl } = useExitRedirect()
      await fetchSession()

      expect(exitRedirectUrl.value).toBe('https://hr.acme.com/beai/done')
    })

    it('null exit_redirect_url on the response → cached as null', async () => {
      mockCandidateFetch.mockResolvedValueOnce({ project: { exit_redirect_url: null } })

      const { fetchSession, exitRedirectUrl } = useExitRedirect()
      await fetchSession()

      expect(exitRedirectUrl.value).toBeNull()
    })

    it('a fetch failure degrades to null — never throws', async () => {
      mockCandidateFetch.mockRejectedValueOnce(new Error('network error'))

      const { fetchSession, exitRedirectUrl } = useExitRedirect()
      await expect(fetchSession()).resolves.not.toThrow()

      expect(exitRedirectUrl.value).toBeNull()
    })

    it('a null project on the response → cached as null (no crash)', async () => {
      mockCandidateFetch.mockResolvedValueOnce({ project: null })

      const { fetchSession, exitRedirectUrl } = useExitRedirect()
      await fetchSession()

      expect(exitRedirectUrl.value).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // sessionFetchFailed — D-D: "operator configured no URL" (supported) and
  // "we are not authenticated" (defect) used to share one code path and one
  // console.warn containing the word "non-fatal" — the sentence that let this
  // survive. A 401 is now distinguishable from every other failure reason.
  // ---------------------------------------------------------------------------

  describe('sessionFetchFailed (Task 3.1/3.2 RED — D-D)', () => {
    it('is null before fetchSession() is ever called', () => {
      const { sessionFetchFailed } = useExitRedirect()
      expect(sessionFetchFailed.value).toBeNull()
    })

    it('a successful fetch leaves sessionFetchFailed null', async () => {
      mockCandidateFetch.mockResolvedValueOnce({ project: { exit_redirect_url: null } })

      const { fetchSession, sessionFetchFailed } = useExitRedirect()
      await fetchSession()

      expect(sessionFetchFailed.value).toBeNull()
    })

    it('a 401 (CandidateUnauthorizedError) → sessionFetchFailed = "unauthenticated", still never throws', async () => {
      mockCandidateFetch.mockRejectedValueOnce(new MockCandidateUnauthorizedError())

      const { fetchSession, sessionFetchFailed } = useExitRedirect()
      await expect(fetchSession()).resolves.not.toThrow()

      expect(sessionFetchFailed.value).toBe('unauthenticated')
    })

    it('a non-auth failure (network/5xx) → sessionFetchFailed = "unavailable", distinct from unauthenticated', async () => {
      mockCandidateFetch.mockRejectedValueOnce(new Error('network error'))

      const { fetchSession, sessionFetchFailed } = useExitRedirect()
      await fetchSession()

      expect(sessionFetchFailed.value).toBe('unavailable')
    })

    it('the header IS attached — fetchSession routes through candidateFetch, not a bare fetch', async () => {
      // candidateFetch owns the Authorization header (D-B); this call site
      // never builds its own headers. Covered directly in candidate-api.spec.ts;
      // asserted here as the integration point.
      mockCandidateFetch.mockResolvedValueOnce({ project: { exit_redirect_url: null } })

      const { fetchSession } = useExitRedirect()
      await fetchSession()

      expect(mockCandidateFetch).toHaveBeenCalledWith('/candidate/session', expect.any(Object))
    })

    it('logs a message that NAMES THE CONSEQUENCE and does not contain the word "non-fatal"', async () => {
      // The word "non-fatal" is the sentence that let this survive: it made
      // the log read as "known and fine" instead of "redirects are dead".
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockCandidateFetch.mockRejectedValueOnce(new MockCandidateUnauthorizedError())

      const { fetchSession } = useExitRedirect()
      await fetchSession()

      expect(warnSpy).toHaveBeenCalled()
      const loggedArgs = warnSpy.mock.calls[0] as unknown[]
      const loggedText = loggedArgs.map((a) => String(a)).join(' ')
      expect(loggedText).not.toMatch(/non-fatal/i)
      expect(loggedText).toMatch(/exit and error redirects are unavailable/i)

      warnSpy.mockRestore()
    })
  })

  describe('redirect()', () => {
    it('null exit_redirect_url → no navigation, returns false', async () => {
      mockCandidateFetch.mockResolvedValueOnce({ project: { exit_redirect_url: null } })

      const { fetchSession, redirect } = useExitRedirect()
      await fetchSession()

      const result = redirect()

      expect(result).toBe(false)
      expect(mockNavigateTo).not.toHaveBeenCalled()
    })

    it('empty-string exit_redirect_url → no navigation, returns false', async () => {
      mockCandidateFetch.mockResolvedValueOnce({ project: { exit_redirect_url: '' } })

      const { fetchSession, redirect } = useExitRedirect()
      await fetchSession()

      const result = redirect()

      expect(result).toBe(false)
      expect(mockNavigateTo).not.toHaveBeenCalled()
    })

    it('https:// URL → navigateTo(url, { external: true, replace: true }), returns true', async () => {
      mockCandidateFetch.mockResolvedValueOnce({
        project: { exit_redirect_url: 'https://hr.acme.com/beai/done?ref=acme-672' },
      })

      const { fetchSession, redirect } = useExitRedirect()
      await fetchSession()

      const result = redirect()

      expect(result).toBe(true)
      expect(mockNavigateTo).toHaveBeenCalledWith('https://hr.acme.com/beai/done?ref=acme-672', {
        external: true,
        replace: true,
      })
    })

    it('Verification Finding #1 — https:// URL redirect() clears the candidate session before navigating', async () => {
      mockCandidateFetch.mockResolvedValueOnce({
        project: { exit_redirect_url: 'https://hr.acme.com/beai/done' },
      })

      const { fetchSession, redirect } = useExitRedirect()
      await fetchSession()
      redirect()

      expect(mockClearSession).toHaveBeenCalled()
    })

    it('http:// URL → refused, no navigateTo call, console.warn logged', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockCandidateFetch.mockResolvedValueOnce({
        project: { exit_redirect_url: 'http://insecure.example.com/done' },
      })

      const { fetchSession, redirect } = useExitRedirect()
      await fetchSession()

      const result = redirect()

      expect(result).toBe(false)
      expect(mockNavigateTo).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[useExitRedirect]'),
        expect.anything()
      )
      // A refused redirect never fires — nothing to clear before.
      expect(mockClearSession).not.toHaveBeenCalled()

      warnSpy.mockRestore()
    })

    it('malformed URL → refused, no navigateTo call, console.warn logged', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockCandidateFetch.mockResolvedValueOnce({
        project: { exit_redirect_url: 'not-a-url' },
      })

      const { fetchSession, redirect } = useExitRedirect()
      await fetchSession()

      const result = redirect()

      expect(result).toBe(false)
      expect(mockNavigateTo).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalled()

      warnSpy.mockRestore()
    })
  })
})

// ---------------------------------------------------------------------------
// Error redirect (C13 — closes the gap interview-frontend/spec.md recorded)
//
// The candidate's need on failure is sharper than on success: they cannot
// continue and they are stranded on a domain they have no account on. Only the
// calling system can tell them what happens next.
// ---------------------------------------------------------------------------

describe('useExitRedirect — error destination', () => {
  it('caches error_redirect_url from the same session fetch', async () => {
    mockCandidateFetch.mockResolvedValueOnce({
      project: {
        exit_redirect_url: 'https://hr.test/done',
        error_redirect_url: 'https://hr.test/failed',
      },
    })

    const r = useExitRedirect()
    await r.fetchSession()

    // One endpoint, both destinations. A second composable would mean a second
    // fetch of the same session and two places for the safety rules to drift.
    expect(mockCandidateFetch).toHaveBeenCalledTimes(1)
    expect(r.errorRedirectUrl.value).toBe('https://hr.test/failed')
    expect(r.exitRedirectUrl.value).toBe('https://hr.test/done')
  })

  it('treats a missing error_redirect_url as unconfigured, not an error', async () => {
    // The api may not expose the field yet — the committed OpenAPI snapshot
    // lags a backend release. Forward-compatibility here is what lets the two
    // repos merge in either order.
    mockCandidateFetch.mockResolvedValueOnce({
      project: { exit_redirect_url: 'https://hr.test/done' },
    })

    const r = useExitRedirect()
    await r.fetchSession()

    expect(r.errorRedirectUrl.value).toBeNull()
    expect(r.redirectToError()).toBe(false)
  })

  it('redirects to a validated https error url', async () => {
    mockCandidateFetch.mockResolvedValueOnce({
      project: { exit_redirect_url: null, error_redirect_url: 'https://hr.test/failed' },
    })

    const r = useExitRedirect()
    await r.fetchSession()

    expect(r.redirectToError()).toBe(true)
    expect(mockNavigateTo).toHaveBeenCalledWith('https://hr.test/failed', {
      external: true,
      replace: true,
    })
  })

  it('Verification Finding #1 — redirectToError() clears the candidate session before navigating', async () => {
    mockCandidateFetch.mockResolvedValueOnce({
      project: { exit_redirect_url: null, error_redirect_url: 'https://hr.test/failed' },
    })

    const r = useExitRedirect()
    await r.fetchSession()
    r.redirectToError()

    expect(mockClearSession).toHaveBeenCalled()
  })

  it('refuses an http error url', async () => {
    // A downgrade mid-failure is exactly when a candidate is least likely to
    // notice the address bar.
    mockCandidateFetch.mockResolvedValueOnce({
      project: { exit_redirect_url: null, error_redirect_url: 'http://hr.test/failed' },
    })

    const r = useExitRedirect()
    await r.fetchSession()

    expect(r.redirectToError()).toBe(false)
    expect(mockNavigateTo).not.toHaveBeenCalled()
  })

  it('refuses a malformed error url', async () => {
    mockCandidateFetch.mockResolvedValueOnce({
      project: { exit_redirect_url: null, error_redirect_url: 'not a url' },
    })

    const r = useExitRedirect()
    await r.fetchSession()

    expect(r.redirectToError()).toBe(false)
    expect(mockNavigateTo).not.toHaveBeenCalled()
  })

  it('degrades to unconfigured when the session fetch fails', async () => {
    mockCandidateFetch.mockRejectedValueOnce(new Error('network'))

    const r = useExitRedirect()
    await r.fetchSession()

    // A failed fetch must never strand the candidate on a blank screen: it
    // falls back to the inline error screen, which still has a retry button.
    expect(r.errorRedirectUrl.value).toBeNull()
    expect(r.redirectToError()).toBe(false)
  })
})
