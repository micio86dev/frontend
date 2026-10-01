/**
 * app/pages/interview/reusable.vue — the reusable entry route
 * (reusable-interview-links AD-16; reusable-link-visitor-identity VD-12; spec
 * "Reusable Entry Route", "Reusable Reload During The Form Shows A Reopen State",
 * "Visitor Identity Is Not Retained After Redemption")
 *
 * `/interview/reusable#beai_rl_<43>` shows an identity form (name and email) and
 * redeems the link once per SUBMIT. The token in the fragment is a live,
 * NON-EXPIRING credential and the typed name and email are personal data, so most
 * of what this file pins is where they must not end up:
 *
 *  - the fragment is stripped from the address bar BEFORE anything else, and NO
 *    request is made before the visitor submits a valid form;
 *  - exactly one `POST /reusable-links/redeem` per submit, with a body of exactly
 *    `{link_token, display_name, email}`; the token is held in a plain variable and
 *    in no URL, storage, history, router state, DOM or log;
 *  - every visit with a fragment is a NEW visitor: a stored session is cleared
 *    first, never resumed (a kiosk is not the previous person);
 *  - a reload while the form is shown loses the in-memory token, so a non-secret
 *    flag turns it into the truthful "open the link again" terminal, never the
 *    untrue `link_invalid`;
 *  - 404 is `link_invalid`; 403 is the single-use route's handling; 409 and 422 stay
 *    on the form with the app's own copy; 429, a 5xx and a dropped connection are
 *    RETRYABLE and Retry re-posts the SAME token AND identity.
 *
 * The page LEAVES through `router.replace`, not `navigateTo`. Nuxt's `navigateTo`
 * inside an in-flight router navigation (a pasted fragment fires popstate before
 * hashchange) returns a route object for the middleware instead of navigating, and
 * a caller that ignores the return value strands the visitor on the page. The
 * "router navigation in flight" tests reproduce that with a double that behaves the
 * way Nuxt's does.
 *
 * Page-level, with the network, router and storage faked at their boundaries. The
 * browser gate (a phone must not redeem) is a router middleware; its contract is
 * pinned in `browser-gate.spec.ts` and exercised end to end by the Playwright spec.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { IDENTITY_PENDING_KEY } from '~/app/utils/reusable-identity-pending'
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
const LINK_REOPEN_ROUTE = `${LOCALE_MARKER}/interview/terminal?reason=link_reopen`
const FORBIDDEN_ROUTE = `${LOCALE_MARKER}/interview/terminal?reason=403`
const REUSABLE_PATH = '/interview/reusable'

/** Sentinels no other string here contains, so a leak is a substring match. */
const NAME = 'Ada Sentinel Lovelace'
const EMAIL = 'ada.sentinel@example.test'
const REDEEM_BODY = { link_token: REUSABLE_LINK_TOKEN, display_name: NAME, email: EMAIL }

const NAME_FIELD = '#reusable-identity-name'
const EMAIL_FIELD = '#reusable-identity-email'
const FORM = '[data-testid="reusable-identity-form"]'
const RETRY = '[data-testid="reusable-retry"]'
const LOADING = '[data-testid="reusable-loading"]'

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
  return Object.assign(new Error(`${status} error`), {
    status,
    statusCode: status,
    data,
    // ofetch keeps the request it sent on the error it throws: token and identity.
    options: { method: 'POST', body: REDEEM_BODY },
  })
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface Navigation {
  to: string
  via: 'router' | 'navigateTo'
  external: boolean
}

const navigations: Navigation[] = []
/** What a visitor ended up on: every internal and external navigation target, in order. */
const targets = (): string[] => navigations.map((n) => n.to)

/**
 * True while a router navigation is mid-flight, as when a pasted fragment fires
 * popstate before hashchange. Nuxt runs route middleware for that navigation and
 * sets `_processingMiddleware`.
 */
let routerNavigationInFlight = false

/**
 * Behaves like Nuxt's `navigateTo` (nuxt/dist/app/composables/router.js): an
 * external target always goes through; an internal one issued while a router
 * navigation is in flight is NOT performed, the call returns a route object for the
 * middleware to act on, and a caller that ignores the return value navigates nowhere.
 */
const navigateToDouble = vi.fn(
  (to: string, options?: { external?: boolean; replace?: boolean }) => {
    if (options?.external !== true && routerNavigationInFlight) {
      return { path: to, replace: options?.replace === true }
    }
    navigations.push({ to, via: 'navigateTo', external: options?.external === true })

    return Promise.resolve()
  }
)

