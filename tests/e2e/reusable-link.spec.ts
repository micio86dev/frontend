import { test, expect } from '@playwright/test'
import type { Browser, Page, Request } from '@playwright/test'
import { checkA11y } from './fixtures/a11y'

/**
 * Playwright E2E — the reusable entry route `/interview/reusable#beai_rl_<43>`
 * (reusable-interview-links, AD-16).
 *
 * The link token is a live, non-expiring credential carried in the URL FRAGMENT.
 * What this file proves, against the real built app with the api network-
 * intercepted, is the part no unit test can: the fragment is gone from the
 * address bar before the request goes out, the redeem call carries the token in
 * its BODY and nowhere else, the route is matched ahead of `interview/[token]`
 * (no `GET /api/sso/exchange`), and a phone, Firefox or a narrow window never
 * redeems.
 *
 * Projects: chromium + webkit. The `mobile` project (Pixel 7) runs only
 * `unsupported-gate.spec.ts`, where the phone case for this route lives.
 *
 * Locators are role-based; none reads CSS.
 */

const LINK_TOKEN = 'beai_rl_9AuXUvnfk8dgg-mOHfBcWFbQ98k_MXZ5SChgVAqzCpY'
const REDEEM = '**/api/reusable-links/redeem'

const FIREFOX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** A candidate JWT shaped closely enough for useCandidateSession to decode client-side. */
function makeCandidateJwt(candidateRef: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      typ: 'candidate',
      candidate_ref: candidateRef,
      project_id: 1,
      exp: Math.floor(Date.now() / 1000) + 7200,
    })
  )

  return `${header}.${payload}.e2e-fake-signature`
}

interface RedeemCall {
  method: string
  url: string
  body: unknown
  /** `page.url()` at the moment the request left the browser. */
  pageUrlAtRequest: string
}

/**
 * Intercepts the redeem endpoint. Each answer is consumed in order and the last
 * one repeats, so a test can say "429 once, then 200". Every 200 mints a
 * DIFFERENT visitor, like the real api does.
 */
async function mockRedeem(
  page: Page,
  answers: Array<number | 'ok'> = ['ok']
): Promise<{ calls: RedeemCall[] }> {
  const calls: RedeemCall[] = []
  let visitors = 0

  await page.route(REDEEM, (route) => {
    const request = route.request()
    const answer = answers[Math.min(calls.length, answers.length - 1)] as number | 'ok'

    calls.push({
      method: request.method(),
      url: request.url(),
      body: request.postDataJSON() as unknown,
      pageUrlAtRequest: page.url(),
    })

    if (answer === 'ok') {
      visitors += 1
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: makeCandidateJwt(`rlv_E2EVISITOR${visitors}`) }),
      })
    }

    return route.fulfill({
      status: answer,
      contentType: 'application/json',
      headers: answer === 429 ? { 'Retry-After': '1' } : {},
      body: JSON.stringify({ message: 'e2e' }),
    })
  })

  return { calls }
}

/** GET /api/candidate/session — the branding / exit-redirect read the session route makes. */
async function mockCandidateSession(page: Page): Promise<void> {
  await page.route('**/api/candidate/session', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { project: { exit_redirect_url: null } } }),
    })
  })
}

/** Counts every request to the single-use exchange: the reusable route must never make one. */
function watchSsoExchange(page: Page): { calls: Request[] } {
  const calls: Request[] = []

  page.on('request', (request) => {
    if (request.url().includes('/api/sso/exchange')) {
      calls.push(request)
    }
  })

  return { calls }
}

const consentScreen = (page: Page) =>
  page.getByRole('region', { name: /privacy notice and consent/i })

async function expectTokenNowhereInThePage(page: Page): Promise<void> {
  const where = await page.evaluate(() => ({
    href: window.location.href,
    historyState: JSON.stringify(window.history.state),
    localStorage: JSON.stringify(Object.entries(window.localStorage)),
    sessionStorage: JSON.stringify(Object.entries(window.sessionStorage)),
    dom: document.documentElement.outerHTML,
  }))

  for (const [name, value] of Object.entries(where)) {
    expect(value, `the link token leaked into ${name}`).not.toContain('beai_rl_')
  }
}

