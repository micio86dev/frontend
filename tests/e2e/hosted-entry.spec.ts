import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Playwright E2E — public-api hosted entry route `/i/{token}` (step 5, G-32, G-33)
 *
 * `/i/{token}` is the hosted-interview entry route for candidates who open
 * the link directly (top-level, not the SSO-link flow it sits alongside).
 * It exchanges the public-api SESSION token exactly once against
 * `GET /api/embed/exchange` and replace-redirects to `/interview/session`.
 *
 * Projects: chromium + webkit (mobile project runs unsupported-gate.spec.ts
 * only, per playwright.config.ts's `testMatch` — its own coverage of this
 * route's mobile-redirect behavior lives there, not here).
 */

const consentScreen = (page: Page) =>
  page.getByRole('region', { name: /privacy notice and consent/i })
const terminalScreen = (page: Page) =>
  page.getByRole('region', { name: /service temporarily unavailable|session|link/i })

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** A public-api session token shaped closely enough for the page to decode client-side (SPEC §3.5). */
function makeSessionToken(sub = 'int_e2e_001'): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      iss: 'beai',
      sub,
      org: 'org_e2e',
      mode: 'live',
      aud: 'embed',
      exp: Math.floor(Date.now() / 1000) + 900,
    })
  )
  return `${header}.${payload}.e2e-fake-signature`
}

/** A candidate JWT shaped closely enough for useCandidateSession to decode client-side. */
function makeCandidateJwt(): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      typ: 'candidate',
      candidate_ref: 'cand-e2e-hosted',
      project_id: 1,
      exp: Math.floor(Date.now() / 1000) + 7200,
    })
  )
  return `${header}.${payload}.e2e-fake-signature`
}

async function mockCandidateSessionEndpoint(page: Page) {
  // GET /api/candidate/session — branding fetch after the exchange (unchanged
  // by this step). The real endpoint wraps a `ParticipantResource` in a
  // `data` envelope; mirrors interview-exit-redirect.spec.ts's fixture shape.
  await page.route('**/api/candidate/session', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { project: { exit_redirect_url: null } } }),
    })
  })
}

test.describe('hosted entry route — /i/{token} (public-api step 5)', () => {
  test('visiting /i/<token> exchanges once and lands on the session page consent screen', async ({
    page,
  }) => {
    let exchangeCalls = 0
    await page.route('**/api/embed/exchange*', (route) => {
      exchangeCalls++
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: makeCandidateJwt() }),
      })
    })
    await mockCandidateSessionEndpoint(page)

    await page.goto(`/en/i/${makeSessionToken()}`)

    await expect(consentScreen(page)).toBeVisible()
    await expect(page).toHaveURL(/\/interview\/session/)
    expect(exchangeCalls).toBe(1)
  })

  test('a 410 token_consumed exchange lands on the terminal page with the link_used copy', async ({
    page,
  }) => {
    await page.route('**/api/embed/exchange*', (route) => {
      route.fulfill({
        status: 410,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Token consumed',
          status: 410,
          code: 'token_consumed',
          request_id: 'req_e2e_1',
        }),
      })
    })

    await page.goto(`/en/i/${makeSessionToken()}`)

    await expect(terminalScreen(page)).toBeVisible()
    await expect(page).toHaveURL(/\/interview\/terminal\?reason=link_used/)
    await expect(page.getByText('This Link Has Already Been Used')).toBeVisible()
  })

  test('a 401 token_invalid exchange lands on the terminal page with the link_invalid copy', async ({
    page,
  }) => {
    await page.route('**/api/embed/exchange*', (route) => {
      route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Token invalid',
          status: 401,
          code: 'token_invalid',
          request_id: 'req_e2e_2',
        }),
      })
    })

    await page.goto(`/en/i/${makeSessionToken()}`)

    await expect(terminalScreen(page)).toBeVisible()
    await expect(page).toHaveURL(/\/interview\/terminal\?reason=link_invalid/)
    await expect(page.getByText('This Link Is No Longer Valid')).toBeVisible()
  })

  test('a revisit with a matching stored session skips the exchange entirely', async ({ page }) => {
    const sessionToken = makeSessionToken('int_e2e_revisit')
    let exchangeCalls = 0
    await page.route('**/api/embed/exchange*', (route) => {
      exchangeCalls++
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: makeCandidateJwt() }),
      })
    })
    await mockCandidateSessionEndpoint(page)

    // First visit: exchanges and stores the session (tagged with interviewId).
    await page.goto(`/en/i/${sessionToken}`)
    await expect(page).toHaveURL(/\/interview\/session/)
    expect(exchangeCalls).toBe(1)

    // Revisiting the SAME session-token URL must not burn it a second time —
    // the stored session's interviewId already matches this token's `sub`.
    await page.goto(`/en/i/${sessionToken}`)
    await expect(page).toHaveURL(/\/interview\/session/)
    expect(exchangeCalls).toBe(1)
  })
})
