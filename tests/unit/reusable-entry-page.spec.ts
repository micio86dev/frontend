/**
 * app/pages/interview/reusable.vue — the reusable entry route
 * (reusable-interview-links, AD-16; spec "Reusable Entry Route")
 *
 * `/interview/reusable#beai_rl_<43>` redeems a reusable link at most once per
 * mount. The token in the fragment is a live, NON-EXPIRING credential, so most
 * of what this file pins is where it must not end up:
 *
 *  - the fragment is stripped from the address bar BEFORE any network call;
 *  - exactly one `POST /reusable-links/redeem`, token in the JSON body only;
 *  - every visit with a fragment is a NEW visitor — a stored session is
 *    cleared first, never resumed (a kiosk is not the previous person);
 *  - a reload has no fragment left, so it resumes only a stored session this
 *    route itself stored, and otherwise ends on the terminal `link_invalid`;
 *  - 404 is `link_invalid`; 403 is the single-use route's handling; 429, a 5xx
 *    and a dropped connection are RETRYABLE and never claim the link is bad —
 *    Retry re-posts the token held in memory, which `/interview/error` could not
 *    do because it navigates back to a URL that no longer carries the token.
 *
 * Page-level, with the network, router and storage faked at their boundaries.
 * The browser gate (a phone must not redeem) is a router middleware; its
 * contract is pinned in `browser-gate.spec.ts` and exercised end to end by the
 * Playwright spec.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

const { mockFetchImpl } = vi.hoisted(() => ({ mockFetchImpl: vi.fn() }))

vi.mock('ofetch', () => ({ $fetch: mockFetchImpl }))

// The shell asks for the organization's branding on mount; that is a separate
// authenticated request this page has nothing to do with.
vi.mock('~/app/composables/useCandidateBranding', () => ({
  useCandidateBranding: () => ({
    logoUrl: { value: null },
    organizationName: { value: null },
    ensureLoaded: vi.fn(),
  }),
}))

// eslint-disable-next-line import/first
import { useCandidateSession } from '~/app/composables/useCandidateSession'
// eslint-disable-next-line import/first
import {
  captureReusableLinkFragment,
  discardReusableLinkFragment,
} from '~/app/utils/reusable-link-fragment'
// eslint-disable-next-line import/first
import { REUSABLE_LINK_TOKEN } from './fixtures/reusable-link-scrub-cases'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_SECONDS = Math.floor(Date.now() / 1000)
const STORAGE_KEY = 'beai_candidate_session'
const LOCALE_MARKER = '/__locale-marker__'
const SESSION_ROUTE = `${LOCALE_MARKER}/interview/session`
const LINK_INVALID_ROUTE = `${LOCALE_MARKER}/interview/terminal?reason=link_invalid`
const FORBIDDEN_ROUTE = `${LOCALE_MARKER}/interview/terminal?reason=403`
const REUSABLE_PATH = '/interview/reusable'

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function makeCandidateJwt(overrides: Record<string, unknown> = {}): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      typ: 'candidate',
      candidate_ref: 'rlv_01HZVISITOR',
      project_id: 42,
      exp: NOW_SECONDS + 3600,
      ...overrides,
    })
  )

  return `${header}.${payload}.sig`
}

function httpError(status: number, data?: unknown): Error {
  return Object.assign(new Error(`${status} error`), { status, statusCode: status, data })
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const mockNavigateTo = vi.fn()
let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = []

function visit(url: string): void {
  window.history.replaceState(null, '', url)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchImpl.mockReset()
  localStorage.clear()
  sessionStorage.clear()
  discardReusableLinkFragment()
  visit('/')

  vi.stubGlobal('navigateTo', mockNavigateTo)
  // Re-stubbed here because `afterEach` below unstubs every global, the one
  // `tests/unit/setup.ts` installs included.
  vi.stubGlobal(
    'useI18n',
    vi.fn(() => ({ t: (key: string) => key }))
  )
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useHead', vi.fn())
  vi.stubGlobal(
    'useRoute',
    vi.fn(() => ({ params: {}, query: {}, hash: '', path: REUSABLE_PATH, fullPath: REUSABLE_PATH }))
  )
  // A DISTINGUISHABLE marker, so a bare navigateTo('/interview/session') that
  // drops the visitor's locale cannot pass (the same lesson as [token].vue).
  vi.stubGlobal(
    'useLocalePath',
    vi.fn(() => (path: string) => `${LOCALE_MARKER}${path}`)
  )
  vi.stubGlobal(
    'useRuntimeConfig',
    vi.fn(() => ({ public: { apiBase: 'https://api.test', interviewProviderMock: 'false' } }))
  )

  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined)
  )
})

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mountPage(): Promise<VueWrapper> {
  const { default: Page } = await import('~/app/pages/interview/reusable.vue')
  const wrapper = mount(Page, { global: { mocks: { $t: (key: string) => key } } })

  await flushPromises()

  return wrapper
}

/** Opens the link the way a visitor does: the fragment is on the URL when the page mounts. */
async function openLink(token: string = REUSABLE_LINK_TOKEN): Promise<VueWrapper> {
  visit(`${REUSABLE_PATH}#${token}`)

  return mountPage()
}

