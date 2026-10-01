import { test, expect } from '@playwright/test'
import type { Browser, Page, Request } from '@playwright/test'
import { checkA11y } from './fixtures/a11y'
import { injectDeviceMocks } from './fixtures/device-mocks'

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

const consentScreen = (page: Page) =>
  page.getByRole('region', { name: /privacy notice and consent/i })

/** The terminal page for a link that is not valid, reached by `replace`. */
async function expectLinkInvalidTerminal(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/en\/interview\/terminal\?reason=link_invalid$/)
  await expect(page.getByText('This Link Is No Longer Valid')).toBeVisible()
  await expect(page.getByRole('button', { name: /try again|retry/i })).toHaveCount(0)
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
  test('redeems once with the token in the BODY, strips the fragment first, and lands on the session route', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page)
    const atFetch = await watchRedeemFetch(page)
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
    const atFetch = await watchRedeemFetch(page)
    await mockCandidateSession(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

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

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

    await expectLinkInvalidTerminal(page)
    // Terminal means one request and no second try, however long it is left.
    await expectCountStays(() => redeem.calls.length, 1)
    await expectTokenNowhereInThePage(page)
  })

  test('a 429 shows the busy state, and Retry re-posts the same token and succeeds', async ({
    page,
  }) => {
    const redeem = await mockRedeem(page, [429, 'ok'])
    const atFetch = await watchRedeemFetch(page)
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

    // A 429 is ONE request. The mock sends `Retry-After: 1`; the window below is
    // longer than that, so a page that retried on its own would be caught here.
    await expectCountStays(() => redeem.calls.length, 1)

    await page.getByRole('button', { name: 'Try again' }).click()

    await expect(page).toHaveURL(/\/en\/interview\/session$/)
    // Retry is exactly one more request, not a burst.
    await expectCountStays(() => redeem.calls.length, 2, 500)
    expect(redeem.calls.map((call) => call.body)).toEqual([
      { link_token: LINK_TOKEN },
      { link_token: LINK_TOKEN },
    ])
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

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

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

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

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

      await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

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

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

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
    expect(redeem.calls.map((call) => call.body)).toEqual([
      { link_token: LINK_TOKEN },
      { link_token: LINK_TOKEN },
    ])
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

      await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

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

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    expect(await storedSession(page)).toBeNull()
  })
})

test.describe('reusable entry route — Retry sends exactly one request', () => {
  test('a real double click on Try again is one request', async ({ page }) => {
    const redeem = await mockRedeem(page, [503, 'ok'])
    await mockCandidateSession(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
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

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

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

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
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
  await page.evaluate((value) => {
    window.location.hash = value
  }, token)

  // `popstate` fires first, so vue-router starts a navigation to the pasted
  // fragment while the plugin's `hashchange` strip runs. That navigation is
  // asynchronous (the global middleware are awaited), and Nuxt's `navigateTo`
  // called while one is in flight is taken for a middleware redirect and does
  // nothing. The tests that go on to leave the entry route (the redeem is
  // released, a soft navigation is made) would then lose that navigation about
  // one run in three, depending on how fast the runner is.
  //
  // Waiting for the router to ADOPT the pasted fragment is the event that
  // matters: it is what ends that navigation. No sleep, no longer timeout.
  await page.waitForFunction((value) => {
    const root = document.querySelector('#__nuxt') as unknown as {
      __vue_app__: {
        config: { globalProperties: { $router: { currentRoute: { value: { hash: string } } } } }
      }
    }

    return root.__vue_app__.config.globalProperties.$router.currentRoute.value.hash === `#${value}`
  }, token)
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

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)
    await expect.poll(() => redeem.calls.length).toBe(1)
    await expect(page.getByRole('main')).toHaveAttribute('aria-busy', 'true')

    // The tab is still on the entry route (its redeem is in flight) when a second
    // link is pasted over the address bar.
    await pasteIntoThisTab(page, PASTED_TOKEN)

    await expect.poll(() => page.evaluate(() => window.location.href)).not.toContain('beai_rl_')
    await expectTokenNowhereInThePage(page)

    redeem.release()
    await expect(page).toHaveURL(/\/en\/interview\/session$/)

    // One redeem, for the link that was opened: the pasted one never reached the api.
    await expectCountStays(() => redeem.calls.length, 1)
    expect((redeem.calls[0] as RedeemCall).body).toEqual({ link_token: LINK_TOKEN })
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

test.describe('reusable entry route — every state passes WCAG 2.1 AA', () => {
  test('the loading state (a redeem still in flight)', async ({ page }) => {
    const redeem = await mockRedeem(page, ['pending'])
    await mockCandidateSession(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

    // The loading <main> is the only landmark here, and it announces itself busy.
    await expect(page.getByRole('main')).toHaveAttribute('aria-busy', 'true')
    await expect.poll(() => redeem.calls.length).toBe(1)
    await checkA11y(page)

    // Let it finish, so the test does not end with a request still held.
    redeem.release()
    await expect(page).toHaveURL(/\/en\/interview\/session$/)
  })

  test('the terminal "link is no longer valid" page', async ({ page }) => {
    await mockRedeem(page, [404])

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

    await expectLinkInvalidTerminal(page)
    await checkA11y(page)
  })

  test('the consent screen the visitor lands on', async ({ page }) => {
    await mockRedeem(page)
    await mockCandidateSession(page)

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

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

    await page.goto(`/en/interview/reusable#${LINK_TOKEN}`)

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
