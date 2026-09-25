import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Playwright E2E — public-api embed iframe route `/embed/{token}` (step 10, SPEC §4.4)
 *
 * The per-request CSP middleware resolves `allowed_domains` server-side, which
 * Playwright cannot intercept, so the suite runs a tiny stand-in for the api's
 * frame-policy endpoint (fixtures/frame-policy-stub.mjs). An unknown token
 * gets a 401 there, which drives the middleware's FAIL-SAFE branch
 * (`frame-ancestors 'none'`); the known token resolves an allowed host.
 *
 * NOT covered here (needs a real api): mount→completed with the api's test-mode
 * mock provider — see the S10c disclosed gap in odd/tasks/public-api.md.
 */

// Served by the playwright.config.ts instance wired to the frame-policy stub.
const EMBED_SERVER = 'http://127.0.0.1:4176'
test.use({ baseURL: EMBED_SERVER })

const EMBED_TOKEN = 'e2e-session-token'
const EMBED_PATH = `/embed/${EMBED_TOKEN}`
// The frame-policy stub (fixtures/frame-policy-stub.mjs) allows HOST_ORIGIN's host for this token only.
const ALLOWED_TOKEN = 'allowed-token'
const HOST_ORIGIN = 'http://localhost:4175'

test.describe('embed route headers', () => {
  test('is embeddable-by-policy: no X-Frame-Options, camera/mic Permissions-Policy, CSP frame-ancestors', async ({
    request,
  }) => {
    const response = await request.get(EMBED_PATH)
    const headers = response.headers()

    expect(response.status()).toBe(200)
    expect(headers['x-frame-options']).toBeUndefined()
    expect(headers['permissions-policy']).toBe('camera=(self), microphone=(self)')
    expect(headers['content-security-policy']).toContain('frame-ancestors')
  })

  test('fails safe to frame-ancestors none when the organization cannot be resolved', async ({
    request,
  }) => {
    const response = await request.get(EMBED_PATH)

    expect(response.headers()['content-security-policy']).toBe("frame-ancestors 'none'")
  })

  test('the hosted /i/ route stays denied to framing', async ({ request }) => {
    const response = await request.get('/i/e2e-session-token')

    expect(response.headers()['x-frame-options']).toBe('DENY')
  })
})

test.describe('embed framing enforcement', () => {
  async function renderedInsideHost(page: Page, baseURL: string, token: string): Promise<boolean> {
    await page.goto(`${HOST_ORIGIN}/host?src=${encodeURIComponent(`${baseURL}/embed/${token}`)}`)
    // Let the browser attempt the framed navigation and either render or refuse it.
    await page.waitForTimeout(3_000)

    const embedded = page.frames().find((frame) => frame !== page.mainFrame())
    return embedded ? (await embedded.getByRole('main').count()) > 0 : false
  }

  test('renders inside a host page listed in the organization allowed_domains (positive control)', async ({
    page,
    baseURL,
  }) => {
    expect(await renderedInsideHost(page, baseURL as string, ALLOWED_TOKEN)).toBe(true)
  })

  test('a browser refuses to render it inside a host page that is not allowed', async ({
    page,
    baseURL,
  }) => {
    expect(await renderedInsideHost(page, baseURL as string, EMBED_TOKEN)).toBe(false)
  })
})
