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
// ---------------------------------------------------------------------------

const { mockFetchImpl } = vi.hoisted(() => ({
  mockFetchImpl: vi.fn(),
}))

vi.mock('ofetch', () => ({
  $fetch: mockFetchImpl,
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
    it('calls $fetch with the /candidate/session endpoint', async () => {
      mockFetchImpl.mockResolvedValueOnce({ project: { exit_redirect_url: null } })

      const { fetchSession } = useExitRedirect()
      await fetchSession()

      // Full resolved URL, not stringContaining: a substring assertion passes
      // just as happily against the doubled-prefix '/api/api/candidate/session'.
      expect(mockFetchImpl).toHaveBeenCalledWith(
        'https://api.test/candidate/session',
        expect.any(Object)
      )
    })

    it('caches project.exit_redirect_url from the response', async () => {
      mockFetchImpl.mockResolvedValueOnce({
        project: { exit_redirect_url: 'https://hr.acme.com/beai/done' },
      })

      const { fetchSession, exitRedirectUrl } = useExitRedirect()
      await fetchSession()

      expect(exitRedirectUrl.value).toBe('https://hr.acme.com/beai/done')
    })

    it('null exit_redirect_url on the response → cached as null', async () => {
      mockFetchImpl.mockResolvedValueOnce({ project: { exit_redirect_url: null } })

      const { fetchSession, exitRedirectUrl } = useExitRedirect()
      await fetchSession()

      expect(exitRedirectUrl.value).toBeNull()
    })

    it('a fetch failure degrades to null — never throws', async () => {
      mockFetchImpl.mockRejectedValueOnce(new Error('network error'))

      const { fetchSession, exitRedirectUrl } = useExitRedirect()
      await expect(fetchSession()).resolves.not.toThrow()

      expect(exitRedirectUrl.value).toBeNull()
    })

    it('a null project on the response → cached as null (no crash)', async () => {
      mockFetchImpl.mockResolvedValueOnce({ project: null })

      const { fetchSession, exitRedirectUrl } = useExitRedirect()
      await fetchSession()

      expect(exitRedirectUrl.value).toBeNull()
    })
  })

  describe('redirect()', () => {
    it('null exit_redirect_url → no navigation, returns false', async () => {
      mockFetchImpl.mockResolvedValueOnce({ project: { exit_redirect_url: null } })

      const { fetchSession, redirect } = useExitRedirect()
      await fetchSession()

      const result = redirect()

      expect(result).toBe(false)
      expect(mockNavigateTo).not.toHaveBeenCalled()
    })

    it('empty-string exit_redirect_url → no navigation, returns false', async () => {
      mockFetchImpl.mockResolvedValueOnce({ project: { exit_redirect_url: '' } })

      const { fetchSession, redirect } = useExitRedirect()
      await fetchSession()

      const result = redirect()

      expect(result).toBe(false)
      expect(mockNavigateTo).not.toHaveBeenCalled()
    })

    it('https:// URL → navigateTo(url, { external: true, replace: true }), returns true', async () => {
      mockFetchImpl.mockResolvedValueOnce({
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

    it('http:// URL → refused, no navigateTo call, console.warn logged', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockFetchImpl.mockResolvedValueOnce({
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

      warnSpy.mockRestore()
    })

    it('malformed URL → refused, no navigateTo call, console.warn logged', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockFetchImpl.mockResolvedValueOnce({
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
    mockFetchImpl.mockResolvedValueOnce({
      project: {
        exit_redirect_url: 'https://hr.test/done',
        error_redirect_url: 'https://hr.test/failed',
      },
    })

    const r = useExitRedirect()
    await r.fetchSession()

    // One endpoint, both destinations. A second composable would mean a second
    // fetch of the same session and two places for the safety rules to drift.
    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
    expect(r.errorRedirectUrl.value).toBe('https://hr.test/failed')
    expect(r.exitRedirectUrl.value).toBe('https://hr.test/done')
  })

  it('treats a missing error_redirect_url as unconfigured, not an error', async () => {
    // The api may not expose the field yet — the committed OpenAPI snapshot
    // lags a backend release. Forward-compatibility here is what lets the two
    // repos merge in either order.
    mockFetchImpl.mockResolvedValueOnce({
      project: { exit_redirect_url: 'https://hr.test/done' },
    })

    const r = useExitRedirect()
    await r.fetchSession()

    expect(r.errorRedirectUrl.value).toBeNull()
    expect(r.redirectToError()).toBe(false)
  })

  it('redirects to a validated https error url', async () => {
    mockFetchImpl.mockResolvedValueOnce({
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

  it('refuses an http error url', async () => {
    // A downgrade mid-failure is exactly when a candidate is least likely to
    // notice the address bar.
    mockFetchImpl.mockResolvedValueOnce({
      project: { exit_redirect_url: null, error_redirect_url: 'http://hr.test/failed' },
    })

    const r = useExitRedirect()
    await r.fetchSession()

    expect(r.redirectToError()).toBe(false)
    expect(mockNavigateTo).not.toHaveBeenCalled()
  })

  it('refuses a malformed error url', async () => {
    mockFetchImpl.mockResolvedValueOnce({
      project: { exit_redirect_url: null, error_redirect_url: 'not a url' },
    })

    const r = useExitRedirect()
    await r.fetchSession()

    expect(r.redirectToError()).toBe(false)
    expect(mockNavigateTo).not.toHaveBeenCalled()
  })

  it('degrades to unconfigured when the session fetch fails', async () => {
    mockFetchImpl.mockRejectedValueOnce(new Error('network'))

    const r = useExitRedirect()
    await r.fetchSession()

    // A failed fetch must never strand the candidate on a blank screen: it
    // falls back to the inline error screen, which still has a retry button.
    expect(r.errorRedirectUrl.value).toBeNull()
    expect(r.redirectToError()).toBe(false)
  })
})
