import { test, expect, type Page } from '@playwright/test'
import { injectCallMedia } from './fixtures/device-mocks'
import { mockBrandedInterview } from './fixtures/branded-interview'

/**
 * The candidate call screen, end to end, with `candidateCallUi` switched ON
 * (candidate-interview-call-ui, UI-10).
 *
 * Runs only in the `chromium-call` and `webkit-call` projects, against the third
 * web server of `playwright.config.ts`: the SAME build as the main suite, started
 * with `NUXT_PUBLIC_CANDIDATE_CALL_UI=true`. The main suite keeps testing the old
 * screen until the flag is flipped, so the two never share a server.
 *
 * The provider is the in-page mock the factory installs
 * (`NUXT_PUBLIC_INTERVIEW_PROVIDER_MOCK`), driven through `window.__mockInterviewProvider`;
 * every API call is answered by `page.route`.
 */

const TOKEN = 'call-token-abc123'
const LIVE_URL = `/en/interview/${TOKEN}`

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

/** What a spec needs to know about the calls the page made. */
interface CallApi {
  starts: () => number
}

/** The branded interview routes, plus the start counter the Resume assertion reads. */
async function mockCallApi(page: Page, primaryColor: string | null = '#771aaf'): Promise<CallApi> {
  await mockBrandedInterview(page, primaryColor)
  await injectCallMedia(page)

  let starts = 0
  // LIFO: registered after the branded fixture's own /start, so this one answers.
  await page.route('**/api/candidate/interview/start', (route) => {
    starts += 1
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(START_RESPONSE),
    })
  })

  return { starts: () => starts }
}

/** Consent, device check, then the live call screen. */
async function reachLiveCall(page: Page): Promise<void> {
  await page.goto(LIVE_URL)
  await page.getByRole('button', { name: /accept and continue/i }).click({ timeout: 15000 })
  const start = page.getByRole('button', { name: /start the interview/i })
  await expect(start).toBeEnabled({ timeout: 8000 })
  await start.click()
  await expect(page.getByTestId('call-question')).toBeVisible({ timeout: 15000 })
}

test.describe('the call stage with candidateCallUi on', () => {
  test.beforeEach(async ({ page }) => {
    await mockCallApi(page)
  })

  test('the call stage renders', async ({ page }) => {
    await reachLiveCall(page)

    await expect(page.locator('[data-slot="call-layout"]')).toHaveAttribute('data-live', 'true')
    await expect(page.getByTestId('call-question-hint')).toBeVisible()
    await expect(page.getByTestId('call-panel')).toBeVisible()
    await expect(page.getByTestId('call-exit')).toBeVisible()
    await expect(page.getByTestId('call-help-link')).toBeVisible()
    await expect(page.locator('[data-slot="call-stage-self"]')).toBeVisible()

    // The old live screen's own controls are not on this one.
    await expect(page.getByRole('button', { name: /^pause$/i })).toHaveCount(0)
  })
})
