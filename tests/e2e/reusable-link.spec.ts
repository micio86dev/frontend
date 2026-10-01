import { test, expect } from '@playwright/test'
import type { Browser, Page, Request } from '@playwright/test'
import { checkA11y } from './fixtures/a11y'
import { injectDeviceMocks } from './fixtures/device-mocks'
import { waitForHydration } from './fixtures/hydration'
import { startRouterPush, waitForRouterBusy, waitForRouterIdle } from './fixtures/nuxt-router-state'

/**
 * Playwright E2E — the reusable entry route `/interview/reusable#beai_rl_<43>`
 * (reusable-interview-links, AD-16).
 *
 * The link token is a live, non-expiring credential carried in the URL FRAGMENT,
 * and since reusable-link-visitor-identity the visitor types a name and an email
 * into a form before anything is redeemed. What this file proves, against the real
 * built app with the api network-intercepted, is the part no unit test can: the
 * form appears with ZERO requests and the fragment already gone, the redeem call
 * carries the token and the typed identity in its BODY and nowhere else (no URL,
 * storage, history, console or other request), the route is matched ahead of
 * `interview/[token]` (no `GET /api/sso/exchange`), a reload while the form is
 * shown ends on the truthful "open the link again" page, every state of the form
 * passes axe, and a phone, Firefox or a narrow window never shows the form or
 * redeems.
 *
 * Projects: chromium + webkit. The `mobile` project (Pixel 7) runs only
 * `unsupported-gate.spec.ts`, where the phone case for this route lives.
 *
 * Locators are role-based; none reads CSS.
 */

const LINK_TOKEN = 'beai_rl_9AuXUvnfk8dgg-mOHfBcWFbQ98k_MXZ5SChgVAqzCpY'
const REDEEM = '**/api/reusable-links/redeem'

/** What the visitor types. Sentinels no other string in the app contains, so a leak is a substring match. */
const VISITOR = { name: 'Ada Sentinel Lovelace', email: 'ada.sentinel@example.test' }

/** The exact body of a redemption: the token and the trimmed identity, nothing else. */
const REDEEM_BODY = {
  link_token: LINK_TOKEN,
  display_name: VISITOR.name,
  email: VISITOR.email,
}

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
function makeCandidateJwt(
  candidateRef: string,
  exp: number = Math.floor(Date.now() / 1000) + 7200
): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      typ: 'candidate',
      candidate_ref: candidateRef,
      project_id: 1,
      exp,
    })
  )

  return `${header}.${payload}.e2e-fake-signature`
}

interface RedeemCall {
  method: string
  url: string
  body: unknown
}

/**
 * One scripted answer of the redeem endpoint:
 *   - `'ok'`      200 with a fresh visitor's candidate token;
 *   - a number    that status with a bare `{ message }` body (429 adds `Retry-After`);
 *   - an object   that status with exactly that JSON body (the 403 `redirect_url` shape);
 *   - `'abort'`   the connection drops, so the browser never gets a response;
 *   - `'pending'` the request is held until `release()`, then answered `'ok'`.
 */
type RedeemAnswer = number | 'ok' | 'abort' | 'pending' | { status: number; body: unknown }

interface RedeemMock {
  calls: RedeemCall[]
  /** The candidate tokens handed out, in order: what the page must have stored and sent. */
  minted: string[]
  /** Lets every `'pending'` request through. */
  release: () => void
}

/**
 * Intercepts the redeem endpoint. Each answer is consumed in order and the last
 * one repeats, so a test can say "429 once, then 200". Every 200 mints a
 * DIFFERENT visitor, like the real api does.
 */
async function mockRedeem(page: Page, answers: RedeemAnswer[] = ['ok']): Promise<RedeemMock> {
  const calls: RedeemCall[] = []
  const minted: string[] = []
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })

  await page.route(REDEEM, async (route) => {
    const request = route.request()
    const answer = answers[Math.min(calls.length, answers.length - 1)] as RedeemAnswer

    calls.push({
      method: request.method(),
      url: request.url(),
      body: request.postDataJSON() as unknown,
    })

    if (answer === 'abort') {
      return route.abort('connectionreset')
    }

    if (answer === 'ok' || answer === 'pending') {
      if (answer === 'pending') {
        await released
      }

      const token = makeCandidateJwt(`rlv_E2EVISITOR${minted.length + 1}`)
      minted.push(token)

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: token }),
      })
    }

    if (typeof answer === 'object') {
      return route.fulfill({
        status: answer.status,
        contentType: 'application/json',
        body: JSON.stringify(answer.body),
      })
    }

    return route.fulfill({
      status: answer,
      contentType: 'application/json',
      headers: answer === 429 ? { 'Retry-After': '1' } : {},
      body: JSON.stringify({ message: 'e2e' }),
    })
  })

  return { calls, minted, release }
}

/** What the page itself saw at the instant `fetch` was called on the redeem endpoint. */
interface FetchRecord {
  url: string
  /** `location.href`: the address bar, fragment included. */
  href: string
  /** `JSON.stringify(history.state)`: the router's entry, where a token once lingered. */
  historyState: string
  historyLength: number
}

/**
 * Records, INSIDE the page and synchronously at the moment `fetch` is invoked
 * for the redeem endpoint, what the address bar and the history entry hold.
 *
 * Reading `page.url()` from a route handler is not the same claim: the handler
 * runs in the test process after the request has left, and Playwright's URL can
 * lag or lead `history.replaceState` (WebKit most of all). This wrapper has no
 * such gap: `href` is what the browser held when the request was made.
 *
 * `window.fetch` is wrapped because `ofetch` resolves `globalThis.fetch` per
 * call. The record lives in the document, so a navigation to another document
 * (an external redirect, a reload) starts it empty; every test that reads it
 * stays on the SPA.
 */
async function watchRedeemFetch(page: Page): Promise<{ read: () => Promise<FetchRecord[]> }> {
  await page.addInitScript(() => {
    const records: unknown[] = []
    ;(window as unknown as Record<string, unknown>)['__redeemFetches'] = records

    const original = window.fetch.bind(window)

    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)

      if (url.includes('/api/reusable-links/redeem')) {
        records.push({
          url,
          href: window.location.href,
          historyState: JSON.stringify(window.history.state),
          historyLength: window.history.length,
        })
      }

      return original(input, init)
    }
  })

  return {
    read: () =>
      page.evaluate(
        () => (window as unknown as Record<string, unknown>)['__redeemFetches'] as FetchRecord[]
      ),
  }
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

/** The copy the visitor reads (en), exactly as the spec fixes it. */
const DUPLICATE_COPY =
  'This email address has already been used for this interview. Please contact the person who shared the link with you.'
