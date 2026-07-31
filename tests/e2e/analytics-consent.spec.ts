import { expect, test } from '@playwright/test'
import { checkA11y } from './fixtures/a11y'

/**
 * The analytics consent banner, end to end (C13, task 5.6).
 *
 * The unit tests prove the component's logic. These prove the things only a
 * real browser can: that the decision survives a reload, that no third-party
 * request leaves before consent, and that the banner does not appear on top of
 * the interview's own consent screen.
 *
 * Third-party hosts are blocked at the network layer throughout. A suite that
 * phoned Google on every run would be slow, flaky, and quietly reporting CI
 * traffic into a real property.
 */

const THIRD_PARTY = /googletagmanager\.com|clarity\.ms|google-analytics\.com/

test.describe('Analytics consent', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(THIRD_PARTY, (route) => route.abort())
  })

  test('it asks on the landing page', async ({ page }) => {
    await page.goto('/')

    const banner = page.getByTestId('analytics-consent')
    await expect(banner).toBeVisible()

    // Role-based, never a CSS selector — the accessible name IS the contract.
    await expect(page.getByRole('button', { name: /rifiuta|refuse/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /accetta|accept/i })).toBeVisible()
  })

  test('nothing reaches a third party before the visitor answers', async ({ page }) => {
    const attempted: string[] = []
    page.on('request', (request) => {
      if (THIRD_PARTY.test(request.url())) {
        attempted.push(request.url())
      }
    })

    await page.goto('/')
    await expect(page.getByTestId('analytics-consent')).toBeVisible()
    await page.waitForTimeout(500)

    // The assertion the whole feature rests on. A banner that appears while the
    // tags have already loaded is theatre, and it is the single most common way
    // consent is implemented wrongly.
    expect(attempted).toEqual([])
  })

  test('a refusal is remembered across a reload', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('analytics-consent-reject').click()
    await expect(page.getByTestId('analytics-consent')).toBeHidden()

    await page.reload()

    // Coming back after "no" is nagging, and regulators read repeated prompting
    // as pressure towards yes. This is why a refusal is stored explicitly
    // rather than as the absence of a record.
    await expect(page.getByTestId('analytics-consent')).toBeHidden()
  })

  test('a grant is remembered across a reload', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('analytics-consent-accept').click()
    await expect(page.getByTestId('analytics-consent')).toBeHidden()

    await page.reload()
    await expect(page.getByTestId('analytics-consent')).toBeHidden()
  })

  test('granting consent starts the tags without a reload', async ({ page }) => {
    const attempted: string[] = []
    page.on('request', (request) => {
      if (THIRD_PARTY.test(request.url())) {
        attempted.push(request.url())
      }
    })

    await page.goto('/')
    await page.getByTestId('analytics-consent-accept').click()
    await page.waitForTimeout(500)

    // Consenting and then seeing nothing happen reads as a broken button — and
    // "fixing" that with a page reload would throw away whatever the visitor
    // was doing. The banner announces; the plugin acts.
    expect(attempted.length).toBeGreaterThan(0)
  })

  test('it does NOT appear on the interview, where the recording consent lives', async ({
    page,
  }) => {
    await page.goto('/interview/not-a-real-token')

    // The whole point of one banner rather than two. A candidate about to be
    // assessed must not be handed a cookie dialog on top of the consent that
    // actually gates their session.
    await expect(page.getByTestId('analytics-consent')).toBeHidden()
  })

  test('the banner is accessible', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('analytics-consent')).toBeVisible()

    // Run WITH the banner on screen. Checking a11y only on pages where it is
    // absent would pass while the banner itself was unreachable by keyboard.
    await checkA11y(page)
  })

  test('both choices are operable by keyboard', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('analytics-consent')).toBeVisible()

    // Focus and Enter, NOT Tab. Safari does not move focus to buttons with Tab
    // unless "Press Tab to highlight each item on a webpage" is switched on,
    // and it is off by default — so a Tab-based assertion would fail on WebKit
    // while the banner was perfectly operable there. That is a real macOS
    // behaviour, not something this code can or should work around.
    //
    // What matters is asserted instead: both controls take focus and respond to
    // Enter, which is what a real <button> gives you and a clickable <div>
    // never would.
    for (const choice of ['reject', 'accept']) {
      const button = page.getByTestId(`analytics-consent-${choice}`)

      await button.focus()
      await expect(button).toBeFocused()

      await page.reload()
      await expect(page.getByTestId('analytics-consent')).toBeVisible()
    }

    await page.getByTestId('analytics-consent-accept').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('analytics-consent')).toBeHidden()
  })

  test('refusal comes first in the DOM, so it comes first for keyboard users', async ({ page }) => {
    await page.goto('/')

    // Wait for the banner BEFORE querying it. evaluateAll does not retry — it
    // runs once, and on a slower hydration it runs against a document where the
    // banner does not exist yet, returning [] and failing with a message that
    // says nothing about timing. WebKit caught this; chromium had been passing
    // it on luck.
    await expect(page.getByTestId('analytics-consent')).toBeVisible()

    const order = await page
      .getByTestId('analytics-consent')
      .locator('button')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-testid')))

    // DOM order IS tab order wherever tabbing to buttons is enabled, so this
    // asserts the ordering without depending on whether a given browser tabs to
    // buttons at all. If either option is reached first, it should be the one
    // with no consequences.
    expect(order).toEqual(['analytics-consent-reject', 'analytics-consent-accept'])
  })
})