function fetchBodies(): unknown[] {
  return (mockFetchImpl.mock.calls as Array<[string, { body?: unknown }]>).map(
    ([, options]) => options.body
  )
}

function everywhereTheTokenMustNotBe(wrapper: VueWrapper): Record<string, string> {
  const storage = (area: Storage): string =>
    JSON.stringify(Object.fromEntries(Object.keys(area).map((key) => [key, area.getItem(key)])))

  return {
    'the address bar': window.location.href,
    'the history state': JSON.stringify(window.history.state),
    localStorage: storage(localStorage),
    sessionStorage: storage(sessionStorage),
    'the DOM': wrapper.html(),
    'the document': document.documentElement.outerHTML,
    'console output': JSON.stringify(
      consoleSpies.flatMap((spy) => (spy.mock.calls as unknown[][]).map((args) => String(args)))
    ),
    'a navigation target': JSON.stringify(mockNavigateTo.mock.calls),
  }
}

function expectTokenNowhere(wrapper: VueWrapper): void {
  for (const [where, haystack] of Object.entries(everywhereTheTokenMustNotBe(wrapper))) {
    expect(haystack, `the link token leaked into ${where}`).not.toContain('beai_rl_')
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('interview/reusable.vue — first visit with a fragment', () => {
  it('strips the fragment BEFORE the redemption request is issued', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState')
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })

    await openLink()

    expect(replaceState).toHaveBeenCalled()
    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
    expect(replaceState.mock.invocationCallOrder[0]).toBeLessThan(
      mockFetchImpl.mock.invocationCallOrder[0] as number
    )
  })

  it('has no fragment left in the address bar by the time the request goes out', async () => {
    let urlAtRequestTime = ''
    mockFetchImpl.mockImplementationOnce(() => {
      urlAtRequestTime = window.location.href

      return Promise.resolve({ access_token: makeCandidateJwt() })
    })

    await openLink()

    expect(urlAtRequestTime).toContain(REUSABLE_PATH)
    expect(urlAtRequestTime).not.toContain('#')
    expect(urlAtRequestTime).not.toContain('beai_rl_')
  })

  it('also works when the early plugin has already stripped the fragment', async () => {
    // The normal path in the app: the plugin captured it at start, and the page
    // takes it from module memory. The page must not need the fragment itself.
    visit(`${REUSABLE_PATH}#${REUSABLE_LINK_TOKEN}`)
    captureReusableLinkFragment(window)
    expect(window.location.hash).toBe('')
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })

    await mountPage()

    expect(fetchBodies()).toEqual([{ link_token: REUSABLE_LINK_TOKEN }])
  })

  it('makes EXACTLY ONE POST /reusable-links/redeem with the token in the JSON body', async () => {
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })

    await openLink()

    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
    const [url, options] = mockFetchImpl.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('https://api.test/reusable-links/redeem')
    expect(options['method']).toBe('POST')
    expect(options['body']).toEqual({ link_token: REUSABLE_LINK_TOKEN })
    expect(options['params']).toBeUndefined()
    expect(url).not.toContain('beai_rl_')
  })

  it("stores the returned session with entry: 'reusable' and navigates to the session route with replace", async () => {
    const accessToken = makeCandidateJwt()
    mockFetchImpl.mockResolvedValueOnce({ access_token: accessToken })

    await openLink()

    const stored = useCandidateSession().read()
    expect(stored?.accessToken).toBe(accessToken)
    expect(stored?.entry).toBe('reusable')
    expect(mockNavigateTo).toHaveBeenCalledTimes(1)
    expect(mockNavigateTo).toHaveBeenCalledWith(SESSION_ROUTE, { replace: true })
  })

  it('leaves the token nowhere after a successful redemption', async () => {
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })

    const wrapper = await openLink()

    expectTokenNowhere(wrapper)
  })

  it('is noindex, nofollow and sends no referrer', async () => {
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })

    await openLink()

    expect(useHead).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: [
          { name: 'robots', content: 'noindex, nofollow' },
          { name: 'referrer', content: 'no-referrer' },
        ],
      })
    )
  })

  it('has a localized document title (WCAG 2.4.2), in every state including busy and failed', async () => {
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })

    await openLink()

    expect(useHead).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'interview.document_title' })
    )
  })

  it('is a client-only page', async () => {
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })

    await openLink()

    expect(definePageMeta).toHaveBeenCalledWith({ ssr: false })
  })

  it('shows a determinate loading state while the request is in flight, never a blank screen', async () => {
    let settle: (value: unknown) => void = () => undefined
    mockFetchImpl.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))

    const wrapper = await openLink()

    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('interview.reusable.loading')
    expect(mockNavigateTo).not.toHaveBeenCalled()

    settle({ access_token: makeCandidateJwt() })
    await flushPromises()

    expect(mockNavigateTo).toHaveBeenCalledWith(SESSION_ROUTE, { replace: true })
  })
})