const EMAIL_INVALID_COPY = 'Enter a valid email address, like name@example.com.'

const consentScreen = (page: Page) =>
  page.getByRole('region', { name: /privacy notice and consent/i })

/** The terminal page for a link that is not valid, reached by `replace`. */
async function expectLinkInvalidTerminal(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/en\/interview\/terminal\?reason=link_invalid$/)
  await expect(page.getByText('This Link Is No Longer Valid')).toBeVisible()
  await expect(page.getByRole('button', { name: /try again|retry/i })).toHaveCount(0)
}

/** The identity form's controls, found by label and role in either locale. */
const NAME_LABEL = /^(full name|nome e cognome)$/i
const EMAIL_LABEL = /^email$/i
const identityForm = (page: Page) => page.getByTestId('reusable-identity-form')
const submitButton = (page: Page) => page.getByTestId('reusable-identity-submit')

async function fillIdentity(page: Page, identity: { name: string; email: string } = VISITOR) {
  await page.getByLabel(NAME_LABEL).fill(identity.name)
  await page.getByLabel(EMAIL_LABEL).fill(identity.email)
}

async function submitIdentity(page: Page): Promise<void> {
  await submitButton(page).click()
}

/**
 * Opens the link the way a visitor does and completes the form: the page shows the
 * form with no request, the visitor fills both fields and submits. Everything after
 * that is the test's own assertion.
 */
async function openLinkAndSubmit(
  page: Page,
  path: string = `/en/interview/reusable#${LINK_TOKEN}`,
  identity: { name: string; email: string } = VISITOR
): Promise<void> {
  await page.goto(path)
  await expect(identityForm(page)).toBeVisible()
  await fillIdentity(page, identity)
  await submitIdentity(page)
}

/** The terminal page for a reload while the identity form was shown, reached by `replace`. */
async function expectLinkReopenTerminal(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/en\/interview\/terminal\?reason=link_reopen$/)
  await expect(page.getByRole('heading', { name: 'Please open the link again' })).toBeVisible()
  await expect(page.getByText(/scan the QR code or use the message you received/)).toBeVisible()
  await expect(identityForm(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /try again|retry/i })).toHaveCount(0)
  // Not the untrue "this link is bad": the link is fine, the page just forgot it.
  await expect(page.getByText('This Link Is No Longer Valid')).toHaveCount(0)
}

/**
 * Asserts a counter does NOT move for a while. A request that must never happen
 * cannot be proven by looking once: the page would still be mid-flight. So every
 * "no request" and "exactly one request" claim in this file first waits for a
 * positive end state, then holds the number steady across a window long enough
 * to cover a retry honouring the mock's `Retry-After: 1`.
 */
async function expectCountStays(
  read: () => number,
  expected: number,
  windowMs = 1_500
): Promise<void> {
  const deadline = Date.now() + windowMs

  do {
    expect(read(), 'the number of redeem requests moved').toBe(expected)
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
}

/** Writes a stored candidate session before any page script runs. */
async function seedStoredSession(
  page: Page,
  options: { entry?: 'reusable'; exp?: number; candidateRef?: string } = {}
): Promise<string> {
  const exp = options.exp ?? Math.floor(Date.now() / 1000) + 7200
  const candidateRef = options.candidateRef ?? 'rlv_E2ESEEDED'
  const accessToken = makeCandidateJwt(candidateRef, exp)
  const record = JSON.stringify({
    accessToken,
    exp,
    candidateRef,
    projectId: 1,
    ...(options.entry ? { entry: options.entry } : {}),
  })

  await page.addInitScript((value) => {
    window.localStorage.setItem('beai_candidate_session', value)
  }, record)

  return accessToken
}

const storedSession = (page: Page) =>
  page.evaluate(() => window.localStorage.getItem('beai_candidate_session'))

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
  test('redeems once per submit with the token and identity in the BODY, strips the fragment first, and lands on the session route', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page)
    const atFetch = await watchRedeemFetch(page)
    const exchange = watchSsoExchange(page)
    await mockCandidateSession(page)

    await openLinkAndSubmit(page, `/interview/reusable#${LINK_TOKEN}`)

    await expect(page).toHaveURL(/\/interview\/session$/)
    expect(redeem.calls).toHaveLength(1)

    const [call] = redeem.calls as [RedeemCall]
    expect(call.method).toBe('POST')
    expect(call.body).toEqual(REDEEM_BODY)
    expect(call.url).not.toContain('beai_rl_')
    expect(call.url).not.toContain('?')

    // The fragment was already gone when the request left the browser: read
    // from INSIDE the page, at the moment `fetch` was called, so no ordering
    // between the test process and `history.replaceState` can fake it.
    const records = await atFetch.read()
    expect(records).toHaveLength(1)

    const [record] = records as [FetchRecord]
    expect(record.href).toContain('/interview/reusable')
    expect(record.href).not.toContain('#')
    expect(record.href).not.toContain('beai_rl_')
    expect(record.historyState).not.toContain('beai_rl_')

    // The static route outranks `interview/[token]`: no single-use exchange.
    expect(exchange.calls).toHaveLength(0)

    expect(page.url()).not.toContain('#')
    await expectTokenNowhereInThePage(page)
  })

  test('stores the visitor session with the reusable marker', async ({ page }) => {
    await mockRedeem(page)
    await mockCandidateSession(page)

    await openLinkAndSubmit(page, `/interview/reusable#${LINK_TOKEN}`)
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
    const atFetch = await watchRedeemFetch(page)
    await mockCandidateSession(page)

    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)

    await expect(page).toHaveURL(/\/en\/interview\/session$/)
    await expect(consentScreen(page)).toBeVisible()
    expect(redeem.calls).toHaveLength(1)

    const records = await atFetch.read()
    expect(records).toHaveLength(1)
    expect((records[0] as FetchRecord).href).not.toContain('beai_rl_')
    expect((records[0] as FetchRecord).href).not.toContain('#')
    await expectTokenNowhereInThePage(page)
  })

  test('a 404 is the terminal "link is no longer valid" page, with no retry', async ({ page }) => {
    const redeem = await mockRedeem(page, [404])

    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)

    await expectLinkInvalidTerminal(page)
    // Terminal means one request and no second try, however long it is left.
    await expectCountStays(() => redeem.calls.length, 1)
    await expectTokenNowhereInThePage(page)
  })

  test('a 429 shows the busy state, and Retry re-posts the same token AND identity and succeeds', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page, [429, 'ok'])
    const atFetch = await watchRedeemFetch(page)
    await mockCandidateSession(page)

    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)

    await expect(
      page.getByRole('heading', { name: 'Many people are starting right now' })
    ).toBeVisible()
    // Retryable, and nothing about it claims the link is bad.
    await expect(page.getByText('This Link Is No Longer Valid')).toHaveCount(0)
    await expect(page).toHaveURL(/\/en\/interview\/reusable$/)
    await expectTokenNowhereInThePage(page)
    await checkA11y(page)

    // A 429 is ONE request. The mock sends `Retry-After: 1`; the window below is
    // longer than that, so a page that retried on its own would be caught here.
    await expectCountStays(() => redeem.calls.length, 1)

    await page.getByRole('button', { name: 'Try again' }).click()

    await expect(page).toHaveURL(/\/en\/interview\/session$/)
    // Retry is exactly one more request, not a burst.
    await expectCountStays(() => redeem.calls.length, 2, 500)
    expect(redeem.calls.map((call) => call.body)).toEqual([REDEEM_BODY, REDEEM_BODY])
    // The retry never put the token back in the address bar either.
    const records = await atFetch.read()
    expect(records).toHaveLength(2)
    for (const record of records) {
      expect(record.href).not.toContain('beai_rl_')
      expect(record.href).not.toContain('#')
      expect(record.historyState).not.toContain('beai_rl_')
    }
    await expectTokenNowhereInThePage(page)
  })

  test('a 5xx shows the generic failed state with Retry, never "link is no longer valid"', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page, [503])

    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)

    await expect(
      page.getByRole('heading', { name: 'We could not start your interview' })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(page.getByText('This Link Is No Longer Valid')).toHaveCount(0)
    await checkA11y(page)
    // A failure is one request, not an automatic retry loop.
    await expectCountStays(() => redeem.calls.length, 1)
  })

  test('a reload with a stored reusable session resumes it WITHOUT a second redemption', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page)
    await mockCandidateSession(page)

    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)
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

    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)
    await expect(page).toHaveURL(/\/en\/interview\/session$/)

    // A kiosk: the next person opens the same link in the same browser.
    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)
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

    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)
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

