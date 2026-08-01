import { test, expect } from '@playwright/test'
import { checkA11y } from './fixtures/a11y'

/**
 * Root landing — an informational dead end at `/`.
 *
 * Before this existed the root returned a bare 404, which reads as "this
 * service is broken" to somebody who merely trimmed their URL or whose token
 * expired.
 *
 * Runs under chromium / webkit (the page itself) and under the mobile project,
 * which asserts the opposite behaviour: an unsupported device must still be
 * sent to /unsupported rather than shown orientation copy it cannot act on yet.
 */

const FIREFOX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'

test.describe('Root landing', () => {
  test('the root answers 200, not 404', async ({ page }) => {
    const response = await page.goto('/')

    expect(response?.status()).toBe(200)
    await expect(page.getByTestId('root-landing')).toBeVisible()
  })

  test('it shows the orientation message', async ({ page }) => {
    await page.goto('/')

    // Role-based, never a CSS selector — the heading IS the contract.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('main')).toBeVisible()
  })

  test('it is excluded from search engines', async ({ page }) => {
    await page.goto('/')

    // Nothing in the candidate app should surface in a search result, and an
    // orientation page is exactly the one a crawler would otherwise show to the
    // wrong audience.
    const robots = page.locator('meta[name="robots"]')
    await expect(robots).toHaveAttribute('content', /noindex/)
    await expect(robots).toHaveAttribute('content', /nofollow/)
  })

  test('it has a non-empty document title (WCAG 2.4.2)', async ({ page }) => {
    await page.goto('/')

    expect((await page.title()).trim().length).toBeGreaterThan(0)
  })

  test('it offers nothing to submit', async ({ page }) => {
    await page.goto('/')

    // The scope guard, asserted on the rendered document rather than the
    // component tree: this route has no flow behind it, so any control here
    // would promise something that does not exist.
    //
    // Scoped to the PAGE rather than the whole document, because the app shell
    // now mounts a global analytics consent banner (C13 task 5.6) whose two
    // buttons are chrome, not flow — they promise nothing about the interview.
    // The invariant this test protects is "the landing page offers no flow",
    // and narrowing the locator states that precisely instead of accidentally
    // also forbidding every future piece of app-wide furniture.
    const landing = page.getByTestId('root-landing')

    await expect(landing.locator('form')).toHaveCount(0)
    await expect(landing.locator('input')).toHaveCount(0)
    await expect(landing.locator('button')).toHaveCount(0)
    await expect(landing.locator('a[href^="mailto:"]')).toHaveCount(0)
  })

  test('the only controls anywhere on the page are the consent banner', async ({ page }) => {
    await page.goto('/')

    // The guard the narrowing above would otherwise have loosened. Scoping the
    // previous test to the page means a stray document-level control would no
    // longer be caught — so this names, exhaustively, what IS allowed to exist
    // outside the landing region.
    //
    // Wait for the banner first: evaluateAll does not retry, so on a slower
    // hydration it would run against a document without it and assert against
    // an empty list — passing or failing for reasons unrelated to the guard.
    await expect(page.getByTestId('analytics-consent')).toBeVisible()

    const testIds = await page
      .locator('button')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-testid')))

    expect(testIds.sort()).toEqual(['analytics-consent-accept', 'analytics-consent-reject'])
  })

  test('it passes WCAG 2.1 AA', async ({ page }) => {
    await page.goto('/')
    await checkA11y(page)
  })

  test.describe('the browser gate still covers the root', () => {
    test('a Firefox user agent is redirected to /unsupported', async ({ browser }) => {
      const context = await browser.newContext({ userAgent: FIREFOX_UA })
      const page = await context.newPage()

      await page.goto('/')

      // Asserted here so a future edit to the gate's skip list cannot silently
      // expose the root to a browser the product does not support.
      await expect(page).toHaveURL(/\/unsupported$/)
      await context.close()
    })
  })
})