/** `useRouter().replace`: vue-router supersedes a pending navigation with this one. */
const routerReplace = vi.fn((to: string) => {
  navigations.push({ to, via: 'router', external: false })

  return Promise.resolve(undefined)
})

let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = []
const mounted: VueWrapper[] = []

// The page pulls in the shell, the form and the UI primitives; transforming them on a
// cold cache can outlast a single test's timeout, so pay that once, up front.
beforeAll(async () => {
  await import('~/app/pages/interview/reusable.vue')
}, 60_000)

function visit(url: string): void {
  window.history.replaceState(null, '', url)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchImpl.mockReset()
  navigations.length = 0
  routerNavigationInFlight = false
  localStorage.clear()
  sessionStorage.clear()
  discardReusableLinkFragment()
  visit('/')

  vi.stubGlobal('navigateTo', navigateToDouble)
  vi.stubGlobal(
    'useRouter',
    vi.fn(() => ({ replace: routerReplace }))
  )
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
  // A DISTINGUISHABLE marker, so a bare navigation to '/interview/session' that
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
  while (mounted.length > 0) mounted.pop()?.unmount()
  for (const spy of consoleSpies) spy.mockRestore()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mountPage(): Promise<VueWrapper> {
  const { default: Page } = await import('~/app/pages/interview/reusable.vue')
  const wrapper = mount(Page, {
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key } },
  })
  mounted.push(wrapper)

  await flushPromises()

  return wrapper
}

/** Opens the link the way a visitor does: the fragment is on the URL when the page mounts. */
async function openLink(token: string = REUSABLE_LINK_TOKEN): Promise<VueWrapper> {
  visit(`${REUSABLE_PATH}#${token}`)

  return mountPage()
}

/** Types into the form and submits it, the way a visitor does. */
async function submitIdentity(
  wrapper: VueWrapper,
  identity: { name?: string; email?: string } = {}
): Promise<void> {
  await wrapper.get(NAME_FIELD).setValue(identity.name ?? NAME)
  await wrapper.get(EMAIL_FIELD).setValue(identity.email ?? EMAIL)
  await wrapper.get(FORM).trigger('submit')
  await flushPromises()
}

function fetchBodies(): unknown[] {
  return (mockFetchImpl.mock.calls as Array<[string, { body?: unknown }]>).map(
    ([, options]) => options.body
  )
}

function errorText(wrapper: VueWrapper, field: 'name' | 'email'): string | undefined {
  const error = wrapper.find(`#reusable-identity-${field}-error`)

  return error.exists() ? error.text() : undefined
}

function everywhereTheSecretsMustNotBe(wrapper: VueWrapper): Record<string, string> {
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
    'a navigation target': JSON.stringify(navigations),
  }
}

function expectNoSecretIn(wrapper: VueWrapper, secrets: string[]): void {
  for (const [where, haystack] of Object.entries(everywhereTheSecretsMustNotBe(wrapper))) {
    for (const secret of secrets) {
      expect(haystack, `${secret} leaked into ${where}`).not.toContain(secret)
    }
  }
}

/** The link token only (while the form is shown the typed values are legitimately in the inputs). */
function expectTokenNowhere(wrapper: VueWrapper): void {
  expectNoSecretIn(wrapper, ['beai_rl_'])
}