test.describe('reusable entry route — a 403 and a dropped connection', () => {
  const EXTERNAL_PAGE = 'https://hr.acme.example.com/beai/closed?ref=acme-672'

  test('a 403 with an https redirect_url sends the visitor away to it, and nowhere else', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page, [
      { status: 403, body: { message: 'e2e', redirect_url: EXTERNAL_PAGE } },
    ])
    // The external page is fulfilled locally: the suite never leaves its sandbox.
    await page.route('https://hr.acme.example.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body>External closed page</body></html>',
      })
    )

    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)

    await page.waitForURL(EXTERNAL_PAGE)
    await expect(page.getByText('External closed page')).toBeVisible()
    // One request, and no gate was disclosed on the way out.
    expect(redeem.calls).toHaveLength(1)
    expect(page.url()).not.toContain('beai_rl_')
  })

  // The redirect target is operator-supplied data returned on a pre-session
  // route: only a validated https URL may ever be navigated to.
  for (const [label, redirectUrl] of [
    ['an http (downgrade) URL', 'http://hr.acme.example.com/beai/closed'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a malformed URL', 'not a url'],
    ['no redirect_url at all', null],
  ] as const) {
    test(`a 403 with ${label} is the generic terminal page, with no navigation away and no retry`, async ({
      page,
    }) => {
      const redeem = await mockRedeem(page, [
        { status: 403, body: { message: 'e2e', redirect_url: redirectUrl } },
      ])
      const leftTheApp: string[] = []
      page.on('request', (request) => {
        if (new URL(request.url()).hostname === 'hr.acme.example.com') {
          leftTheApp.push(request.url())
        }
      })

      await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)

      await expect(page).toHaveURL(/\/en\/interview\/terminal\?reason=403$/)
      await expect(page.getByRole('heading', { name: 'Session Not Authorized' })).toBeVisible()
      // The token is spent for this outcome: nothing to retry, so no control for it.
      await expect(page.getByRole('button', { name: /try again|retry/i })).toHaveCount(0)
      // Neither "this link is bad" nor a hint of which gate closed.
      await expect(page.getByText('This Link Is No Longer Valid')).toHaveCount(0)
      await expectCountStays(() => redeem.calls.length, 1)
      expect(leftTheApp).toEqual([])
      await expectTokenNowhereInThePage(page)
      await checkA11y(page)
    })
  }

  test('a dropped connection is the retryable failed state, never "link is no longer valid", and Retry succeeds', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page, ['abort', 'ok'])
    await mockCandidateSession(page)

    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)

    await expect(
      page.getByRole('heading', { name: 'We could not start your interview' })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(page.getByText('This Link Is No Longer Valid')).toHaveCount(0)
    await expect(page).toHaveURL(/\/en\/interview\/reusable$/)
    await expectCountStays(() => redeem.calls.length, 1)
    await expectTokenNowhereInThePage(page)

    await page.getByRole('button', { name: 'Try again' }).click()

    await expect(page).toHaveURL(/\/en\/interview\/session$/)
    await expect(consentScreen(page)).toBeVisible()
    await expectCountStays(() => redeem.calls.length, 2, 500)
    // The retry re-posts the SAME token, from the page's memory.
    expect(redeem.calls.map((call) => call.body)).toEqual([REDEEM_BODY, REDEEM_BODY])
  })
})

test.describe('reusable entry route — fragments that are not a link', () => {
  // The page strips ANY `#beai_rl_…` fragment, but only an exact 51-character
  // token is handed over. Everything else is "a fragment was there, but it is
  // not a link": terminal, and not one request to the api.
  for (const [label, fragment] of [
    ['too short', '#beai_rl_short'],
    ['one character too long', `#${LINK_TOKEN}A`],
    ['carrying a character outside base64url', `#beai_rl_${'a'.repeat(42)}!`],
  ] as const) {
    test(`a prefixed fragment that is ${label} is the terminal "link is no longer valid", stripped, with zero redeem requests`, async ({
      page,
    }) => {
      const redeem = await mockRedeem(page)

      await page.goto(`/en/interview/reusable${fragment}`)

      await expectLinkInvalidTerminal(page)
      // Terminal first, THEN the count: a request would have gone out before this point.
      await expectCountStays(() => redeem.calls.length, 0, 500)
      expect(page.url()).not.toContain('beai_rl_')
      await expectTokenNowhereInThePage(page)
    })
  }

  test('a fragment without the beai_rl_ prefix is not a link either: terminal, zero redeem requests', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page)

    await page.goto('/en/interview/reusable#not_a_link_token')

    await expectLinkInvalidTerminal(page)
    await expectCountStays(() => redeem.calls.length, 0, 500)
  })

  test('opening a malformed link still discards the previous visitor: nothing is resumed, nothing is left stored', async ({
    page,
  }) => {
    await seedStoredSession(page, { entry: 'reusable' })
    const redeem = await mockRedeem(page)

    await page.goto('/en/interview/reusable#beai_rl_short')

    await expectLinkInvalidTerminal(page)
    expect(await storedSession(page)).toBeNull()
    await expectCountStays(() => redeem.calls.length, 0, 500)
  })
})

