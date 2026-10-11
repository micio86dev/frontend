/**
 * browser-gate.global.ts middleware — Integration tests (Task 3.5 RED)
 *
 * Tests the Nuxt route middleware that enforces SA-11 browser support gate.
 *
 * These are Playwright tests because the middleware integrates:
 *   - SSR path: useRequestHeaders(['user-agent']) — real Nuxt request context
 *   - Client path: navigator.userAgent + window.innerWidth — real browser
 *
 * The Vitest 95% threshold explicitly EXCLUDES this middleware wrapper
 * (spec Coverage Note): SSR-path coverage is Playwright's responsibility.
 *
 * Runs under: chromium and webkit (desktop). Mobile project redirect is
 * already covered by unsupported-gate.spec.ts via SA-11 direct navigation.
 *
 * Note: These tests require a running Nuxt dev/preview server.
 * They are designed to run in CI where `baseURL` is set via playwright.config.ts.
 *
 * UA spoofing technique: use browser.newContext({ userAgent }) to correctly
 * override the User-Agent for both the SSR request and the client-side check.
 * page.setExtraHTTPHeaders() only injects an extra header and does NOT replace
 * Chromium's own User-Agent header for SSR requests.
 */

import { test, expect } from '@playwright/test'
import { checkA11y } from './fixtures/a11y'
import { injectDeviceMocks } from './fixtures/device-mocks'
import type { Browser, Page } from '@playwright/test'

const FIREFOX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * The sso-link exchange answers 401 (a spent link). It is the cheapest real,
 * positive end state for "the gate let this visitor in": the entry page mounted,
 * ran, and sent the visitor to the spent-link terminal page. Absence of a
 * redirect alone proves nothing, because the middleware's client redirect can
 * land after `goto` resolves.
 */
async function mockSpentLink(page: Page): Promise<void> {
  await page.route('**/api/sso/exchange*', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'e2e' }),
    })
  )
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** A candidate JWT shaped closely enough for useCandidateSession to decode client-side. */
function makeCandidateJwt(): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      typ: 'candidate',
      candidate_ref: 'cand-e2e-gate',
      project_id: 1,
      exp: Math.floor(Date.now() / 1000) + 7200,
    })
  )

  return `${header}.${payload}.e2e-fake-signature`
}

/** Everything a hosted interview needs up to `live`, with the api network-intercepted. */
async function mockLiveInterview(page: Page): Promise<void> {
  await page.route('**/api/sso/exchange*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: makeCandidateJwt() }),
    })
  )
  await page.route('**/api/candidate/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { project: { exit_redirect_url: null } } }),
    })
  )
  await page.route('**/api/candidate/interview/start', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        session_id: 1,
        provider: 'heygen',
        provider_token: 'heygen-token-e2e',
        audio_only: false,
        question_context: {
          question_index: 0,
          total_questions: 1,
          end_phrase: 'Let us move on to the next question.',
          final_phrase: 'Thank you for your time.',
          competency_code: 'COM',
        },
      }),
    })
  )
  for (const path of ['utterance', 'integrity', 'snapshot']) {
    await page.route(`**/api/candidate/interview/${path}`, (route) =>
      route.fulfill({ status: 202, contentType: 'application/json', body: '{}' })
    )
  }
}