/** The token AND the identity (after the redemption, a terminal outcome or a navigation away). */
function expectNothingRetained(wrapper: VueWrapper): void {
  expectNoSecretIn(wrapper, ['beai_rl_', NAME, EMAIL])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('interview/reusable.vue — a well-formed fragment shows the form and makes no request', () => {
  it('shows the identity form, makes NO network request and does not navigate', async () => {
    const wrapper = await openLink()

    expect(wrapper.find(FORM).exists()).toBe(true)
    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(navigations).toEqual([])
    expect(wrapper.text()).toContain('interview.reusable.identity.title')
    expect(wrapper.text()).toContain('interview.reusable.identity.intro')
  })

  it('strips the fragment from the address bar before the form is shown', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState')

    const wrapper = await openLink()

    expect(replaceState).toHaveBeenCalled()
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain('beai_rl_')
    expect(wrapper.find(FORM).exists()).toBe(true)
  })

  it('also works when the early plugin has already stripped the fragment', async () => {
    // The normal path in the app: the plugin captured it at start, and the page
    // takes it from module memory. The page must not need the fragment itself.
    visit(`${REUSABLE_PATH}#${REUSABLE_LINK_TOKEN}`)
    captureReusableLinkFragment(window)
    expect(window.location.hash).toBe('')

    const wrapper = await mountPage()

    expect(wrapper.find(FORM).exists()).toBe(true)
    expect(mockFetchImpl).not.toHaveBeenCalled()
  })

  it('clears a stored session BEFORE showing the form: a kiosk is not the previous visitor', async () => {
    useCandidateSession().store(makeCandidateJwt({ candidate_ref: 'rlv_PREVIOUS' }), {
      entry: 'reusable',
    })

    const wrapper = await openLink()

    expect(wrapper.find(FORM).exists()).toBe(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(navigations).toEqual([])
  })

  it('clears a SINGLE-USE session too: it is somebody else', async () => {
    useCandidateSession().store(makeCandidateJwt({ candidate_ref: 'cand-001' }))

    await openLink()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it("sets the non-secret 'identity form shown' flag, and nothing else, in sessionStorage", async () => {
    await openLink()

    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toBe('1')
    expect(sessionStorage.length).toBe(1)
    expect(localStorage.length).toBe(0)
  })

  it('leaves the token nowhere while the form is shown', async () => {
    const wrapper = await openLink()

    expectTokenNowhere(wrapper)
  })

  it('holds the token only in memory: not in the router, the DOM or the form props', async () => {
    const wrapper = await openLink()

    expect(wrapper.html()).not.toContain('beai_rl_')
    expect(JSON.stringify(vi.mocked(useRoute)())).not.toContain('beai_rl_')
  })

  it('is noindex, nofollow and sends no referrer', async () => {
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

  it('has a localized document title (WCAG 2.4.2)', async () => {
    await openLink()

    expect(useHead).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'interview.document_title' })
    )
  })

  it('is a client-only page', async () => {
    await openLink()

    expect(definePageMeta).toHaveBeenCalledWith({ ssr: false })
  })

  it('labels its landmark with the form heading', async () => {
    const wrapper = await openLink()

    expect(wrapper.get('h1').text()).toBe('interview.reusable.identity.title')
    expect(wrapper.get('main').attributes('aria-labelledby')).toBe(
      wrapper.get('h1').attributes('id')
    )
  })
})

describe('interview/reusable.vue — a submit redeems once, with the identity in the body only', () => {
  it('makes EXACTLY ONE POST with a body of exactly {link_token, display_name, email}, trimmed', async () => {
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })
    const wrapper = await openLink()

    await submitIdentity(wrapper, { name: `  ${NAME}  `, email: `  ${EMAIL} ` })

    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
    const [url, options] = mockFetchImpl.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('https://api.test/reusable-links/redeem')
    expect(options['method']).toBe('POST')
    expect(options['body']).toEqual(REDEEM_BODY)
    expect(options['params']).toBeUndefined()
    expect(url).not.toContain('beai_rl_')
    expect(url).not.toContain(EMAIL)
  })

  it('sends nothing when the form is invalid, and reports both fields', async () => {
    const wrapper = await openLink()

    await wrapper.get(FORM).trigger('submit')
    await flushPromises()

    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(errorText(wrapper, 'name')).toBe('interview.reusable.identity.errors.nameRequired')
    expect(errorText(wrapper, 'email')).toBe('interview.reusable.identity.errors.emailRequired')
  })

  it("stores the returned session with entry: 'reusable' and leaves for the session route", async () => {
    const accessToken = makeCandidateJwt()
    mockFetchImpl.mockResolvedValueOnce({ access_token: accessToken })
    const wrapper = await openLink()

    await submitIdentity(wrapper)

    const stored = useCandidateSession().read()
    expect(stored?.accessToken).toBe(accessToken)
    expect(stored?.entry).toBe('reusable')
    expect(targets()).toEqual([SESSION_ROUTE])
  })

  it('removes the flag once the redemption succeeded', async () => {
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })
    const wrapper = await openLink()

    await submitIdentity(wrapper)

    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toBeNull()
  })

  it('leaves neither the token nor the identity anywhere after a successful redemption', async () => {
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })
    const wrapper = await openLink()

    await submitIdentity(wrapper)

    // The stored session is the access token only; the visitor's identity is not part of it.
    expectNothingRetained(wrapper)
  })

  it('shows the form as busy (disabled and aria-busy) while the request is in flight, not a blank screen', async () => {
    let settle: (value: unknown) => void = () => undefined
    mockFetchImpl.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))
    const wrapper = await openLink()

    await submitIdentity(wrapper)

    const submit = wrapper.get('[data-testid="reusable-identity-submit"]')
    expect(submit.attributes('disabled')).toBeDefined()
    expect(wrapper.get(FORM).attributes('aria-busy')).toBe('true')
    expect(targets()).toEqual([])

    settle({ access_token: makeCandidateJwt() })
    await flushPromises()

    expect(targets()).toEqual([SESSION_ROUTE])
  })

  it('a 200 whose token cannot be stored is a retryable failure, not a trip to a dead session route', async () => {
    // `store()` refuses a token it cannot decode and writes nothing. Navigating on
    // would land the visitor on the session route's guard with no session.
    mockFetchImpl.mockResolvedValueOnce({ access_token: 'not-a-jwt' })
    const wrapper = await openLink()

    await submitIdentity(wrapper)

    expect(targets()).toEqual([])
    expect(wrapper.text()).toContain('interview.reusable.failed.title')
    expect(wrapper.find(RETRY).exists()).toBe(true)
  })
})