test.describe('reusable entry route — /interview/reusable#<token>', () => {
  test('redeems once with the token in the BODY, strips the fragment first, and lands on the session route', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page)
    const exchange = watchSsoExchange(page)
    await mockCandidateSession(page)

    await page.goto(`/interview/reusable#${LINK_TOKEN}`)

    await expect(page).toHaveURL(/\/interview\/session$/)
    expect(redeem.calls).toHaveLength(1)

    const [call] = redeem.calls as [RedeemCall]
    expect(call.method).toBe('POST')
    expect(call.body).toEqual({ link_token: LINK_TOKEN })
    expect(call.url).not.toContain('beai_rl_')
    expect(call.url).not.toContain('?')

    // The fragment was already gone when the request left the browser.
    expect(call.pageUrlAtRequest).toContain('/interview/reusable')
    expect(call.pageUrlAtRequest).not.toContain('#')
    expect(call.pageUrlAtRequest).not.toContain('beai_rl_')

    // The static route outranks `interview/[token]`: no single-use exchange.
    expect(exchange.calls).toHaveLength(0)

    expect(page.url()).not.toContain('#')
    await expectTokenNowhereInThePage(page)
  })

  test('stores the visitor session with the reusable marker', async ({ page }) => {
    await mockRedeem(page)
    await mockCandidateSession(page)

    await page.goto(`/interview/reusable#${LINK_TOKEN}`)
    await expect(page).toHaveURL(/\/interview\/session$/)

    const stored = await page.evaluate(() => window.localStorage.getItem('beai_candidate_session'))

    expect(JSON.parse(stored ?? '{}')).toMatchObject({
      entry: 'reusable',
      candidateRef: 'rlv_E2EVISITOR1',
    })
  })

  test('the English path behaves the same and keeps the locale on the session route', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page)
    await mockCandidateSession(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

    await expect(page).toHaveURL(/\/en\/interview\/session$/)
    await expect(consentScreen(page)).toBeVisible()
    expect(redeem.calls).toHaveLength(1)
    expect((redeem.calls[0] as RedeemCall).pageUrlAtRequest).not.toContain('beai_rl_')
    await expectTokenNowhereInThePage(page)
  })

  test('a 404 is the terminal "link is no longer valid" page, with no retry', async ({ page }) => {
    const redeem = await mockRedeem(page, [404])

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

    await expect(page).toHaveURL(/\/en\/interview\/terminal\?reason=link_invalid$/)
    await expect(page.getByText('This Link Is No Longer Valid')).toBeVisible()
    await expect(page.getByRole('button', { name: /try again|retry/i })).toHaveCount(0)
    expect(redeem.calls).toHaveLength(1)
    await expectTokenNowhereInThePage(page)
  })

  test('a 429 shows the busy state, and Retry re-posts the same token and succeeds', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page, [429, 'ok'])
    await mockCandidateSession(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

    await expect(
      page.getByRole('heading', { name: 'Many people are starting right now' })
    ).toBeVisible()
    // Retryable, and nothing about it claims the link is bad.
    await expect(page.getByText('This Link Is No Longer Valid')).toHaveCount(0)
    await expect(page).toHaveURL(/\/en\/interview\/reusable$/)
    await expectTokenNowhereInThePage(page)
    await checkA11y(page)

    await page.getByRole('button', { name: 'Try again' }).click()

    await expect(page).toHaveURL(/\/en\/interview\/session$/)
    expect(redeem.calls).toHaveLength(2)
    expect(redeem.calls.map((call) => call.body)).toEqual([
      { link_token: LINK_TOKEN },
      { link_token: LINK_TOKEN },
    ])
    // The retry never put the token back in the address bar.
    expect((redeem.calls[1] as RedeemCall).pageUrlAtRequest).not.toContain('beai_rl_')
    await expectTokenNowhereInThePage(page)
  })

  test('a 5xx shows the generic failed state with Retry, never "link is no longer valid"', async ({
    page,
  }) => {
    await mockRedeem(page, [503])

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

    await expect(
      page.getByRole('heading', { name: 'We could not start your interview' })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(page.getByText('This Link Is No Longer Valid')).toHaveCount(0)
    await checkA11y(page)
  })

  test('a reload with a stored reusable session resumes it WITHOUT a second redemption', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page)
    await mockCandidateSession(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
    await expect(page).toHaveURL(/\/en\/interview\/session$/)
    expect(redeem.calls).toHaveLength(1)

    // The fragment is gone, so this is exactly what a browser reload sends.
    await page.goto('/en/interview/reusable')

    await expect(page).toHaveURL(/\/en\/interview\/session$/)
    expect(redeem.calls).toHaveLength(1)
  })

  test('with no fragment and no session the page is the terminal "link is no longer valid", and no request is made', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page)

    await page.goto('/en/interview/reusable')

    await expect(page).toHaveURL(/\/en\/interview\/terminal\?reason=link_invalid$/)
    expect(redeem.calls).toHaveLength(0)
  })

  test('opening the link again in the same browser is a NEW visitor, never the previous one', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page)
    await mockCandidateSession(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
    await expect(page).toHaveURL(/\/en\/interview\/session$/)

    // A kiosk: the next person opens the same link in the same browser.
    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
    await expect(page).toHaveURL(/\/en\/interview\/session$/)

    expect(redeem.calls).toHaveLength(2)
    const stored = await page.evaluate(() => window.localStorage.getItem('beai_candidate_session'))
    expect(JSON.parse(stored ?? '{}')).toMatchObject({ candidateRef: 'rlv_E2EVISITOR2' })
  })

  test('the route carries the interview headers, camera and microphone included', async ({
    request,
  }) => {
    for (const path of ['/interview/reusable', '/en/interview/reusable']) {
      const response = await request.get(path)
      const headers = response.headers()

      expect(response.status(), path).toBe(200)
      expect(headers['permissions-policy'], path).toBe(
        'camera=(self), microphone=(self), geolocation=()'
      )
      expect(headers['x-frame-options'], path).toBe('DENY')
      expect(headers['x-content-type-options'], path).toBe('nosniff')
      expect(headers['referrer-policy'], path).toBe('strict-origin-when-cross-origin')
    }
  })

  test('the page is noindex and sends no referrer', async ({ page }) => {
    await mockRedeem(page, [503])

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
    await expect(
      page.getByRole('heading', { name: 'We could not start your interview' })
    ).toBeVisible()

    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow'
    )
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer')
  })
})