describe('interview/reusable.vue — always a NEW visitor', () => {
  it('clears a stored session BEFORE redeeming, so the previous visitor is never resumed', async () => {
    useCandidateSession().store(makeCandidateJwt({ candidate_ref: 'rlv_PREVIOUS' }), {
      entry: 'reusable',
    })
    let storedAtRequestTime: string | null = 'not read'
    mockFetchImpl.mockImplementationOnce(() => {
      storedAtRequestTime = localStorage.getItem(STORAGE_KEY)

      return Promise.resolve({ access_token: makeCandidateJwt({ candidate_ref: 'rlv_NEW' }) })
    })

    await openLink()

    expect(storedAtRequestTime).toBeNull()
    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
    expect(useCandidateSession().read()?.candidateRef).toBe('rlv_NEW')
  })

  it('clears a SINGLE-USE session too: it is somebody else', async () => {
    useCandidateSession().store(makeCandidateJwt({ candidate_ref: 'cand-001' }))
    mockFetchImpl.mockResolvedValueOnce({
      access_token: makeCandidateJwt({ candidate_ref: 'rlv_N' }),
    })

    await openLink()

    expect(useCandidateSession().read()?.candidateRef).toBe('rlv_N')
    expect(useCandidateSession().read()?.entry).toBe('reusable')
  })

  it('does not resume the previous visitor even when the redemption then fails', async () => {
    useCandidateSession().store(makeCandidateJwt({ candidate_ref: 'rlv_PREVIOUS' }), {
      entry: 'reusable',
    })
    mockFetchImpl.mockRejectedValueOnce(httpError(404))

    await openLink()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(mockNavigateTo).toHaveBeenCalledWith(LINK_INVALID_ROUTE, { replace: true })
    expect(mockNavigateTo).not.toHaveBeenCalledWith(SESSION_ROUTE, expect.anything())
  })
})