describe('interview/reusable.vue — one submit is one request', () => {
  it('two clicks on Submit while the request is in flight send ONE request', async () => {
    let settle: (value: unknown) => void = () => undefined
    mockFetchImpl.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))
    const wrapper = await openLink()
    await wrapper.get(NAME_FIELD).setValue(NAME)
    await wrapper.get(EMAIL_FIELD).setValue(EMAIL)

    await wrapper.get(FORM).trigger('submit')
    await wrapper.get(FORM).trigger('submit')
    await wrapper.get('[data-testid="reusable-identity-submit"]').trigger('click')
    await flushPromises()

    expect(mockFetchImpl).toHaveBeenCalledTimes(1)

    settle({ access_token: makeCandidateJwt() })
    await flushPromises()

    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a re-render does not redeem again, and a second mount does not either', async () => {
    mockFetchImpl.mockResolvedValue({ access_token: makeCandidateJwt() })
    const first = await openLink()
    await submitIdentity(first)
    first.vm.$forceUpdate()
    await nextTick()
    first.unmount()
    navigations.length = 0

    // The fragment is gone and the token was taken: the second mount finds the
    // stored reusable session and resumes it instead of making a second visitor.
    await mountPage()

    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
    expect(targets()).toEqual([SESSION_ROUTE])
  })
})

describe('interview/reusable.vue — 409: the form stays, the token is kept', () => {
  async function duplicate(): Promise<VueWrapper> {
    mockFetchImpl.mockRejectedValueOnce(httpError(409, { message: 'duplicate_enrolment' }))
    const wrapper = await openLink()
    await submitIdentity(wrapper)

    return wrapper
  }

  it('shows the duplicate message on the EMAIL field, focuses it, and stays on the form', async () => {
    const wrapper = await duplicate()

    expect(wrapper.find(FORM).exists()).toBe(true)
    expect(errorText(wrapper, 'email')).toBe('interview.reusable.identity.errors.emailTaken')
    expect(errorText(wrapper, 'name')).toBeUndefined()
    expect(document.activeElement).toBe(wrapper.get(EMAIL_FIELD).element)
    expect(targets()).toEqual([])
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('keeps what was typed, so nothing is retyped', async () => {
    const wrapper = await duplicate()

    expect((wrapper.get(NAME_FIELD).element as HTMLInputElement).value).toBe(NAME)
    expect((wrapper.get(EMAIL_FIELD).element as HTMLInputElement).value).toBe(EMAIL)
  })

  it('a corrected email resubmits with the SAME token, and a success then leaves', async () => {
    const wrapper = await duplicate()
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })

    await submitIdentity(wrapper, { email: 'ada.other@example.test' })

    expect(fetchBodies()).toEqual([
      REDEEM_BODY,
      { link_token: REUSABLE_LINK_TOKEN, display_name: NAME, email: 'ada.other@example.test' },
    ])
    expect(targets()).toEqual([SESSION_ROUTE])
  })

  it('a second 409 shows the message again', async () => {
    const wrapper = await duplicate()
    mockFetchImpl.mockRejectedValueOnce(httpError(409, { message: 'duplicate_enrolment' }))

    await submitIdentity(wrapper, { email: 'ada.again@example.test' })

    expect(errorText(wrapper, 'email')).toBe('interview.reusable.identity.errors.emailTaken')
    expect(mockFetchImpl).toHaveBeenCalledTimes(2)
  })

  it('leaves neither the token nor the server text anywhere', async () => {
    const wrapper = await duplicate()

    expectTokenNowhere(wrapper)
  })
})