test.describe('browser-gate.global.ts middleware', () => {
  test.describe('Firefox UA → redirected to /unsupported', () => {
    test('GET /interview/fake-token with Firefox UA → redirects to /unsupported', async ({
      browser,
    }: {
      browser: Browser
    }) => {
      // Use a fresh context with the Firefox User-Agent so the SSR request
      // correctly presents the overridden UA. page.setExtraHTTPHeaders() is
      // insufficient: Chromium still sends its own UA for the actual request.
      const ctx = await browser.newContext({ userAgent: FIREFOX_UA })
      const page = await ctx.newPage()

      try {
        await page.goto('/interview/fake-token')

        // Should end up on /unsupported (middleware redirect)
        expect(page.url()).toContain('/unsupported')

        // The unsupported gate element should be visible
        await expect(page.getByTestId('unsupported-gate')).toBeVisible()
      } finally {
        await ctx.close()
      }
    })

    test('GET /en/interview/fake-token with Firefox UA → redirects to /en/unsupported', async ({
      browser,
    }: {
      browser: Browser
    }) => {
      const ctx = await browser.newContext({ userAgent: FIREFOX_UA })
      const page = await ctx.newPage()

      try {
        await page.goto('/en/interview/fake-token')

        expect(page.url()).toContain('/unsupported')
        await expect(page.getByTestId('unsupported-gate')).toBeVisible()
      } finally {
        await ctx.close()
      }
    })
  })

  test.describe('Desktop Chrome UA → not redirected', () => {
    test('GET /interview/fake-token with Chrome UA → no redirect (interview page attempted)', async ({
      browser,
    }: {
      browser: Browser
    }) => {
      const ctx = await browser.newContext({ userAgent: CHROME_UA })
      const page = await ctx.newPage()
      await mockSpentLink(page)

      try {
        await page.goto('/interview/fake-token')

        // The positive end state: the entry page ran and reached ITS terminal
        // page. "Not on /unsupported" read right after `goto` would also hold
        // for a redirect that simply had not happened yet.
        await expect(page).toHaveURL(/\/interview\/terminal\?reason=spent_link$/)
        expect(page.url()).not.toContain('/unsupported')
      } finally {
        await ctx.close()
      }
    })
  })

  test.describe('/unsupported itself → no redirect loop', () => {
    test('/unsupported with Firefox UA → no redirect loop (early return)', async ({
      browser,
    }: {
      browser: Browser
    }) => {
      const ctx = await browser.newContext({ userAgent: FIREFOX_UA })
      const page = await ctx.newPage()

      try {
        // Navigate directly to /unsupported — should NOT redirect (middleware early-return)
        await page.goto('/unsupported')

        expect(page.url()).toContain('/unsupported')
        await expect(page.getByTestId('unsupported-gate')).toBeVisible()
      } finally {
        await ctx.close()
      }
    })
  })

  test.describe('desktop UA, narrow viewport → /unsupported (client-side check, width < 1024)', () => {
    // The server cannot see a viewport, so it lets every desktop UA through and
    // the middleware's CLIENT check is what judges the width, at navigation.
    for (const width of [900, 1023]) {
      test(`navigating to /interview/fake-token at ${width}px ends on /unsupported`, async ({
        page,
      }) => {
        await mockSpentLink(page)
        await page.setViewportSize({ width, height: 768 })

        await page.goto('/interview/fake-token')

        await expect(page).toHaveURL(/\/unsupported$/)
        await expect(page.getByTestId('unsupported-gate')).toBeVisible()
      })
    }

    test('the floor itself, 1024px, is supported: the entry page runs and reaches its own terminal page', async ({
      page,
    }) => {
      await mockSpentLink(page)
      await page.setViewportSize({ width: 1024, height: 768 })

      await page.goto('/interview/fake-token')

      await expect(page).toHaveURL(/\/interview\/terminal\?reason=spent_link$/)
    })
  })

  test.describe('a live interview shrunk below 1024px → /unsupported', () => {
    // The route middleware runs at navigation only. A candidate who narrows the
    // window MID-interview is caught by the resize listener the session attaches
    // when it goes live (useInterviewSession), which is what this proves.
    test('shrinking to 900px ends the session on /unsupported; staying at 1100px does not', async ({
      page,
    }) => {
      await injectDeviceMocks(page)
      await mockLiveInterview(page)

      await page.goto('/en/interview/fake-token')
      await page.getByRole('button', { name: /accept and continue/i }).click()
      await expect(page.getByRole('button', { name: /start the interview/i })).toBeEnabled()
      await page.getByRole('button', { name: /start the interview/i }).click()
      // The live-only Exit control is the positive signal that the interview is live.
      await expect(
        page.getByRole('button', { name: /^exit, you can resume later$/i })
      ).toBeVisible()

      // Narrower, but still a supported desktop width: the interview carries on.
      await page.setViewportSize({ width: 1100, height: 768 })
      await expect(
        page.getByRole('button', { name: /^exit, you can resume later$/i })
      ).toBeVisible()
      expect(page.url()).not.toContain('/unsupported')

      await page.setViewportSize({ width: 900, height: 768 })

      await expect(page).toHaveURL(/\/unsupported$/)
      await expect(page.getByTestId('unsupported-gate')).toBeVisible()
    })
  })

  // C13: the gate's DESTINATION was covered by unsupported-gate.spec.ts, but
  // the redirect path itself never was. A candidate arriving here has already
  // hit a wall; the page telling them so must at least be operable.
  test('the page reached by the gate passes WCAG 2.1 AA', async ({ page }) => {
    await page.goto('/unsupported')
    await checkA11y(page)
  })
})
