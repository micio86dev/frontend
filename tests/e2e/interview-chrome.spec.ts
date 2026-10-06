import { test, expect, type Page } from '@playwright/test'
import { checkA11y } from './fixtures/a11y'
import { injectDeviceMocks } from './fixtures/device-mocks'

/**
 * The interview chrome on the brand canvas (DESIGN.md §7.0.1, §7.2).
 *
 * The client colour is arbitrary, so the consent, device check and live
 * screens are run through axe under a light client colour, where on-primary is
 * black, and a dark one, where it is white. Either can break a pair the other
 * never exercises: white text on yellow, a yellow fill on a white surface.
 */

const TOKEN = 'chrome-token-abc123'

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function makeCandidateJwt(): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      typ: 'candidate',
      candidate_ref: 'cand-chrome-001',
      project_id: 1,
      exp: Math.floor(Date.now() / 1000) + 7200,
    })
  )
  return `${header}.${payload}.e2e-fake-signature`
}

const START_RESPONSE = {
  session_id: 1,
  provider: 'heygen',
  provider_token: 'heygen-token-xyz',
  audio_only: false,
  question_context: {
    question_index: 0,
    total_questions: 3,
    end_phrase: 'Let us move on to the next question.',
    final_phrase: 'Thank you for your time.',
    competency_code: 'COM',
  },
}

async function mockBrandedInterview(page: Page, primaryColor: string): Promise<void> {
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
      body: JSON.stringify({
        data: {
          project: { exit_redirect_url: null },
          branding: { primary_color: primaryColor, logo_url: null, name: 'Acme Selezione' },
        },
      }),
    })
  )
  await page.route('**/api/candidate/interview/start', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(START_RESPONSE),
    })
  )
  for (const path of ['utterance', 'integrity', 'snapshot']) {
    await page.route(`**/api/candidate/interview/${path}`, (route) =>
      route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok' }),
      })
    )
  }
}

/** The colour the canvas actually painted, as `rgb(r, g, b)`. */
async function canvasColour(page: Page): Promise<string> {
  return page.locator('.brand-canvas').evaluate((node) => getComputedStyle(node).backgroundColor)
}

for (const [label, colour, rgb] of [
  ['light #ffd400', '#ffd400', 'rgb(255, 212, 0)'],
  ['dark #771aaf', '#771aaf', 'rgb(119, 26, 175)'],
] as const) {
  test.describe(`interview chrome on the brand canvas — ${label}`, () => {
    test.beforeEach(async ({ page }) => {
      await mockBrandedInterview(page, colour)
      await injectDeviceMocks(page)
    })

    test('consent, device check and live screens are legible (axe) on the client colour', async ({
      page,
    }) => {
      await page.goto(`/en/interview/${TOKEN}`)

      const steps = page.getByRole('list', { name: /interview steps/i })
      await expect(page.getByRole('button', { name: /accept and continue/i })).toBeVisible({
        timeout: 15000,
      })
      await expect.poll(() => canvasColour(page)).toBe(rgb)
      await expect(page.getByText('Acme Selezione')).toBeVisible()
      await expect(steps.locator('[aria-current="step"]')).toContainText('Consent')
      await checkA11y(page)

      await page.getByRole('button', { name: /accept and continue/i }).click()
      await expect(page.getByRole('button', { name: /start the interview/i })).toBeEnabled({
        timeout: 8000,
      })
      await expect(steps.locator('[aria-current="step"]')).toContainText('Devices')
      await checkA11y(page)

      await page.getByRole('button', { name: /start the interview/i }).click()
      await expect(page.getByRole('button', { name: /^pause$/i })).toBeVisible({ timeout: 15000 })
      await expect(page.getByRole('timer')).toBeVisible()
      await expect(page.getByText(/listen to the question/i)).toBeVisible()
      await expect.poll(() => canvasColour(page)).toBe(rgb)
      await checkA11y(page)
    })
  })
}

test.describe('device check fits the desktop viewport', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('does not scroll at 1440x900', async ({ page }) => {
    await mockBrandedInterview(page, '#771aaf')
    await injectDeviceMocks(page)
    await page.goto(`/en/interview/${TOKEN}`)
    await page.getByRole('button', { name: /accept and continue/i }).click({ timeout: 15000 })
    await expect(page.getByRole('button', { name: /start the interview/i })).toBeEnabled({
      timeout: 8000,
    })

    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })
})