test.describe('reusable entry route — an unsupported browser never redeems (SA-11)', () => {
  async function openIn(
    browser: Browser,
    options: Parameters<Browser['newContext']>[0],
    path: string
  ): Promise<{ page: Page; calls: RedeemCall[]; close: () => Promise<void> }> {
    const context = await browser.newContext(options)
    const page = await context.newPage()
    const { calls } = await mockRedeem(page)

    await page.goto(path)

    return { page, calls, close: () => context.close() }
  }

  test('Firefox is redirected to /unsupported with no fragment and no redemption', async ({
    browser,
  }) => {
    const { page, calls, close } = await openIn(
      browser,
      { userAgent: FIREFOX_UA },
      `/interview/reusable#${LINK_TOKEN}`
    )

    try {
      await expect(page).toHaveURL(/\/unsupported$/)
      await expect(page.getByTestId('unsupported-gate')).toBeVisible()
      // The server's 302 carries the fragment across; the early plugin strips it.
      expect(page.url()).not.toContain('#')
      expect(page.url()).not.toContain('beai_rl_')
      expect(calls).toHaveLength(0)
      await expectTokenNowhereInThePage(page)
    } finally {
      await close()
    }
  })

  test('a narrow desktop window is redirected too, on the localized path', async ({ browser }) => {
    const { page, calls, close } = await openIn(
      browser,
      { viewport: { width: 800, height: 900 } },
      `/en/interview/reusable#${LINK_TOKEN}`
    )

    try {
      await expect(page).toHaveURL(/\/unsupported$/)
      await expect(page.getByTestId('unsupported-gate')).toBeVisible()
      expect(page.url()).not.toContain('beai_rl_')
      expect(calls).toHaveLength(0)
    } finally {
      await close()
    }
  })
})