test.describe('reusable entry route — a stored session without a fragment', () => {
  test('a stored session that this route did not store is never resumed: terminal, zero redeem requests', async ({
    page,
  }) => {
    // Valid and unexpired, but written by the single-use or hosted entry route:
    // no `entry: 'reusable'` marker.
    await seedStoredSession(page)
    const redeem = await mockRedeem(page)

    await page.goto('/en/interview/reusable')

    await expectLinkInvalidTerminal(page)
    await expectCountStays(() => redeem.calls.length, 0, 500)
  })

  test('an expired reusable session is not resumed and is purged: terminal, zero redeem requests', async ({
    page,
  }) => {
    await seedStoredSession(page, { entry: 'reusable', exp: Math.floor(Date.now() / 1000) - 60 })
    const redeem = await mockRedeem(page)

    await page.goto('/en/interview/reusable')

    await expectLinkInvalidTerminal(page)
    expect(await storedSession(page)).toBeNull()
    await expectCountStays(() => redeem.calls.length, 0, 500)
  })
})

test.describe('reusable entry route — a failed redeem leaves no previous visitor behind', () => {
  // A kiosk: the next person opens the link while the last person's session is
  // still in localStorage. Whatever the redeem answers, that session is gone,
  // so a failed attempt can never fall through to someone else's interview.
  for (const [label, answer] of [
    ['a 5xx', 503],
    ['a 429', 429],
    ['a 404', 404],
    ['a dropped connection', 'abort'],
  ] as const) {
    test(`after ${label} no previous reusable visitor session is stored`, async ({ page }) => {
      await seedStoredSession(page, { entry: 'reusable', candidateRef: 'rlv_PREVIOUSPERSON' })
      await mockRedeem(page, [answer])

      await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)

      // Wait for a positive end state of each outcome, then read the storage.
      if (answer === 404) {
        await expectLinkInvalidTerminal(page)
      } else {
        await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
      }

      expect(await storedSession(page)).toBeNull()
    })
  }

  test('a session stored by another entry route is discarded the same way', async ({ page }) => {
    await seedStoredSession(page, { candidateRef: 'cand-from-the-sso-link' })
    await mockRedeem(page, [503])

    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)

    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    expect(await storedSession(page)).toBeNull()
  })
})

test.describe('reusable entry route — Retry sends exactly one request', () => {
  test('a real double click on Try again is one request', async ({ page }) => {
    const redeem = await mockRedeem(page, [503, 'ok'])
    await mockCandidateSession(page)

    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)
    await page.getByRole('button', { name: 'Try again' }).dblclick()

    await expect(page).toHaveURL(/\/en\/interview\/session$/)
    // The first request failed; the double click made exactly one more.
    await expectCountStays(() => redeem.calls.length, 2, 500)
  })

  test('two clicks delivered in the same task are one request: the in-flight guard, not the re-render, stops the second', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page, [503, 'ok'])
    await mockCandidateSession(page)

    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)

    // A real double click can only reach the second handler if the page has not
    // re-rendered between the two clicks, and it normally has: the button is
    // gone after the first. Dispatching both inside one task removes that help,
    // so only the page's own in-flight guard can make this one request.
    await page.getByRole('button', { name: 'Try again' }).evaluate((button: HTMLElement) => {
      button.click()
      button.click()
    })

    await expect(page).toHaveURL(/\/en\/interview\/session$/)
    await expectCountStays(() => redeem.calls.length, 2, 500)
  })
})

test.describe('reusable entry route — no history entry holds the token', () => {
  test('after the redeem the visitor can go Back to where they came from, and no entry in between kept the link', async ({
    page,
  }) => {
    await mockRedeem(page)
    const atFetch = await watchRedeemFetch(page)
    await mockCandidateSession(page)

    // A known document before the link, so "Back" has somewhere definite to go
    // and an extra entry in the chain would be visible as a different Back target.
    await page.goto('/api/health')
    const lengthBefore = await page.evaluate(() => window.history.length)

    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)
    await expect(page).toHaveURL(/\/en\/interview\/session$/)

    // The browser does not let a page read the URLs of earlier entries, so this
    // is proven from two sides: how MANY entries exist (the link, the strip and
    // the redirect together added exactly ONE: `replaceState` and `replace`
    // never push) and WHERE Back lands (an entry that kept the fragment would be
    // the first stop). `history.state` is read at the moment of the request.
    expect(await page.evaluate(() => window.history.length)).toBe(lengthBefore + 1)
    const records = await atFetch.read()
    expect(records).toHaveLength(1)
    expect((records[0] as FetchRecord).historyLength).toBe(lengthBefore + 1)

    await page.goBack()
    await expect(page).toHaveURL(/\/api\/health$/)
    expect(page.url()).not.toContain('beai_rl_')

    // And Forward returns to the token-free session route, not the entry route.
    await page.goForward()
    await expect(page).toHaveURL(/\/en\/interview\/session$/)
    expect(page.url()).not.toContain('beai_rl_')
  })
})

/**
 * Pastes a link into the address bar of the tab that is already open: the same
 * document, only the fragment changes, so the browser fires `hashchange` and
 * nothing reloads (the early plugin's `hashchange` listener, AD-16).
 */
async function pasteIntoThisTab(page: Page, token: string): Promise<void> {
  // "A tab that is already open" means a hydrated one. Before hydration the
  // router is not listening yet: the plugin strips the fragment, the router never
  // sees it, and no navigation exists to be waited for.
  await waitForHydration(page)

  // Resolves from INSIDE the page on the `hashchange` it caused. The plugin's own
  // listener is registered earlier, so the strip has already run by then, and
  // `popstate` has already fired, so vue-router has already started its own
  // navigation to the pasted fragment.
  await page.evaluate(
    (value) =>
      new Promise<void>((resolve) => {
        window.addEventListener('hashchange', () => resolve(), { once: true })
        window.location.hash = value
      }),
    token
  )

  // That navigation is asynchronous (the global middleware are awaited), and
  // Nuxt's `navigateTo` called while one is in flight is taken for a middleware
  // redirect and does nothing. The tests that go on to leave the entry route (the
  // redeem is released, a soft navigation is made) would lose that navigation
  // depending on how fast the runner is.
  //
  // So wait for the router to be idle. Nuxt holds `_processingMiddleware` from the
  // start of a navigation to its `afterEach`, and that is reached whatever the
  // order of the events: it is not "the router adopted the pasted hash", which
  // never happens when the strip wins. No sleep, no longer timeout.
  //
  // That flag is a Nuxt internal, and "it is gone" is vacuously true once Nuxt stops
  // using it, so the helper first checks the installed Nuxt still works that way and
  // fails loudly, naming the assumption, when it does not.
  await waitForRouterIdle(page)
}

