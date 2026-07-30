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
