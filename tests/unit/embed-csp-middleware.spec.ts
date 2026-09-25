/**
 * server/middleware/embed-csp.ts — real handler behavior for `/embed/{token}`
 * (public-api SPEC §4.4): per-org frame-ancestors, fixed Permissions-Policy,
 * fail-safe 'none', and no inherited X-Frame-Options.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockFetch, headers, state } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  headers: new Map<string, string>(),
  state: { pathname: '/embed/tok' },
}))

vi.mock('ofetch', () => ({ $fetch: mockFetch }))
vi.mock('h3', () => ({
  defineEventHandler: (handler: unknown) => handler,
  getRequestURL: () => new URL(`https://embed.test${state.pathname}`),
  setResponseHeader: (_event: unknown, name: string, value: string) => {
    headers.set(name, value)
  },
  removeResponseHeader: (_event: unknown, name: string) => {
    headers.delete(name)
  },
}))

async function run(pathname: string): Promise<void> {
  state.pathname = pathname
  const { default: handler } = await import('../../server/middleware/embed-csp')
  await (handler as (event: unknown) => Promise<void>)({})
}

beforeEach(() => {
  headers.clear()
  mockFetch.mockReset()
  // Simulates the header Nitro's merged `/**` route rule has already applied.
  headers.set('X-Frame-Options', 'DENY')
  vi.stubGlobal(
    'useRuntimeConfig',
    vi.fn(() => ({ apiOrigin: 'https://api.test' }))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('embed-csp middleware', () => {
  it('sets frame-ancestors from the organization allowed_domains and the fixed Permissions-Policy', async () => {
    mockFetch.mockResolvedValueOnce({ allowed_domains: ['acme.example'] })

    await run('/embed/tok-1')

    expect(mockFetch).toHaveBeenCalledWith('https://api.test/api/embed/frame-policy', {
      method: 'GET',
      params: { token: 'tok-1' },
    })
    expect(headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self' acme.example")
    expect(headers.get('Permissions-Policy')).toBe('camera=(self), microphone=(self)')
  })

  it("fails safe to frame-ancestors 'none' when the lookup fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'))

    await run('/embed/tok-1')

    expect(headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'")
  })

  it("fails safe to 'none' when the body carries no usable domain list", async () => {
    mockFetch.mockResolvedValueOnce({ allowed_domains: 'acme.example' })

    await run('/embed/tok-1')

    expect(headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'")
  })

  it('removes the X-Frame-Options header inherited from the blanket route rule', async () => {
    mockFetch.mockResolvedValueOnce({ allowed_domains: ['acme.example'] })

    await run('/embed/tok-1')

    expect(headers.has('X-Frame-Options')).toBe(false)
  })

  it('also handles the /en/ locale-prefixed route', async () => {
    mockFetch.mockResolvedValueOnce({ allowed_domains: ['acme.example'] })

    await run('/en/embed/tok-1')

    expect(headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self' acme.example")
  })

  it('does not touch any header for a non-embed path', async () => {
    await run('/interview/session')

    expect(mockFetch).not.toHaveBeenCalled()
    expect(headers.get('X-Frame-Options')).toBe('DENY')
    expect(headers.has('Content-Security-Policy')).toBe(false)
  })

  it('does not throw on a malformed percent-encoded token and falls back to none', async () => {
    mockFetch.mockRejectedValueOnce(new Error('401'))

    await expect(run('/embed/%E0%A4%A')).resolves.toBeUndefined()

    expect(headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'")
  })
})
