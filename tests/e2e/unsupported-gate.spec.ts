import { test, expect } from '@playwright/test'
import { checkA11y } from './fixtures/a11y'

/**
 * SA-11 — Unsupported experience gate test.
 *
 * This spec runs under the `mobile` Playwright project (device: Pixel 7)
 * and also under desktop projects (chromium / webkit) to verify the page
 * itself is accessible.
 *
 * The mobile project asserts:
 * - The unsupported-gate page exists and is reachable at /unsupported
 * - The gate element with data-testid="unsupported-gate" is visible
 * - Full app features are NOT shown (the gate blocks them)
 *
 * Task 5.8: Extended with SA-11 middleware redirect assertions.
 *   - Mobile project: navigate to /interview/fake-token → asserts redirect to /unsupported
 *   - Desktop chromium/webkit: Firefox UA header → redirect to /unsupported
 */

const FIREFOX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'

test.describe('SA-11 — Unsupported experience gate', () => {
  test('unsupported page renders the gate element', async ({ page }) => {
    // Navigate directly to the unsupported page
    await page.goto('/unsupported')

    // Verify the gate is shown (SA-11)
    await expect(page.getByTestId('unsupported-gate')).toBeVisible()
  })

  test('unsupported page does NOT render full interview features', async ({ page }) => {
    await page.goto('/unsupported')

    // Verify no interview-specific elements are present
    await expect(page.getByTestId('health-status')).not.toBeVisible()
  })

  test('unsupported page passes WCAG 2.1 AA accessibility check', async ({ page }) => {
    await page.goto('/unsupported')
    await checkA11y(page)
  })

  test('matches the unsupported gate visual baseline', async ({ page }) => {
    await page.goto('/unsupported')
    await expect(page.getByTestId('unsupported-gate')).toBeVisible()
    // Visual regression: overlay against the committed baseline to catch UI changes.
    await expect(page).toHaveScreenshot('unsupported-gate.png', { fullPage: true })
  })

  test.describe('SA-11 — Mobile: interview route redirects to /unsupported', () => {
    test('mobile viewport navigating to /interview/fake-token redirects to /unsupported', async ({
      page,
      isMobile,
    }) => {
      // This test is meaningful only on the mobile project (viewport < 1024)
      // On desktop projects it verifies the interview page does NOT redirect
      if (isMobile) {
        await page.goto('/interview/fake-token')
        // Should redirect to /unsupported (mobile UA or viewport < 1024)
        await expect(page).toHaveURL(/\/unsupported/)
        await expect(page.getByTestId('unsupported-gate')).toBeVisible()
      } else {
        // Desktop: no redirect; interview page should be reachable
        // (may show an error/loading state, but not redirect to /unsupported)
        await page.goto('/interview/fake-token')
        await expect(page).not.toHaveURL(/\/unsupported/)
      }
    })
  })

  test.describe('SA-11 — Desktop: Firefox UA redirects to /unsupported', () => {
    test('Firefox UA redirects /interview/fake-token to /unsupported', async ({ page }) => {
      // Set Firefox User-Agent header for the request
      await page.setExtraHTTPHeaders({ 'user-agent': FIREFOX_UA })
      await page.goto('/interview/fake-token')

      // Browser-gate middleware should redirect Firefox to /unsupported
      await expect(page).toHaveURL(/\/unsupported/)
      await expect(page.getByTestId('unsupported-gate')).toBeVisible()
    })

    test('Firefox UA redirects /en/interview/fake-token to /en/unsupported', async ({ page }) => {
      await page.setExtraHTTPHeaders({ 'user-agent': FIREFOX_UA })
      await page.goto('/en/interview/fake-token')

      // Should redirect to the locale-prefixed unsupported page
      await expect(page).toHaveURL(/\/unsupported/)
      await expect(page.getByTestId('unsupported-gate')).toBeVisible()
    })
  })
})