describe('interview/reusable.vue — redeem at most once per mount', () => {
  it('a re-render does not redeem again', async () => {
    mockFetchImpl.mockRejectedValue(httpError(429))

    const wrapper = await openLink()
    wrapper.vm.$forceUpdate()
    await nextTick()
    await flushPromises()
    wrapper.vm.$forceUpdate()
    await nextTick()

    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a second mount of the page (a hydration or navigation re-run) does not redeem again', async () => {
    mockFetchImpl.mockResolvedValue({ access_token: makeCandidateJwt() })

    const first = await openLink()
    first.unmount()
    mockNavigateTo.mockClear()

    // The fragment is gone and the token was taken: the second mount finds the
    // stored reusable session and resumes it instead of making a second visitor.
    await mountPage()

    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
    expect(mockNavigateTo).toHaveBeenCalledWith(SESSION_ROUTE, { replace: true })
  })
})

describe('interview/reusable.vue — reload without a fragment', () => {
  it('resumes a stored, unexpired reusable session with NO request', async () => {
    useCandidateSession().store(makeCandidateJwt(), { entry: 'reusable' })
    visit(REUSABLE_PATH)

    await mountPage()

    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(mockNavigateTo).toHaveBeenCalledTimes(1)
    expect(mockNavigateTo).toHaveBeenCalledWith(SESSION_ROUTE, { replace: true })
  })

  it('does NOT resume a single-use session: terminal link_invalid, no request', async () => {
    useCandidateSession().store(makeCandidateJwt({ candidate_ref: 'cand-001' }))
    visit(REUSABLE_PATH)

    await mountPage()

    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(mockNavigateTo).toHaveBeenCalledTimes(1)
    expect(mockNavigateTo).toHaveBeenCalledWith(LINK_INVALID_ROUTE, { replace: true })
  })

  it('does NOT resume a hosted-entry session either', async () => {
    useCandidateSession().store(makeCandidateJwt(), { interviewId: 'int_abc' })
    visit(REUSABLE_PATH)

    await mountPage()

    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(mockNavigateTo).toHaveBeenCalledWith(LINK_INVALID_ROUTE, { replace: true })
  })

  it('no fragment and no session: terminal link_invalid, no request', async () => {
    visit(REUSABLE_PATH)

    await mountPage()

    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(mockNavigateTo).toHaveBeenCalledWith(LINK_INVALID_ROUTE, { replace: true })
  })

  it('an EXPIRED reusable session is purged and is terminal link_invalid, no request', async () => {
    useCandidateSession().store(makeCandidateJwt({ exp: NOW_SECONDS - 1 }), { entry: 'reusable' })
    visit(REUSABLE_PATH)

    await mountPage()

    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(mockNavigateTo).toHaveBeenCalledWith(LINK_INVALID_ROUTE, { replace: true })
  })
})

describe('interview/reusable.vue — a fragment that is not a link token', () => {
  it.each([
    ['too short', 'beai_rl_short'],
    ['too long', `beai_rl_${'a'.repeat(60)}`],
    ['the marker alone', 'beai_rl_'],
    ['carrying a `+`', `beai_rl_${'a'.repeat(42)}+`],
  ])(
    '%s: terminal link_invalid with NO request, and the fragment is stripped',
    async (_n, hash) => {
      visit(`${REUSABLE_PATH}#${hash}`)

      await mountPage()

      expect(mockFetchImpl).not.toHaveBeenCalled()
      expect(window.location.hash).toBe('')
      expect(mockNavigateTo).toHaveBeenCalledWith(LINK_INVALID_ROUTE, { replace: true })
    }
  )

  it('still clears a stored session: somebody opened a link, so it is not the previous visitor', async () => {
    useCandidateSession().store(makeCandidateJwt(), { entry: 'reusable' })
    visit(`${REUSABLE_PATH}#beai_rl_short`)

    await mountPage()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(mockNavigateTo).not.toHaveBeenCalledWith(SESSION_ROUTE, expect.anything())
  })

  it('ignores a fragment that is not a link at all and treats the load as a reload', async () => {
    useCandidateSession().store(makeCandidateJwt(), { entry: 'reusable' })
    visit(`${REUSABLE_PATH}#some-anchor`)

    await mountPage()

    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#some-anchor')
    expect(mockNavigateTo).toHaveBeenCalledWith(SESSION_ROUTE, { replace: true })
  })
})

