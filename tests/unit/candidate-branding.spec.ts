/**
 * useCandidateBranding — the candidate side of the white-label promise.
 *
 * A candidate cannot call `/api/organization`; that endpoint is
 * admin-authenticated. Branding therefore rides on the session bootstrap this
 * app already makes, and the rules that matter are: one fetch, never throw, and
 * never invent a default.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const candidateFetchMock = vi.fn()

vi.mock('../../app/utils/candidate-api', () => ({
  candidateFetch: candidateFetchMock,
  CandidateUnauthorizedError: class extends Error {},
}))

async function branding() {
  const { useCandidateBranding } = await import('../../app/composables/useCandidateBranding')

  return useCandidateBranding()
}

describe('useCandidateBranding', () => {
  beforeEach(async () => {
    candidateFetchMock.mockReset()
    ;(await branding()).reset()
    document.documentElement.style.removeProperty('--primary')
  })

  afterEach(async () => {
    ;(await branding()).reset()
  })

  it('paints the organization colour over the product one', async () => {
    candidateFetchMock.mockResolvedValue({
      branding: { primary_color: '#123456', logo_url: 'https://cdn.test/logo.png' },
    })

    const store = await branding()
    await store.ensureLoaded()

    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#123456')
    expect(store.logoUrl.value).toBe('https://cdn.test/logo.png')
  })

  it('REMOVES the override when the organization has no colour, never writes a default', async () => {
    // The fallback is the stylesheet's own Quint purple. Writing it here would
    // put a second copy of the brand constant in a second file, and the two
    // would drift the first time the palette changes.
    document.documentElement.style.setProperty('--primary', '#ffffff')
    candidateFetchMock.mockResolvedValue({
      branding: { primary_color: null, logo_url: null },
    })

    const store = await branding()
    await store.ensureLoaded()

    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
    expect(store.logoUrl.value).toBeNull()
  })

  it('refuses a colour that is not a plain six-digit hex', async () => {
    // This writes into a stylesheet. The API validates with an anchored regex
    // AND a database CHECK, and it is re-checked here anyway: a writer that
    // trusts its input because something upstream promised to check is how an
    // injection survives a refactor.
    candidateFetchMock.mockResolvedValue({
      branding: { primary_color: 'red; } body { display: none } .x {', logo_url: null },
    })

    const store = await branding()
    await store.ensureLoaded()

    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
  })

  it('never throws, and does not retry a failure on every mount', async () => {
    // Branding is decoration on an interview that must run regardless. A
    // candidate blocked from their assessment because a logo could not be
    // resolved would be a far worse failure than an unbranded page — and
    // retrying per component mount turns one bad response into a stream.
    candidateFetchMock.mockRejectedValue(new Error('offline'))

    const store = await branding()
    await expect(store.ensureLoaded()).resolves.toBeUndefined()
    await store.ensureLoaded()

    expect(candidateFetchMock).toHaveBeenCalledTimes(1)
    expect(store.logoUrl.value).toBeNull()
  })

  it('does not fetch at all once somebody has primed it', async () => {
    // `useExitRedirect` reads the same endpoint on page mount and hands the
    // result over, so the common path costs no extra request.
    const store = await branding()
    store.prime({ primary_color: '#abcdef', logo_url: null })

    await store.ensureLoaded()

    expect(candidateFetchMock).not.toHaveBeenCalled()
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#abcdef')
  })

  it('single-flights concurrent callers into one request', async () => {
    candidateFetchMock.mockResolvedValue({ branding: { primary_color: null, logo_url: null } })

    const store = await branding()
    await Promise.all([store.ensureLoaded(), store.ensureLoaded(), store.ensureLoaded()])

    expect(candidateFetchMock).toHaveBeenCalledTimes(1)
  })
})