describe('interview/reusable.vue — 422: mapped onto the fields with the app’s own copy', () => {
  it.each([
    ['display_name', { display_name: ['SERVER-TEXT'] }, 'name', 'nameInvalid'],
    ['email', { email: ['SERVER-TEXT'] }, 'email', 'emailInvalid'],
  ] as const)(
    'a 422 naming %s shows the localized message on that field, never the server text',
    async (_label, errors, field, key) => {
      mockFetchImpl.mockRejectedValueOnce(httpError(422, { message: 'SERVER-TEXT', errors }))
      const wrapper = await openLink()

      await submitIdentity(wrapper)

      expect(wrapper.find(FORM).exists()).toBe(true)
      expect(errorText(wrapper, field)).toBe(`interview.reusable.identity.errors.${key}`)
      expect(wrapper.html()).not.toContain('SERVER-TEXT')
      expect(targets()).toEqual([])
    }
  )

  it('a 422 naming both fields shows both and focuses the name', async () => {
    mockFetchImpl.mockRejectedValueOnce(
      httpError(422, { errors: { display_name: ['x'], email: ['y'] } })
    )
    const wrapper = await openLink()

    await submitIdentity(wrapper)

    expect(errorText(wrapper, 'name')).toBe('interview.reusable.identity.errors.nameInvalid')
    expect(errorText(wrapper, 'email')).toBe('interview.reusable.identity.errors.emailInvalid')
    expect(document.activeElement).toBe(wrapper.get(NAME_FIELD).element)
    expect((wrapper.get(NAME_FIELD).element as HTMLInputElement).value).toBe(NAME)
  })

  it('a 422 that names no known field is the retryable failed state, never a silent no-op', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(422, { errors: { link_token: ['x'] } }))
    const wrapper = await openLink()

    await submitIdentity(wrapper)

    expect(wrapper.text()).toContain('interview.reusable.failed.title')
    expect(wrapper.find(RETRY).exists()).toBe(true)
  })

  it('editing the refused field clears its error', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(422, { errors: { email: ['x'] } }))
    const wrapper = await openLink()
    await submitIdentity(wrapper)

    await wrapper.get(EMAIL_FIELD).setValue('ada.fixed@example.test')

    expect(errorText(wrapper, 'email')).toBeUndefined()
  })
})

describe('interview/reusable.vue — 404 and 403', () => {
  it('404 -> terminal link_invalid, no session, no retry, the flag cleared and nothing retained', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(404, { message: 'Not found.' }))
    const wrapper = await openLink()

    await submitIdentity(wrapper)

    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
    expect(targets()).toEqual([LINK_INVALID_ROUTE])
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toBeNull()
    expect(wrapper.find(RETRY).exists()).toBe(false)
    expectNothingRetained(wrapper)
  })

  it('403 with an https redirect_url -> navigates there (external, replace), like the single-use route', async () => {
    mockFetchImpl.mockRejectedValueOnce(
      httpError(403, { message: 'Access denied.', redirect_url: 'https://client.example/closed' })
    )
    const wrapper = await openLink()

    await submitIdentity(wrapper)

    expect(navigateToDouble).toHaveBeenCalledWith('https://client.example/closed', {
      external: true,
      replace: true,
    })
    expect(targets()).toEqual(['https://client.example/closed'])
    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toBeNull()
  })

  it('403 with redirect_url null -> the generic terminal 403, no gate detail, the flag cleared', async () => {
    mockFetchImpl.mockRejectedValueOnce(
      httpError(403, { message: 'Access denied.', redirect_url: null })
    )
    const wrapper = await openLink()

    await submitIdentity(wrapper)

    expect(targets()).toEqual([FORBIDDEN_ROUTE])
    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toBeNull()
  })

  it.each([
    ['a javascript: url', 'javascript:alert(1)'],
    ['a relative url', '/somewhere'],
    ['an http url', 'http://client.example/closed'],
  ])('403 with %s -> never navigated to, the generic terminal 403 instead', async (_n, url) => {
    mockFetchImpl.mockRejectedValueOnce(
      httpError(403, { message: 'Access denied.', redirect_url: url })
    )
    const wrapper = await openLink()

    await submitIdentity(wrapper)

    expect(targets()).toEqual([FORBIDDEN_ROUTE])
  })

  it('a 403 offers no retry either: the answer will not change by asking again', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(403, { redirect_url: null }))
    const wrapper = await openLink()

    await submitIdentity(wrapper)

    expect(wrapper.find(RETRY).exists()).toBe(false)
  })
})