describe('interview/reusable.vue — 404 and 403', () => {
  it('404 -> terminal link_invalid, replace, no session stored, and no retry control', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(404, { message: 'Not found.' }))

    const wrapper = await openLink()

    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
    expect(mockNavigateTo).toHaveBeenCalledTimes(1)
    expect(mockNavigateTo).toHaveBeenCalledWith(LINK_INVALID_ROUTE, { replace: true })
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(wrapper.find('[data-testid="reusable-retry"]').exists()).toBe(false)
    expectTokenNowhere(wrapper)
  })

  it('403 with an https redirect_url -> navigates there (external, replace), like the single-use route', async () => {
    mockFetchImpl.mockRejectedValueOnce(
      httpError(403, { message: 'Access denied.', redirect_url: 'https://client.example/closed' })
    )

    await openLink()

    expect(mockNavigateTo).toHaveBeenCalledTimes(1)
    expect(mockNavigateTo).toHaveBeenCalledWith('https://client.example/closed', {
      external: true,
      replace: true,
    })
  })

  it('403 with redirect_url null -> the generic terminal 403, no gate detail', async () => {
    mockFetchImpl.mockRejectedValueOnce(
      httpError(403, { message: 'Access denied.', redirect_url: null })
    )

    await openLink()

    expect(mockNavigateTo).toHaveBeenCalledTimes(1)
    expect(mockNavigateTo).toHaveBeenCalledWith(FORBIDDEN_ROUTE, { replace: true })
  })

  it.each([
    ['a javascript: url', 'javascript:alert(1)'],
    ['a relative url', '/somewhere'],
    ['an http url', 'http://client.example/closed'],
  ])('403 with %s -> never navigated to, the generic terminal 403 instead', async (_n, url) => {
    mockFetchImpl.mockRejectedValueOnce(
      httpError(403, { message: 'Access denied.', redirect_url: url })
    )

    await openLink()

    expect(mockNavigateTo).toHaveBeenCalledTimes(1)
    expect(mockNavigateTo).toHaveBeenCalledWith(FORBIDDEN_ROUTE, { replace: true })
  })

  it('a 403 offers no retry either: the answer will not change by asking again', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(403, { redirect_url: null }))

    const wrapper = await openLink()

    expect(wrapper.find('[data-testid="reusable-retry"]').exists()).toBe(false)
  })
})

