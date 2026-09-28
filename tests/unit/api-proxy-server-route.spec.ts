/**
 * server/routes/api/[...].ts — the same-origin API proxy (see its own doc for
 * WHY this exists: a candidate whose browser hit a Docker-internal hostname
 * was told their session had expired instead of seeing the real DNS failure).
 *
 * This file had 0% coverage despite being security-relevant (it decides the
 * outbound target and controls which headers are stripped vs forwarded
 * as-sent, Authorization included). `tests/unit/arch/same-origin-api.spec.ts`
 * already proves the MECHANISM exists via source-text assertions; this file
 * proves the HANDLER'S actual runtime behavior: target-URL construction,
 * header handling, and the fail-loud 500 branch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockProxyRequest } = vi.hoisted(() => ({
  mockProxyRequest: vi.fn(),
}))

vi.mock('h3', () => ({
  proxyRequest: mockProxyRequest,
}))

async function loadHandler(): Promise<(event: unknown) => unknown> {
  const mod = await import('../../server/routes/api/[...].ts')
  return mod.default as (event: unknown) => unknown
}

function fakeEvent(path: string): { path: string } {
  return { path }
}

afterEach(() => {
  vi.unstubAllGlobals()
  mockProxyRequest.mockReset()
})

describe('server route ALL /api/[...] (same-origin API proxy)', () => {
  describe('fail-loud guard', () => {
    it('throws a 500 naming NUXT_API_ORIGIN when apiOrigin is not configured', async () => {
      // The shared setup.ts default useRuntimeConfig() stub returns no
      // `apiOrigin` key at all — exactly the unconfigured case, with zero
      // extra stubbing needed.
      const createError = vi.fn((opts: { statusCode: number; statusMessage: string }) => {
        const err = new Error(opts.statusMessage) as Error & { statusCode: number }
        err.statusCode = opts.statusCode
        return err
      })
      vi.stubGlobal('createError', createError)

      const handler = await loadHandler()

      await expect(handler(fakeEvent('/api/organization'))).rejects.toMatchObject({
        statusCode: 500,
      })
      expect(createError).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          statusMessage: expect.stringContaining('NUXT_API_ORIGIN'),
        })
      )
      expect(mockProxyRequest).not.toHaveBeenCalled()
    })

    it('never attempts to proxy when unconfigured — an empty string apiOrigin is treated the same as missing', async () => {
      vi.stubGlobal(
        'useRuntimeConfig',
        vi.fn(() => ({ apiOrigin: '' }))
      )
      vi.stubGlobal(
        'createError',
        vi.fn((opts: { statusCode: number }) => {
          const err = new Error('unconfigured') as Error & { statusCode: number }
          err.statusCode = opts.statusCode
          return err
        })
      )

      const handler = await loadHandler()

      await expect(handler(fakeEvent('/api/organization'))).rejects.toMatchObject({
        statusCode: 500,
      })
      expect(mockProxyRequest).not.toHaveBeenCalled()
    })
  })

  describe('target URL construction', () => {
    beforeEach(() => {
      vi.stubGlobal(
        'useRuntimeConfig',
        vi.fn(() => ({ apiOrigin: 'https://api.test' }))
      )
      mockProxyRequest.mockResolvedValue(undefined)
    })

    it('forwards event.path verbatim (already carries the /api/... prefix and query string)', async () => {
      const handler = await loadHandler()
      const event = fakeEvent('/api/organization?expand=project')

      await handler(event)

      expect(mockProxyRequest).toHaveBeenCalledWith(
        event,
        'https://api.test/api/organization?expand=project',
        expect.anything()
      )
    })

    it('strips a trailing slash from the configured origin so the join never doubles up', async () => {
      vi.stubGlobal(
        'useRuntimeConfig',
        vi.fn(() => ({ apiOrigin: 'https://api.test/' }))
      )
      const handler = await loadHandler()
      const event = fakeEvent('/api/organization')

      await handler(event)

      expect(mockProxyRequest).toHaveBeenCalledWith(
        event,
        'https://api.test/api/organization',
        expect.anything()
      )
    })

    it('strips multiple trailing slashes the same way', async () => {
      vi.stubGlobal(
        'useRuntimeConfig',
        vi.fn(() => ({ apiOrigin: 'https://api.test///' }))
      )
      const handler = await loadHandler()
      const event = fakeEvent('/api/organization')

      await handler(event)

      expect(mockProxyRequest).toHaveBeenCalledWith(
        event,
        'https://api.test/api/organization',
        expect.anything()
      )
    })
  })

  describe('header handling', () => {
    beforeEach(() => {
      vi.stubGlobal(
        'useRuntimeConfig',
        vi.fn(() => ({ apiOrigin: 'https://api.test' }))
      )
      mockProxyRequest.mockResolvedValue(undefined)
    })

    it('strips only the host header, touching nothing else — Authorization forwards as sent', async () => {
      const handler = await loadHandler()
      const event = fakeEvent('/api/organization')

      await handler(event)

      const [, , options] = mockProxyRequest.mock.calls[0] as [
        unknown,
        string,
        { headers: Record<string, unknown> },
      ]
      // The proxy option object controls ONLY what it overrides. It must
      // clear `host` (the stale Docker-internal Host header) and must NOT
      // declare an `authorization` key at all — h3's proxyRequest forwards
      // every other incoming header, Authorization included, only when this
      // handler does not intercept it.
      expect(options.headers).toEqual({ host: undefined })
      expect(Object.keys(options.headers)).not.toContain('authorization')
    })
  })
})