/** A second, well-formed token: what a visitor pastes over the first. */
const PASTED_TOKEN = 'beai_rl_Zk3dQ8vL0mXaP-7sTuYhWnBc_E2oRgJf1iVxKq4NzMw'

/**
 * Soft navigation to the entry route, the way an in-app link would: the page
 * mounts again WITHOUT a document load, which is what would hand a still-held
 * token to the redeem if the plugin had not discarded it.
 */
async function softNavigateTo(page: Page, path: string): Promise<void> {
  await page.evaluate(async (target) => {
    const root = document.querySelector('#__nuxt') as unknown as {
      __vue_app__: { config: { globalProperties: { $router: { push: (to: string) => unknown } } } }
    }

    await root.__vue_app__.config.globalProperties.$router.push(target)
  }, path)
}

test.describe('reusable entry route — a link pasted into a tab that is already open', () => {
  test('on the entry route itself: the pasted fragment is stripped at once and never redeemed from there', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page, ['pending'])
    await mockCandidateSession(page)

    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)
    await expect.poll(() => redeem.calls.length).toBe(1)
    await expect(identityForm(page)).toHaveAttribute('aria-busy', 'true')

    // The tab is still on the entry route (its redeem is in flight) when a second
    // link is pasted over the address bar.
    await pasteIntoThisTab(page, PASTED_TOKEN)

    await expect.poll(() => page.evaluate(() => window.location.href)).not.toContain('beai_rl_')
    await expectTokenNowhereInThePage(page)

    redeem.release()
    await expect(page).toHaveURL(/\/en\/interview\/session$/)

    // One redeem, for the link that was opened: the pasted one never reached the api.
    await expectCountStays(() => redeem.calls.length, 1)
    expect((redeem.calls[0] as RedeemCall).body).toEqual(REDEEM_BODY)
    await expectTokenNowhereInThePage(page)
  })

  test('on another route: stripped, no history entry keeps it, and it is discarded so a later visit to the entry route cannot redeem it', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page)
    await mockCandidateSession(page)

    await page.goto('/en/interview/terminal?reason=403')
    await expect(page).toHaveURL(/\/en\/interview\/terminal\?reason=403$/)

    await pasteIntoThisTab(page, LINK_TOKEN)

    await expect.poll(() => page.evaluate(() => window.location.href)).not.toContain('beai_rl_')
    await expectTokenNowhereInThePage(page)

    // Back must not land on an entry that kept the fragment either.
    await page.goBack()
    expect(page.url()).not.toContain('beai_rl_')
    await page.goForward()
    expect(page.url()).not.toContain('beai_rl_')
    await expectTokenNowhereInThePage(page)

    // The entry route, reached without a document load and without a fragment,
    // finds nothing to redeem: the pasted token was dropped, not parked.
    await softNavigateTo(page, '/en/interview/reusable')

    await expectLinkInvalidTerminal(page)
    await expectCountStays(() => redeem.calls.length, 0)
    expect(redeem.calls).toHaveLength(0)
    await expectTokenNowhereInThePage(page)
  })
})

test.describe('reusable entry route — leaving while a router navigation is in flight', () => {
  // Nuxt's `navigateTo` called while a router navigation is in flight is taken for a
  // middleware redirect and navigates nowhere (it returns a route object instead).
  // A pasted fragment starts exactly such a navigation, so a redeem that returns
  // during it used to strand the visitor on the page. The page leaves through
  // `router.replace`, which supersedes the pending navigation.
  //
  // The navigation is held in flight deterministically: it targets a route whose
  // JavaScript chunk has not been loaded yet, and that one request is held, so the
  // router stays in the middle of the navigation until the test lets go.
  test('the visitor still lands on the session route when the redeem returns mid-navigation', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page, ['pending'])
    await mockCandidateSession(page)

    let holding = false
    const held: Array<() => void> = []
    await page.route('**/_nuxt/**/*.js', async (route) => {
      if (!holding) return route.continue()
      await new Promise<void>((resolve) => held.push(resolve))
      return route.continue().catch(() => undefined)
    })

    await openLinkAndSubmit(page)
    await expect.poll(() => redeem.calls.length).toBe(1)

    // Start a navigation to a route that has to fetch its chunk, and do not wait for it.
    holding = true
    await startRouterPush(page, '/en/interview/terminal?reason=403')
    await expect.poll(() => held.length).toBeGreaterThan(0)
    // Precondition: Nuxt is mid-navigation (`_processingMiddleware`), the state that
    // makes `navigateTo` a no-op. A Nuxt internal: this throws a named error, rather
    // than timing out obscurely, if an upgrade changes it.
    await waitForRouterBusy(page)

    // The redeem answer arrives NOW, with the navigation still pending.
    holding = false
    redeem.release()

    try {
      await expect(page).toHaveURL(/\/en\/interview\/session$/)
      await expect(consentScreen(page)).toBeVisible()
    } finally {
      for (const release of held) release()
    }

    expect(redeem.calls).toHaveLength(1)
    await expectTokenNowhereInThePage(page)
  })
})