describe('interview/reusable.vue — 429, network failure and 5xx are retryable', () => {
  it('429 -> the busy state with a Retry control, and NOT link_invalid', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(429, { message: 'Too many attempts.' }))

    const wrapper = await openLink()

    expect(wrapper.text()).toContain('interview.reusable.busy.title')
    expect(wrapper.text()).toContain('interview.reusable.busy.body')
    expect(wrapper.get('[data-testid="reusable-retry"]').text()).toContain(
      'interview.reusable.retry'
    )
    expect(mockNavigateTo).not.toHaveBeenCalled()
  })

  it.each([
    ['502', httpError(502)],
    ['500', httpError(500)],
    ['a dropped connection', new TypeError('Failed to fetch')],
  ])(
    '%s -> the generic failed state with a Retry control, and NOT link_invalid',
    async (_n, error) => {
      mockFetchImpl.mockRejectedValueOnce(error)

      const wrapper = await openLink()

      expect(wrapper.text()).toContain('interview.reusable.failed.title')
      expect(wrapper.text()).toContain('interview.reusable.failed.body')
      expect(wrapper.text()).not.toContain('interview.reusable.busy.title')
      expect(wrapper.get('[data-testid="reusable-retry"]').exists()).toBe(true)
      expect(mockNavigateTo).not.toHaveBeenCalled()
    }
  )

  it('Retry re-posts the SAME token, and a success then lands on the session route', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(429))
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })

    const wrapper = await openLink()
    await wrapper.get('[data-testid="reusable-retry"]').trigger('click')
    await flushPromises()

    expect(fetchBodies()).toEqual([
      { link_token: REUSABLE_LINK_TOKEN },
      { link_token: REUSABLE_LINK_TOKEN },
    ])
    expect(useCandidateSession().read()?.entry).toBe('reusable')
    expect(mockNavigateTo).toHaveBeenCalledTimes(1)
    expect(mockNavigateTo).toHaveBeenCalledWith(SESSION_ROUTE, { replace: true })
  })

  it('Retry never writes the token to the URL, history, storage or the console', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState')
    const pushState = vi.spyOn(window.history, 'pushState')
    mockFetchImpl.mockRejectedValueOnce(httpError(429))
    mockFetchImpl.mockRejectedValueOnce(httpError(502))

    const wrapper = await openLink()
    const stripCalls = replaceState.mock.calls.length
    await wrapper.get('[data-testid="reusable-retry"]').trigger('click')
    await flushPromises()

    // Still on the failed state after the second failure, and still clean.
    expect(wrapper.get('[data-testid="reusable-retry"]').exists()).toBe(true)
    expect(replaceState.mock.calls.length).toBe(stripCalls)
    expect(pushState).not.toHaveBeenCalled()
    expectTokenNowhere(wrapper)
  })

  it('leaves the token nowhere while it waits in the busy and the failed states', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(429))

    const busy = await openLink()
    expectTokenNowhere(busy)
    busy.unmount()

    mockFetchImpl.mockRejectedValueOnce(httpError(500))
    discardReusableLinkFragment()
    const failed = await openLink()
    expectTokenNowhere(failed)
  })

  it('busy -> Retry -> 404 ends on terminal link_invalid, with no further retry', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(429))
    mockFetchImpl.mockRejectedValueOnce(httpError(404))

    const wrapper = await openLink()
    await wrapper.get('[data-testid="reusable-retry"]').trigger('click')
    await flushPromises()

    expect(mockNavigateTo).toHaveBeenCalledTimes(1)
    expect(mockNavigateTo).toHaveBeenCalledWith(LINK_INVALID_ROUTE, { replace: true })
    expect(mockFetchImpl).toHaveBeenCalledTimes(2)
  })

  it('busy -> Retry -> 403 follows the 403 handling', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(429))
    mockFetchImpl.mockRejectedValueOnce(httpError(403, { redirect_url: null }))

    const wrapper = await openLink()
    await wrapper.get('[data-testid="reusable-retry"]').trigger('click')
    await flushPromises()

    expect(mockNavigateTo).toHaveBeenCalledWith(FORBIDDEN_ROUTE, { replace: true })
  })

  it('a double click on Retry sends ONE more request, not two', async () => {
    let settle: (value: unknown) => void = () => undefined
    mockFetchImpl.mockRejectedValueOnce(httpError(429))
    mockFetchImpl.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))

    const wrapper = await openLink()
    const retry = wrapper.get('[data-testid="reusable-retry"]')
    await retry.trigger('click')
    await retry.trigger('click')

    expect(mockFetchImpl).toHaveBeenCalledTimes(2)

    settle({ access_token: makeCandidateJwt() })
    await flushPromises()

    expect(mockFetchImpl).toHaveBeenCalledTimes(2)
  })

  it('a reload after a busy state has no token any more: it ends on terminal link_invalid', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(429))
    const first = await openLink()
    first.unmount()
    mockNavigateTo.mockClear()

    // What a browser reload does: a fresh page, an address bar with no fragment.
    discardReusableLinkFragment()
    visit(REUSABLE_PATH)
    await mountPage()

    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
    expect(mockNavigateTo).toHaveBeenCalledWith(LINK_INVALID_ROUTE, { replace: true })
  })
})

describe('interview/reusable.vue — a malformed 200', () => {
  it('a 200 whose token cannot be stored is a retryable failure, not a trip to a dead session route', async () => {
    // `store()` refuses a token it cannot decode and writes nothing. Navigating
    // on would land the visitor on the session route's guard with no session.
    mockFetchImpl.mockResolvedValueOnce({ access_token: 'not-a-jwt' })

    const wrapper = await openLink()

    expect(mockNavigateTo).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('interview.reusable.failed.title')
    expect(wrapper.find('[data-testid="reusable-retry"]').exists()).toBe(true)
  })
})