describe('interview/reusable.vue — 429, network failure and 5xx are retryable and keep the identity', () => {
  it('429 -> the busy state with a Retry control, and NOT link_invalid', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(429, { message: 'Too many attempts.' }))
    const wrapper = await openLink()

    await submitIdentity(wrapper)

    expect(wrapper.find(FORM).exists()).toBe(false)
    expect(wrapper.text()).toContain('interview.reusable.busy.title')
    expect(wrapper.text()).toContain('interview.reusable.busy.body')
    expect(wrapper.get(RETRY).text()).toContain('interview.reusable.retry')
    expect(targets()).toEqual([])
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

      await submitIdentity(wrapper)

      expect(wrapper.text()).toContain('interview.reusable.failed.title')
      expect(wrapper.text()).toContain('interview.reusable.failed.body')
      expect(wrapper.text()).not.toContain('interview.reusable.busy.title')
      expect(wrapper.get(RETRY).exists()).toBe(true)
      expect(targets()).toEqual([])
    }
  )

  it('Retry re-posts the SAME token AND the SAME identity, and a success then leaves', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(429))
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })
    const wrapper = await openLink()
    await submitIdentity(wrapper)

    await wrapper.get(RETRY).trigger('click')
    await flushPromises()

    expect(fetchBodies()).toEqual([REDEEM_BODY, REDEEM_BODY])
    expect(useCandidateSession().read()?.entry).toBe('reusable')
    expect(targets()).toEqual([SESSION_ROUTE])
  })

  it('Retry never writes the token or the identity to the URL, history, storage or console', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState')
    const pushState = vi.spyOn(window.history, 'pushState')
    mockFetchImpl.mockRejectedValueOnce(httpError(429))
    mockFetchImpl.mockRejectedValueOnce(httpError(502))
    const wrapper = await openLink()
    await submitIdentity(wrapper)
    const stripCalls = replaceState.mock.calls.length

    await wrapper.get(RETRY).trigger('click')
    await flushPromises()

    // Still on the failed state after the second failure, and still clean.
    expect(wrapper.get(RETRY).exists()).toBe(true)
    expect(replaceState.mock.calls.length).toBe(stripCalls)
    expect(pushState).not.toHaveBeenCalled()
    expectNothingRetained(wrapper)
  })

  it('busy -> Retry -> 404 ends on terminal link_invalid, with no further retry', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(429))
    mockFetchImpl.mockRejectedValueOnce(httpError(404))
    const wrapper = await openLink()
    await submitIdentity(wrapper)

    await wrapper.get(RETRY).trigger('click')
    await flushPromises()

    expect(targets()).toEqual([LINK_INVALID_ROUTE])
    expect(mockFetchImpl).toHaveBeenCalledTimes(2)
  })

  it('busy -> Retry -> 403 follows the 403 handling', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(429))
    mockFetchImpl.mockRejectedValueOnce(httpError(403, { redirect_url: null }))
    const wrapper = await openLink()
    await submitIdentity(wrapper)

    await wrapper.get(RETRY).trigger('click')
    await flushPromises()

    expect(targets()).toEqual([FORBIDDEN_ROUTE])
  })

  it('failed -> Retry -> 409 returns to the form, prefilled, with the duplicate message', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(502))
    mockFetchImpl.mockRejectedValueOnce(httpError(409, { message: 'duplicate_enrolment' }))
    const wrapper = await openLink()
    await submitIdentity(wrapper)

    await wrapper.get(RETRY).trigger('click')
    await flushPromises()

    expect(wrapper.find(FORM).exists()).toBe(true)
    expect(errorText(wrapper, 'email')).toBe('interview.reusable.identity.errors.emailTaken')
    // The form was re-mounted, so the held identity prefills it: nothing is retyped.
    expect((wrapper.get(NAME_FIELD).element as HTMLInputElement).value).toBe(NAME)
    expect((wrapper.get(EMAIL_FIELD).element as HTMLInputElement).value).toBe(EMAIL)
  })

  it('a double click on Retry sends ONE more request, not two', async () => {
    let settle: (value: unknown) => void = () => undefined
    mockFetchImpl.mockRejectedValueOnce(httpError(429))
    mockFetchImpl.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))
    const wrapper = await openLink()
    await submitIdentity(wrapper)

    const retry = wrapper.get(RETRY)
    await retry.trigger('click')
    await retry.trigger('click')

    expect(mockFetchImpl).toHaveBeenCalledTimes(2)

    settle({ access_token: makeCandidateJwt() })
    await flushPromises()

    expect(mockFetchImpl).toHaveBeenCalledTimes(2)
  })

  it('shows a determinate loading state while a Retry is in flight', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(429))
    mockFetchImpl.mockReturnValueOnce(new Promise(() => undefined))
    const wrapper = await openLink()
    await submitIdentity(wrapper)

    await wrapper.get(RETRY).trigger('click')

    expect(wrapper.find(LOADING).exists()).toBe(true)
    expect(wrapper.text()).toContain('interview.reusable.loading')
  })

  it('a reload after a busy state has no token any more: the flag turns it into the reopen terminal', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(429))
    const first = await openLink()
    await submitIdentity(first)
    navigations.length = 0

    // What a browser reload does: a fresh page (module state gone), an address bar with no fragment.
    // The first page is NOT unmounted: a reload does not run its unmount hook.
    discardReusableLinkFragment()
    visit(REUSABLE_PATH)
    await mountPage()

    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
    expect(targets()).toEqual([LINK_REOPEN_ROUTE])
  })
})