test.describe('reusable entry route — every state passes WCAG 2.1 AA', () => {
  test('the identity form, pristine', async ({ page }) => {
    await mockRedeem(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

    await expect(identityForm(page)).toBeVisible()
    // Nothing is focused on load, and no error reference dangles.
    await expect(page.getByLabel(NAME_LABEL)).not.toBeFocused()
    await expect(page.getByLabel(NAME_LABEL)).not.toHaveAttribute('aria-describedby', /.+/)
    await checkA11y(page)
  })

  test('the identity form with client-side errors', async ({ page }) => {
    await mockRedeem(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
    await submitIdentity(page)

    await expect(page.getByText('Enter your name.')).toBeVisible()
    await expect(page.getByText('Enter your email.')).toBeVisible()
    await checkA11y(page)
  })

  test('the identity form after a 409 (this email has already been used)', async ({ page }) => {
    await mockRedeem(page, [{ status: 409, body: { message: 'duplicate_enrolment' } }])

    await openLinkAndSubmit(page)

    await expect(page.getByText(DUPLICATE_COPY)).toBeVisible()
    await checkA11y(page)
  })

  test('the identity form after a 422', async ({ page }) => {
    await mockRedeem(page, [{ status: 422, body: { message: 'x', errors: { email: ['x'] } } }])

    await openLinkAndSubmit(page)

    await expect(page.getByText(EMAIL_INVALID_COPY)).toBeVisible()
    await checkA11y(page)
  })

  test('the identity form while the request is in flight (busy)', async ({ page }) => {
    const redeem = await mockRedeem(page, ['pending'])
    await mockCandidateSession(page)

    await openLinkAndSubmit(page)

    await expect.poll(() => redeem.calls.length).toBe(1)
    await expect(identityForm(page)).toHaveAttribute('aria-busy', 'true')
    await expect(submitButton(page)).toBeDisabled()
    await checkA11y(page)

    // Let it finish, so the test does not end with a request still held.
    redeem.release()
    await expect(page).toHaveURL(/\/en\/interview\/session$/)
  })

  test('the busy state (429) and the failed state', async ({ page }) => {
    await mockRedeem(page, [429])
    await openLinkAndSubmit(page)
    await expect(
      page.getByRole('heading', { name: 'Many people are starting right now' })
    ).toBeVisible()
    await checkA11y(page)
  })

  test('the failed state (a 5xx)', async ({ page }) => {
    await mockRedeem(page, [503])
    await openLinkAndSubmit(page)
    await expect(
      page.getByRole('heading', { name: 'We could not start your interview' })
    ).toBeVisible()
    await checkA11y(page)
  })

  test('the "open the link again" page reached by a reload', async ({ page }) => {
    await mockRedeem(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
    await expect(identityForm(page)).toBeVisible()
    await page.reload()

    await expectLinkReopenTerminal(page)
    await checkA11y(page)
  })

  test('the terminal "link is no longer valid" page', async ({ page }) => {
    await mockRedeem(page, [404])

    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)

    await expectLinkInvalidTerminal(page)
    await checkA11y(page)
  })

  test('the consent screen the visitor lands on', async ({ page }) => {
    await mockRedeem(page)
    await mockCandidateSession(page)

    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)

    await expect(consentScreen(page)).toBeVisible()
    await checkA11y(page)
  })
})

test.describe('reusable entry route — the visitor session reaches the interview', () => {
  // `required` by the contract, so the fixture sends it: a body without
  // `audio_only` is a malformed response and ends in the terminal page.
  const START_RESPONSE = {
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
  }

  test('the token the redeem returned is the credential on every candidate request, and the link token is on no request at all', async ({
    page,
  }) => {
    await injectDeviceMocks(page)
    const redeem = await mockRedeem(page)
    await mockCandidateSession(page)

    const seen: Request[] = []
    page.on('request', (request) => seen.push(request))

    await page.route('**/api/candidate/interview/start', (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(START_RESPONSE),
      })
    )
    for (const path of ['utterance', 'integrity', 'snapshot']) {
      await page.route(`**/api/candidate/interview/${path}`, (route) =>
        route.fulfill({ status: 202, contentType: 'application/json', body: '{}' })
      )
    }

    await openLinkAndSubmit(page, `/en/interview/reusable#${LINK_TOKEN}`)

    // Consent -> device check -> the interview starts: the page the redeem
    // landed on is the ordinary session route, with nothing reusable-specific left.
    await page.getByRole('button', { name: /accept and continue/i }).click()
    await expect(page.getByRole('button', { name: /start the interview/i })).toBeEnabled()
    await page.getByRole('button', { name: /start the interview/i }).click()
    // The mock provider reaching `live` proves /start was accepted.
    await page.waitForFunction(() =>
      Boolean((window as unknown as Record<string, unknown>)['__mockInterviewProvider'])
    )

    const [visitorToken] = redeem.minted as [string]
    const candidateRequests = seen.filter((request) =>
      new URL(request.url()).pathname.startsWith('/api/candidate/')
    )
    const paths = candidateRequests.map((request) => new URL(request.url()).pathname)

    // The branding read and the start call are both authenticated requests.
    expect(paths).toContain('/api/candidate/session')
    expect(paths).toContain('/api/candidate/interview/start')

    for (const request of candidateRequests) {
      expect(await request.headerValue('authorization'), request.url()).toBe(
        `Bearer ${visitorToken}`
      )
    }

    // The link token goes to the redeem BODY and nowhere else: not a URL, a
    // header (Referer included) or a body of any later request.
    for (const request of seen) {
      const label = `${request.method()} ${request.url()}`
      const isRedeem = request.url().includes('/api/reusable-links/redeem')

      expect(request.url(), label).not.toContain('beai_rl_')
      expect(JSON.stringify(await request.allHeaders()), label).not.toContain('beai_rl_')

      if (!isRedeem) {
        expect(request.postData() ?? '', label).not.toContain('beai_rl_')
      }
    }

    // The same stored record the requests were authorised from.
    const stored = JSON.parse((await storedSession(page)) ?? '{}') as Record<string, unknown>
    expect(stored).toMatchObject({ accessToken: visitorToken, entry: 'reusable' })
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

test.describe('reusable entry route — the identity form', () => {
  test('is shown with ZERO redeem requests and no fragment in the address bar', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page)
    const exchange = watchSsoExchange(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

    await expect(identityForm(page)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible()
    expect(page.url()).not.toContain('#')
    expect(page.url()).not.toContain('beai_rl_')
    await expectCountStays(() => redeem.calls.length, 0)
    expect(exchange.calls).toHaveLength(0)
    await expectTokenNowhereInThePage(page)
  })

  test('has no checkbox, no link and no verification step, and shows the privacy notice above the button', async ({
    page,
  }) => {
    await mockRedeem(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

    await expect(identityForm(page)).toBeVisible()
    await expect(identityForm(page).getByRole('checkbox')).toHaveCount(0)
    await expect(identityForm(page).getByRole('link')).toHaveCount(0)
    await expect(identityForm(page).getByRole('textbox')).toHaveCount(2)
    const notice = identityForm(page).getByText(
      'Your name and email are shared with the organization running this interview so your interview can be identified and requests about your data can be handled.'
    )
    await expect(notice).toBeVisible()
    await expect(submitButton(page)).toHaveAccessibleDescription(/shared with the organization/)

    // ABOVE the button, proved two ways: document order, and where it is painted.
    const follows = await notice.evaluate(
      (noticeElement, button) =>
        Boolean(
          button && noticeElement.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
      await submitButton(page).elementHandle()
    )
    expect(follows, 'the submit button must come AFTER the privacy notice in the DOM').toBe(true)

    const noticeBox = await notice.boundingBox()
    const buttonBox = await submitButton(page).boundingBox()
    expect(noticeBox, 'the notice has a box once visible').not.toBeNull()
    expect(buttonBox, 'the button has a box once visible').not.toBeNull()
    expect(
      (noticeBox?.y ?? Infinity) + (noticeBox?.height ?? 0),
      'the notice must end above the top of the button'
    ).toBeLessThanOrEqual(buttonBox?.y ?? -Infinity)
  })

  test('sends a body of exactly {link_token, display_name, email} with TRIMMED values', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page)
    await mockCandidateSession(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
    await expect(identityForm(page)).toBeVisible()
    await fillIdentity(page, { name: `   ${VISITOR.name}  `, email: `  ${VISITOR.email}   ` })
    await submitIdentity(page)

    await expect(page).toHaveURL(/\/en\/interview\/session$/)
    expect(redeem.calls).toHaveLength(1)
    expect((redeem.calls[0] as RedeemCall).body).toEqual(REDEEM_BODY)
    expect(Object.keys((redeem.calls[0] as RedeemCall).body as object).sort()).toEqual([
      'display_name',
      'email',
      'link_token',
    ])
  })

  test('keeps the token and the identity out of every store: sessionStorage holds only the flag while the form is shown and nothing after success', async ({
    page,
  }) => {
    await mockRedeem(page)
    await mockCandidateSession(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
    await expect(identityForm(page)).toBeVisible()
    await fillIdentity(page)

    const whileShown = await page.evaluate(() => ({
      local: Object.entries(window.localStorage),
      session: Object.entries(window.sessionStorage),
    }))
    expect(whileShown.local).toEqual([])
    expect(whileShown.session).toEqual([['beai_reusable_identity_pending', '1']])

    await submitIdentity(page)
    await expect(page).toHaveURL(/\/en\/interview\/session$/)

    const after = await page.evaluate(() => ({
      href: window.location.href,
      state: JSON.stringify(window.history.state),
      local: JSON.stringify(Object.entries(window.localStorage)),
      session: JSON.stringify(Object.entries(window.sessionStorage)),
    }))
    for (const [where, value] of Object.entries(after)) {
      for (const secret of ['beai_rl_', VISITOR.name, VISITOR.email]) {
        expect(value, `${secret} leaked into ${where}`).not.toContain(secret)
      }
    }
    expect(JSON.parse(after.session)).toEqual([])
  })

  test('an empty submit shows both errors, focuses the name and sends nothing', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
    await expect(identityForm(page)).toBeVisible()
    await submitIdentity(page)

    await expect(page.getByText('Enter your name.')).toBeVisible()
    await expect(page.getByText('Enter your email.')).toBeVisible()
    await expect(page.getByLabel(NAME_LABEL)).toBeFocused()
    await expect(page.getByLabel(NAME_LABEL)).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByLabel(EMAIL_LABEL)).toHaveAttribute(
      'aria-describedby',
      'reusable-identity-email-error'
    )
    await expectCountStays(() => redeem.calls.length, 0, 500)
  })

  test('a blank NAME with the email filled shows only the name message, focuses the name and sends nothing', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
    await expect(identityForm(page)).toBeVisible()
    await page.getByLabel(EMAIL_LABEL).fill(VISITOR.email)
    await submitIdentity(page)

    await expect(page.getByText('Enter your name.')).toBeVisible()
    await expect(page.getByText('Enter your email.')).toHaveCount(0)
    await expect(page.getByLabel(NAME_LABEL)).toBeFocused()
    await expect(page.getByLabel(NAME_LABEL)).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByLabel(EMAIL_LABEL)).not.toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByLabel(EMAIL_LABEL)).not.toHaveAttribute('aria-describedby', /.+/)
    await expectCountStays(() => redeem.calls.length, 0, 500)
  })

  test('a blank EMAIL with the name filled shows only the email message, focuses the email and sends nothing', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
    await expect(identityForm(page)).toBeVisible()
    await page.getByLabel(NAME_LABEL).fill(VISITOR.name)
    await submitIdentity(page)

    await expect(page.getByText('Enter your email.')).toBeVisible()
    await expect(page.getByText('Enter your name.')).toHaveCount(0)
    await expect(page.getByLabel(EMAIL_LABEL)).toBeFocused()
    await expect(page.getByLabel(EMAIL_LABEL)).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByLabel(NAME_LABEL)).not.toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByLabel(NAME_LABEL)).not.toHaveAttribute('aria-describedby', /.+/)
    await expectCountStays(() => redeem.calls.length, 0, 500)
  })

  test('a malformed email is refused on the page, with no request', async ({ page }) => {
    const redeem = await mockRedeem(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
    await expect(identityForm(page)).toBeVisible()
    await fillIdentity(page, { name: VISITOR.name, email: 'ana@gmail' })
    await submitIdentity(page)

    await expect(page.getByText(EMAIL_INVALID_COPY)).toBeVisible()
    await expect(page.getByLabel(EMAIL_LABEL)).toBeFocused()
    await expectCountStays(() => redeem.calls.length, 0, 500)
  })

  test('a 422 on the email shows the app’s OWN copy on that field and never the server text', async ({
    page,
  }) => {
    await mockRedeem(page, [
      {
        status: 422,
        body: {
          message: 'SERVER-TEXT-MUST-NOT-RENDER',
          errors: { email: ['SERVER-TEXT-MUST-NOT-RENDER'] },
        },
      },
    ])

    await openLinkAndSubmit(page)

    await expect(page.getByText(EMAIL_INVALID_COPY)).toBeVisible()
    await expect(page.getByLabel(EMAIL_LABEL)).toBeFocused()
    await expect(page.getByText('SERVER-TEXT-MUST-NOT-RENDER')).toHaveCount(0)
    // Still on the form, still editable, typed values kept.
    await expect(identityForm(page)).toBeVisible()
    await expect(page.getByLabel(NAME_LABEL)).toHaveValue(VISITOR.name)
    await expect(page.getByLabel(EMAIL_LABEL)).toHaveValue(VISITOR.email)
  })

  test('a 409 shows the duplicate copy on the email field; correcting it resubmits with the SAME token', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page, [
      { status: 409, body: { message: 'duplicate_enrolment' } },
      'ok',
    ])
    await mockCandidateSession(page)

    await openLinkAndSubmit(page)

    await expect(page.getByText(DUPLICATE_COPY)).toBeVisible()
    await expect(page.getByLabel(EMAIL_LABEL)).toBeFocused()
    await expect(page).toHaveURL(/\/en\/interview\/reusable$/)
    // The copy never offers a resume.
    await expect(page.getByText(/resume/i)).toHaveCount(0)

    await page.getByLabel(EMAIL_LABEL).fill('ada.other@example.test')
    await submitIdentity(page)

    await expect(page).toHaveURL(/\/en\/interview\/session$/)
    expect(redeem.calls.map((call) => call.body)).toEqual([
      REDEEM_BODY,
      { ...REDEEM_BODY, email: 'ada.other@example.test' },
    ])
  })

  test('a reload while the form is shown is the truthful "open the link again" page, with no request', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
    await expect(identityForm(page)).toBeVisible()
    await fillIdentity(page)
    await page.reload()

    await expectLinkReopenTerminal(page)
    await expectCountStays(() => redeem.calls.length, 0, 500)
    // The typed identity did not survive the reload, anywhere.
    await expect(page.getByText(VISITOR.email)).toHaveCount(0)
    await expectTokenNowhereInThePage(page)
  })

  test('the reopen page is localized, and opening the link again starts at an empty form', async ({
    page,
  }) => {
    await mockRedeem(page)

    await page.goto(`/interview/reusable#${LINK_TOKEN}`)
    await expect(identityForm(page)).toBeVisible()
    await page.reload()

    await expect(page).toHaveURL(/\/interview\/terminal\?reason=link_reopen$/)
    await expect(page.getByRole('heading', { name: 'Apri di nuovo il link' })).toBeVisible()

    await page.goto(`/interview/reusable#${LINK_TOKEN}`)
    await expect(identityForm(page)).toBeVisible()
    await expect(page.getByLabel(NAME_LABEL)).toHaveValue('')
    await expect(page.getByLabel(EMAIL_LABEL)).toHaveValue('')
  })

  test('without a form shown and without a session, the same reload is "link no longer valid", not "open again"', async ({
    page,
  }) => {
    await mockRedeem(page)

    await page.goto('/en/interview/reusable')

    await expectLinkInvalidTerminal(page)
    await expect(page.getByText('Please open the link again')).toHaveCount(0)
  })

  test('is completed with the keyboard alone: Tab, type, Enter, one request', async ({ page }) => {
    const redeem = await mockRedeem(page)
    await mockCandidateSession(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
    await expect(identityForm(page)).toBeVisible()

    await page.keyboard.press('Tab')
    await expect(page.getByLabel(NAME_LABEL)).toBeFocused()
    await page.keyboard.type(VISITOR.name)
    await page.keyboard.press('Tab')
    await expect(page.getByLabel(EMAIL_LABEL)).toBeFocused()
    await page.keyboard.type(VISITOR.email)
    await page.keyboard.press('Enter')

    await expect(page).toHaveURL(/\/en\/interview\/session$/)
    await expectCountStays(() => redeem.calls.length, 1, 500)
    expect((redeem.calls[0] as RedeemCall).body).toEqual(REDEEM_BODY)
  })

  test('a double click on Start the interview is ONE request while it is in flight', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page, ['pending'])
    await mockCandidateSession(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
    await expect(identityForm(page)).toBeVisible()
    await fillIdentity(page)

    await submitButton(page).dblclick()
    await expect.poll(() => redeem.calls.length).toBe(1)
    await expect(submitButton(page)).toBeDisabled()
    await expectCountStays(() => redeem.calls.length, 1, 500)

    redeem.release()
    await expect(page).toHaveURL(/\/en\/interview\/session$/)
    await expectCountStays(() => redeem.calls.length, 1, 500)
  })

  test('two submits delivered in the same task are one request: the in-flight guard, not the re-render, stops the second', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page, ['pending'])
    await mockCandidateSession(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
    await expect(identityForm(page)).toBeVisible()
    await fillIdentity(page)

    await identityForm(page).evaluate((form: HTMLFormElement) => {
      form.requestSubmit()
      form.requestSubmit()
    })

    await expect.poll(() => redeem.calls.length).toBe(1)
    await expectCountStays(() => redeem.calls.length, 1, 500)
    redeem.release()
    await expect(page).toHaveURL(/\/en\/interview\/session$/)
  })

  test('a 429 and a dropped connection show the inline retry, and Retry re-sends the SAME token and identity', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page, [429, 'abort', 'ok'])
    await mockCandidateSession(page)

    await openLinkAndSubmit(page)
    await expect(
      page.getByRole('heading', { name: 'Many people are starting right now' })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Try again' }).click()

    await expect(
      page.getByRole('heading', { name: 'We could not start your interview' })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Try again' }).click()

    await expect(page).toHaveURL(/\/en\/interview\/session$/)
    expect(redeem.calls.map((call) => call.body)).toEqual([REDEEM_BODY, REDEEM_BODY, REDEEM_BODY])
    await expectTokenNowhereInThePage(page)
  })

  test('a failure followed by Retry that finds a 409 returns to the form, prefilled', async ({
    page,
  }) => {
    await mockRedeem(page, [503, { status: 409, body: { message: 'duplicate_enrolment' } }])

    await openLinkAndSubmit(page)
    await page.getByRole('button', { name: 'Try again' }).click()

    await expect(page.getByText(DUPLICATE_COPY)).toBeVisible()
    await expect(page.getByLabel(NAME_LABEL)).toHaveValue(VISITOR.name)
    await expect(page.getByLabel(EMAIL_LABEL)).toHaveValue(VISITOR.email)
  })

  test('the typed name and email appear in no console output and in no request but the redemption body', async ({
    page,
  }) => {
    const consoleLines: string[] = []
    page.on('console', (message) => consoleLines.push(message.text()))
    page.on('pageerror', (error) => consoleLines.push(error.message))
    const seen: Request[] = []
    page.on('request', (request) => seen.push(request))

    const redeem = await mockRedeem(page, [429, 'ok'])
    await mockCandidateSession(page)

    await openLinkAndSubmit(page)
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page).toHaveURL(/\/en\/interview\/session$/)
    expect(redeem.calls).toHaveLength(2)

    for (const secret of [VISITOR.name, VISITOR.email, encodeURIComponent(VISITOR.email)]) {
      expect(consoleLines.join('\n'), `${secret} reached the console`).not.toContain(secret)
    }

    for (const request of seen) {
      const label = `${request.method()} ${request.url()}`
      const isRedeem = request.url().includes('/api/reusable-links/redeem')
      const carriers = [request.url(), JSON.stringify(await request.allHeaders())]
      if (!isRedeem) carriers.push(request.postData() ?? '')

      for (const carrier of carriers) {
        for (const secret of [VISITOR.name, VISITOR.email, encodeURIComponent(VISITOR.email)]) {
          expect(carrier, `${secret} leaked in ${label}`).not.toContain(secret)
        }
      }
    }
  })
})
