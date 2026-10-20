import { test, expect, type Page } from '@playwright/test'
import { injectCallMedia } from './fixtures/device-mocks'
import { mockBrandedInterview } from './fixtures/branded-interview'

/**
 * The default provider path loads no code of the optional third provider.
 *
 * WHY THIS SPEC EXISTS. Every other interview spec runs with
 * NUXT_PUBLIC_INTERVIEW_PROVIDER_MOCK=true (playwright.config.ts), so `createProvider`
 * returns the in-page mock before any provider arm is reached, and no spec looks at which
 * chunks the browser loads. None of them could show that a page served with the third
 * provider's runtime flag UNSET still downloads none of its code. This one does: it drives
 * a normal interview to the live call stage, with `/start` answering a `heygen` session and
 * the flag unset, and reads the body of every script the browser fetched.
 *
 * The markers are object keys the adapter (and the SDK it wraps) passes to `connect`.
 * Property names survive minification, and no other script in the app contains them, so
 * finding one in a loaded script means that code was shipped on the default path.
 *
 * WHAT IT DOES NOT COVER. Because the config forces the mock, the real HeyGen/Tavus
 * construction with the flag off is not exercised here; the unedited unit suite
 * `provider-factory.spec.ts` proves it.
 *
 * Runs in the `chromium` and `webkit` projects; the `mobile` project matches only the
 * unsupported-gate spec.
 */

const LIVE_URL = '/en/interview/default-path-token'
const ADAPTER_MARKERS = ['forwardTranscript', 'completionPhrases']

/** Every script the page fetches, as its URL and body, including prefetched ones. */
function collectScripts(page: Page): () => Promise<Array<{ url: string; body: string }>> {
  const pending: Array<Promise<{ url: string; body: string }>> = []
  page.on('response', (response) => {
    const url = response.url()
    if (response.request().resourceType() !== 'script' && !/\.m?js(?:\?|$)/.test(url)) return
    pending.push(
      response
        .text()
        .then((body) => ({ url, body }))
        .catch(() => ({ url, body: '' }))
    )
  })
  return () => Promise.all(pending)
}

test.describe('the default provider path', () => {
  test('renders the call stage and loads no script of the third provider', async ({ page }) => {
    await mockBrandedInterview(page)
    await injectCallMedia(page)
    const scripts = collectScripts(page)

    await page.goto(LIVE_URL)
    await page.getByRole('button', { name: /accept and continue/i }).click({ timeout: 15000 })
    const start = page.getByRole('button', { name: /start the interview/i })
    await expect(start).toBeEnabled({ timeout: 8000 })
    await start.click()

    // The same stage the existing call specs assert.
    await expect(page.locator('[data-slot="call-layout"]')).toHaveAttribute('data-live', 'true', {
      timeout: 15000,
    })
    await expect(page.getByTestId('call-question')).toBeVisible()

    const loaded = await scripts()
    // A vacuous pass is not a pass: the app itself must have been fetched.
    expect(loaded.filter((script) => script.body.length > 0).length).toBeGreaterThan(3)
    for (const marker of ADAPTER_MARKERS) {
      const offenders = loaded.filter((script) => script.body.includes(marker)).map((s) => s.url)
      expect(offenders, `scripts carrying "${marker}"`).toEqual([])
    }
  })
})