describe('interview/reusable.vue — reload without a fragment', () => {
  it('resumes a stored, unexpired reusable session with NO request, and removes a stale flag', async () => {
    useCandidateSession().store(makeCandidateJwt(), { entry: 'reusable' })
    sessionStorage.setItem(IDENTITY_PENDING_KEY, '1')
    visit(REUSABLE_PATH)

    await mountPage()

    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(targets()).toEqual([SESSION_ROUTE])
    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toBeNull()
  })

  it('does NOT resume a single-use session: terminal link_invalid, no request', async () => {
    useCandidateSession().store(makeCandidateJwt({ candidate_ref: 'cand-001' }))
    visit(REUSABLE_PATH)

    await mountPage()

    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(targets()).toEqual([LINK_INVALID_ROUTE])
  })

  it('does NOT resume a hosted-entry session either', async () => {
    useCandidateSession().store(makeCandidateJwt(), { interviewId: 'int_abc' })
    visit(REUSABLE_PATH)

    await mountPage()

    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(targets()).toEqual([LINK_INVALID_ROUTE])
  })

  it('no fragment, no session and no flag: terminal link_invalid, never the reopen copy', async () => {
    visit(REUSABLE_PATH)

    await mountPage()

    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(targets()).toEqual([LINK_INVALID_ROUTE])
  })

  it('no fragment, no session and the flag set: terminal link_reopen, no request, the flag consumed', async () => {
    sessionStorage.setItem(IDENTITY_PENDING_KEY, '1')
    visit(REUSABLE_PATH)

    await mountPage()

    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(targets()).toEqual([LINK_REOPEN_ROUTE])
    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toBeNull()
  })

  it('a reload that finds the flag shows no form at all', async () => {
    sessionStorage.setItem(IDENTITY_PENDING_KEY, '1')
    visit(REUSABLE_PATH)

    const wrapper = await mountPage()

    expect(wrapper.find(FORM).exists()).toBe(false)
  })

  it('an EXPIRED reusable session is purged and is terminal link_invalid, no request', async () => {
    useCandidateSession().store(makeCandidateJwt({ exp: NOW_SECONDS - 1 }), { entry: 'reusable' })
    visit(REUSABLE_PATH)

    await mountPage()

    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(targets()).toEqual([LINK_INVALID_ROUTE])
  })

  it('ignores a fragment that is not a link at all and treats the load as a reload', async () => {
    useCandidateSession().store(makeCandidateJwt(), { entry: 'reusable' })
    visit(`${REUSABLE_PATH}#some-anchor`)

    await mountPage()

    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#some-anchor')
    expect(targets()).toEqual([SESSION_ROUTE])
  })
})

describe('interview/reusable.vue — a fresh link starts again at an empty form', () => {
  it('a fresh fragment clears a stale flag first and shows an empty form', async () => {
    sessionStorage.setItem(IDENTITY_PENDING_KEY, 'stale')

    const wrapper = await openLink()

    expect(wrapper.find(FORM).exists()).toBe(true)
    expect((wrapper.get(NAME_FIELD).element as HTMLInputElement).value).toBe('')
    expect((wrapper.get(EMAIL_FIELD).element as HTMLInputElement).value).toBe('')
    // set again for THIS form, and nothing but the single character
    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toBe('1')
  })

  it('reopening the link after the reopen terminal starts at the form again', async () => {
    sessionStorage.setItem(IDENTITY_PENDING_KEY, '1')
    visit(REUSABLE_PATH)
    const reload = await mountPage()
    reload.unmount()
    navigations.length = 0

    const wrapper = await openLink()

    expect(wrapper.find(FORM).exists()).toBe(true)
    expect(navigations).toEqual([])
  })
})

describe('interview/reusable.vue — a fragment that is not a link token', () => {
  it.each([
    ['too short', 'beai_rl_short'],
    ['too long', `beai_rl_${'a'.repeat(60)}`],
    ['the marker alone', 'beai_rl_'],
    ['carrying a `+`', `beai_rl_${'a'.repeat(42)}+`],
  ])('%s: terminal link_invalid with NO form, NO request and NO flag', async (_n, hash) => {
    sessionStorage.setItem(IDENTITY_PENDING_KEY, '1')
    visit(`${REUSABLE_PATH}#${hash}`)

    const wrapper = await mountPage()

    expect(wrapper.find(FORM).exists()).toBe(false)
    expect(mockFetchImpl).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('')
    expect(targets()).toEqual([LINK_INVALID_ROUTE])
    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toBeNull()
  })

  it('still clears a stored session: somebody opened a link, so it is not the previous visitor', async () => {
    useCandidateSession().store(makeCandidateJwt(), { entry: 'reusable' })
    visit(`${REUSABLE_PATH}#beai_rl_short`)

    await mountPage()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(targets()).not.toContain(SESSION_ROUTE)
  })
})

describe('interview/reusable.vue — leaving the page clears what it held', () => {
  it('removes the flag when the page unmounts (an in-app navigation, not a reload)', async () => {
    const wrapper = await openLink()
    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toBe('1')

    wrapper.unmount()

    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toBeNull()
  })

  it('a submit that settles after the page was left makes no navigation and keeps no token', async () => {
    let settle: (value: unknown) => void = () => undefined
    mockFetchImpl.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))
    const wrapper = await openLink()
    await submitIdentity(wrapper)

    wrapper.unmount()
    settle({ access_token: makeCandidateJwt() })
    await flushPromises()

    // Whatever the in-flight request returns, no second request is made.
    expect(mockFetchImpl).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toBeNull()
  })
})

describe('interview/reusable.vue — a router navigation in flight when the page leaves', () => {
  // A pasted fragment fires popstate before hashchange, so the router is mid-navigation
  // (and Nuxt is `_processingMiddleware`) when the redeem answer comes back. `navigateTo`
  // would silently not navigate; the visitor must still leave.
  it('still lands on the session route after a successful redemption', async () => {
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })
    const wrapper = await openLink()
    routerNavigationInFlight = true

    await submitIdentity(wrapper)

    expect(targets()).toEqual([SESSION_ROUTE])
    expect(useCandidateSession().read()?.entry).toBe('reusable')
  })

  it('still lands on link_invalid after a 404', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(404))
    const wrapper = await openLink()
    routerNavigationInFlight = true

    await submitIdentity(wrapper)

    expect(targets()).toEqual([LINK_INVALID_ROUTE])
  })

  it('still lands on the generic 403 terminal after a 403', async () => {
    mockFetchImpl.mockRejectedValueOnce(httpError(403, { redirect_url: null }))
    const wrapper = await openLink()
    routerNavigationInFlight = true

    await submitIdentity(wrapper)

    expect(targets()).toEqual([FORBIDDEN_ROUTE])
  })

  it('still resumes a stored reusable session on a reload', async () => {
    useCandidateSession().store(makeCandidateJwt(), { entry: 'reusable' })
    visit(REUSABLE_PATH)
    routerNavigationInFlight = true

    await mountPage()

    expect(targets()).toEqual([SESSION_ROUTE])
  })

  it('still lands on link_reopen after a reload that finds the flag', async () => {
    sessionStorage.setItem(IDENTITY_PENDING_KEY, '1')
    visit(REUSABLE_PATH)
    routerNavigationInFlight = true

    await mountPage()

    expect(targets()).toEqual([LINK_REOPEN_ROUTE])
  })

  it('still lands on link_invalid for a malformed fragment', async () => {
    visit(`${REUSABLE_PATH}#beai_rl_short`)
    routerNavigationInFlight = true

    await mountPage()

    expect(targets()).toEqual([LINK_INVALID_ROUTE])
  })

  it('leaves through the router (replace), the call that supersedes a pending navigation', async () => {
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })
    const wrapper = await openLink()

    await submitIdentity(wrapper)

    expect(routerReplace).toHaveBeenCalledTimes(1)
    expect(routerReplace).toHaveBeenCalledWith(SESSION_ROUTE)
  })

  it('keeps the form disabled while the router is leaving, so no second submit sneaks in', async () => {
    let finishNavigation: () => void = () => undefined
    routerReplace.mockImplementationOnce((to: string) => {
      navigations.push({ to, via: 'router', external: false })

      return new Promise<undefined>((resolve) => (finishNavigation = () => resolve(undefined)))
    })
    mockFetchImpl.mockResolvedValueOnce({ access_token: makeCandidateJwt() })
    const wrapper = await openLink()

    await submitIdentity(wrapper)

    // The form must stay disabled until the router has left, so no second submit sneaks in.
    expect(
      wrapper.get('[data-testid="reusable-identity-submit"]').attributes('disabled')
    ).toBeDefined()

    finishNavigation()
    await flushPromises()

    // ...and after it: the page is on its way out, so it never offers the form again.
    expect(
      wrapper.get('[data-testid="reusable-identity-submit"]').attributes('disabled')
    ).toBeDefined()
  })
})
