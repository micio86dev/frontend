/**
 * app/pages/embed/[token].vue — exchange error mapping, provider auto-retry
 * budget and the session-state → postMessage event mapping (public-api SPEC §4.4).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

const { mockFetch, mockPost, holder } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockPost: vi.fn(),
  holder: {
    session: null as unknown,
    bridgeOptions: null as null | { getAllowedOrigins: () => string[] },
  },
}))

vi.mock('ofetch', () => ({ $fetch: mockFetch }))

// The brand canvas reads the organization's branding through its own module;
// that is a separate authenticated request this route has nothing to do with,
// and the module's `ofetch.create` is not part of the `$fetch` mock above.
vi.mock('~/app/composables/useCandidateBranding', () => ({
  useCandidateBranding: () => ({
    logoUrl: { value: null },
    organizationName: { value: null },
    ensureLoaded: vi.fn(),
  }),
}))

vi.mock('~/app/composables/useEmbedBridge', () => ({
  useEmbedBridge: (options: { getAllowedOrigins: () => string[] }) => {
    holder.bridgeOptions = options
    return { attach: vi.fn(), detach: vi.fn(), post: mockPost }
  },
}))

vi.mock('~/components/InterviewSession.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'InterviewSession',
      props: { embedded: { type: Boolean, default: false } },
      setup(props, { expose }) {
        expose({ session: holder.session })
        return () =>
          h('div', {
            'data-testid': 'interview-session-stub',
            'data-embedded': String(props.embedded),
          })
      },
    }),
  }
})

// eslint-disable-next-line import/first
import { useCandidateSession } from '~/app/composables/useCandidateSession'

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function makeJwt(claims: Record<string, unknown>): string {
  return `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}.sig`
}

const NOW = Math.floor(Date.now() / 1000)
const INTERVIEW_ID = 'int_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SESSION_TOKEN = makeJwt({ sub: INTERVIEW_ID, exp: NOW + 900 })
const ACCESS_TOKEN = makeJwt({ typ: 'candidate', sub: INTERVIEW_ID, exp: NOW + 3600 })
const AUTO_RETRY_DELAY_MS = 3_000

function makeSession(state = 'idle') {
  return {
    state: ref(state),
    terminalReason: ref<string | null>(null),
    sessionId: ref<number | null>(null),
    endedCompetencies: ref<number | null>(null),
    totalCompetencies: ref<number | null>(null),
    retry: vi.fn(),
  }
}

function httpError(status?: number): Error & { status?: number } {
  const err = new Error('failed') as Error & { status?: number }
  if (status !== undefined) err.status = status
  return err
}

function routeFetch(exchange: () => Promise<unknown>): void {
  mockFetch.mockImplementation((url: string) => {
    if (url.endsWith('/embed/frame-policy')) return Promise.resolve({ allowed_domains: [] })
    return exchange()
  })
}

async function mountPage() {
  vi.stubGlobal(
    'useRoute',
    vi.fn(() => ({ params: { token: SESSION_TOKEN }, query: {} }))
  )
  const { default: Page } = await import('~/app/pages/embed/[token].vue')
  const wrapper = mount(Page, { global: { mocks: { $t: (key: string) => key } } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  holder.session = makeSession()
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useHead', vi.fn())
  vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }))
  vi.stubGlobal(
    'useRuntimeConfig',
    vi.fn(() => ({ public: { apiBase: 'https://api.test/api' } }))
  )
  routeFetch(() => Promise.resolve({ access_token: ACCESS_TOKEN }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('embed/[token].vue — exchange error mapping', () => {
  it.each([
    [410, 'link_used', false],
    [401, 'link_invalid', false],
    [404, 'link_invalid', false],
    [409, 'unavailable', true],
    [403, '403', false],
    [429, 'unavailable', true],
    [500, 'unavailable', true],
    [503, 'unavailable', true],
    [undefined, 'unavailable', true],
  ])('status %s → reason %s, recoverable=%s', async (status, reason, recoverable) => {
    routeFetch(() => Promise.reject(httpError(status)))

    const wrapper = await mountPage()

    expect(wrapper.find('[data-testid="embed-error-screen"]').text()).toContain(
      `interview.terminal.${reason}.title`
    )
    expect(mockPost).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: reason, recoverable })
    )
  })
})

describe('embed/[token].vue — unsupported browser gate', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the unsupported screen inline and tells the host, without calling the exchange', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:120.0) Gecko/20100101 Firefox/120.0'
    )

    const wrapper = await mountPage()

    expect(wrapper.find('[data-testid="embed-error-screen"]').text()).toContain(
      'interview.terminal.unsupported.title'
    )
    expect(mockPost).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'unsupported', recoverable: false })
    )
    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/embed/exchange'),
      expect.anything()
    )
  })
})

describe('embed/[token].vue — success path and event mapping', () => {
  it('renders the interview as embedded, so the call stage uses no viewport-height unit', async () => {
    const wrapper = await mountPage()

    expect(wrapper.get('[data-testid="interview-session-stub"]').attributes('data-embedded')).toBe(
      'true'
    )
  })

  it('stores the candidate session and posts ready once the interview mounts', async () => {
    await mountPage()

    expect(useCandidateSession().read()?.accessToken).toBe(ACCESS_TOKEN)
    expect(mockPost).toHaveBeenCalledWith('ready')
  })

  it('maps state transitions to consent:granted, started and completed', async () => {
    const session = holder.session as ReturnType<typeof makeSession>
    await mountPage()

    session.state.value = 'device_check'
    await flushPromises()
    expect(mockPost).toHaveBeenCalledWith('consent:granted')

    session.state.value = 'live'
    await flushPromises()
    expect(mockPost).toHaveBeenCalledWith('started')

    session.state.value = 'done'
    await flushPromises()
    expect(mockPost).toHaveBeenCalledWith('completed', { interviewId: INTERVIEW_ID })
  })

  it('posts a non-recoverable error carrying the terminal reason', async () => {
    const session = holder.session as ReturnType<typeof makeSession>
    await mountPage()

    session.terminalReason.value = 'session_expired'
    session.state.value = 'terminal'
    await flushPromises()

    expect(mockPost).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'session_expired', recoverable: false })
    )
  })
})

describe('embed/[token].vue — provider auto-retry', () => {
  async function mountWithFakeTimers() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    return mountPage()
  }

  async function failOnce(session: ReturnType<typeof makeSession>): Promise<void> {
    session.state.value = 'error'
    await flushPromises()
    vi.advanceTimersByTime(AUTO_RETRY_DELAY_MS)
    await flushPromises()
    // The real retry() moves the machine out of `error`; emulate that.
    session.state.value = 'connecting'
    await flushPromises()
  }

  it('retries three times, then tells the host the failure is not recoverable', async () => {
    const session = holder.session as ReturnType<typeof makeSession>
    await mountWithFakeTimers()

    await failOnce(session)
    await failOnce(session)
    await failOnce(session)
    expect(session.retry).toHaveBeenCalledTimes(3)

    session.state.value = 'error'
    await flushPromises()
    vi.advanceTimersByTime(AUTO_RETRY_DELAY_MS)

    expect(session.retry).toHaveBeenCalledTimes(3)
    expect(mockPost).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'provider_connection_failed', recoverable: false })
    )
  })

  it('resets the retry budget once the session recovers to live', async () => {
    const session = holder.session as ReturnType<typeof makeSession>
    await mountWithFakeTimers()

    await failOnce(session)
    await failOnce(session)
    session.state.value = 'live'
    await flushPromises()

    await failOnce(session)
    await failOnce(session)
    await failOnce(session)

    expect(session.retry).toHaveBeenCalledTimes(5)
    expect(mockPost).not.toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'provider_connection_failed' })
    )
  })

  it('does not retry after the page unmounts mid-backoff', async () => {
    const session = holder.session as ReturnType<typeof makeSession>
    const wrapper = await mountWithFakeTimers()

    session.state.value = 'error'
    await flushPromises()
    wrapper.unmount()
    vi.advanceTimersByTime(AUTO_RETRY_DELAY_MS * 2)

    expect(session.retry).not.toHaveBeenCalled()
  })
})

describe('embed/[token].vue — resize emission', () => {
  const RESIZE_THROTTLE_MS = 100
  let observerCallback: (() => void) | null
  let observe: ReturnType<typeof vi.fn>
  let disconnect: ReturnType<typeof vi.fn>
  let height: number

  beforeEach(() => {
    vi.useFakeTimers()
    observerCallback = null
    observe = vi.fn()
    disconnect = vi.fn()
    height = 640
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observerCallback = cb
        }
        observe = observe
        disconnect = disconnect
        unobserve = vi.fn()
      }
    )
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      get: () => height,
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(document.documentElement, 'scrollHeight')
  })

  function resizeCalls(): unknown[][] {
    return mockPost.mock.calls.filter((call) => call[0] === 'resize')
  }

  it('observes the document root and posts its scrollHeight', async () => {
    await mountPage()
    expect(observe).toHaveBeenCalledWith(document.documentElement)

    observerCallback?.()
    vi.advanceTimersByTime(RESIZE_THROTTLE_MS)

    expect(resizeCalls()).toEqual([['resize', { height: 640 }]])
  })

  it('does not re-post an unchanged height', async () => {
    await mountPage()

    observerCallback?.()
    vi.advanceTimersByTime(RESIZE_THROTTLE_MS)
    observerCallback?.()
    vi.advanceTimersByTime(RESIZE_THROTTLE_MS)

    expect(resizeCalls()).toHaveLength(1)
  })

  it('collapses a burst of changes into one post carrying the latest height', async () => {
    await mountPage()

    observerCallback?.()
    height = 700
    observerCallback?.()
    height = 720
    observerCallback?.()
    vi.advanceTimersByTime(RESIZE_THROTTLE_MS)

    expect(resizeCalls()).toEqual([['resize', { height: 720 }]])
  })

  it('disconnects the observer and drops a pending post on unmount', async () => {
    const wrapper = await mountPage()

    observerCallback?.()
    wrapper.unmount()
    vi.advanceTimersByTime(RESIZE_THROTTLE_MS)

    expect(disconnect).toHaveBeenCalled()
    expect(resizeCalls()).toHaveLength(0)
  })

  it('does not throw where ResizeObserver is unavailable', async () => {
    vi.stubGlobal('ResizeObserver', undefined)

    await expect(mountPage()).resolves.toBeDefined()
  })
})

describe('embed/[token].vue — session reuse and host origin policy', () => {
  it('reuses a stored session that belongs to this very link, without spending the single-use exchange', async () => {
    useCandidateSession().store(ACCESS_TOKEN, { interviewId: INTERVIEW_ID })

    const wrapper = await mountPage()

    expect(wrapper.find('[data-testid="interview-session-stub"]').exists()).toBe(true)
    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/embed/exchange'),
      expect.anything()
    )
  })

  it('exchanges the link when the stored session belongs to a different interview', async () => {
    useCandidateSession().store(ACCESS_TOKEN, { interviewId: 'int_SOMEONE_ELSE' })

    await mountPage()

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/embed/exchange'),
      expect.anything()
    )
    expect(useCandidateSession().read()?.interviewId).toBe(INTERVIEW_ID)
  })

  it('hands the bridge the origins the frame policy allows', async () => {
    mockFetch.mockImplementation((url: string) =>
      url.endsWith('/embed/frame-policy')
        ? Promise.resolve({ allowed_domains: ['host.example'] })
        : Promise.resolve({ access_token: ACCESS_TOKEN })
    )

    await mountPage()

    expect(holder.bridgeOptions!.getAllowedOrigins()).toEqual(['host.example'])
  })

  it.each([
    ['rejects', () => Promise.reject(httpError(500))],
    ['returns a malformed body', () => Promise.resolve({ allowed_domains: 'host.example' })],
  ])('accepts no host message at all when the frame policy %s', async (_label, policy) => {
    mockFetch.mockImplementation((url: string) =>
      url.endsWith('/embed/frame-policy')
        ? policy()
        : Promise.resolve({ access_token: ACCESS_TOKEN })
    )

    await mountPage()

    expect(holder.bridgeOptions!.getAllowedOrigins()).toEqual([])
  })
})

describe('embed/[token].vue — progress and permission events', () => {
  it('posts question:changed with the progress each time a new session id appears', async () => {
    const session = holder.session as ReturnType<typeof makeSession>
    await mountPage()

    session.endedCompetencies.value = 2
    session.totalCompetencies.value = 5
    session.sessionId.value = 11
    await flushPromises()
    expect(mockPost).toHaveBeenCalledWith('question:changed', { index: 2, total: 5 })

    mockPost.mockClear()
    session.sessionId.value = null
    await flushPromises()
    expect(mockPost).not.toHaveBeenCalledWith('question:changed', expect.anything())
  })

  it('reports the real total from the first competency while the index stays on the /end tally', async () => {
    // /start now seeds the total, so a first competency reads 0 of N, never 0 of 0.
    const session = holder.session as ReturnType<typeof makeSession>
    await mountPage()

    session.totalCompetencies.value = 5
    session.sessionId.value = 11
    await flushPromises()

    expect(mockPost).toHaveBeenCalledWith('question:changed', { index: 0, total: 5 })
  })

  it('reports zero progress while the counts are still unknown', async () => {
    const session = holder.session as ReturnType<typeof makeSession>
    await mountPage()

    session.sessionId.value = 1
    await flushPromises()

    expect(mockPost).toHaveBeenCalledWith('question:changed', { index: 0, total: 0 })
  })

  it('reports an unknown terminal reason as "unknown" rather than posting undefined', async () => {
    const session = holder.session as ReturnType<typeof makeSession>
    await mountPage()

    session.state.value = 'terminal'
    await flushPromises()

    expect(mockPost).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'unknown' }))
  })

  describe('permissions', () => {
    type Status = { state: string; onchange: null | (() => void) }
    const original = Object.getOwnPropertyDescriptor(navigator, 'permissions')

    afterEach(() => {
      if (original) Object.defineProperty(navigator, 'permissions', original)
      else delete (navigator as unknown as Record<string, unknown>).permissions
    })

    function stubPermissions(query: (d: { name: string }) => Promise<Status>): void {
      Object.defineProperty(navigator, 'permissions', {
        configurable: true,
        value: { query },
      })
    }

    it('posts permissions:denied when a device is already denied, and again when it is revoked later', async () => {
      const statuses: Record<string, Status> = {
        camera: { state: 'denied', onchange: null },
        microphone: { state: 'granted', onchange: null },
      }
      stubPermissions(({ name }) => Promise.resolve(statuses[name]!))
      await mountPage()
      // The query promises (and their .then handlers) have settled before any
      // change handler is read or invoked.
      await flushPromises()
      expect(mockPost.mock.calls.filter(([e]) => e === 'permissions:denied')).toHaveLength(1)
      expect(statuses.camera!.onchange).toBeTypeOf('function')
      expect(statuses.microphone!.onchange).toBeTypeOf('function')

      statuses.microphone!.state = 'denied'
      statuses.microphone!.onchange!()
      expect(mockPost.mock.calls.filter(([e]) => e === 'permissions:denied')).toHaveLength(2)

      // A change that is not a denial stays quiet.
      statuses.microphone!.state = 'granted'
      statuses.microphone!.onchange!()
      expect(mockPost.mock.calls.filter(([e]) => e === 'permissions:denied')).toHaveLength(2)
    })

    it('degrades silently where the permission name is unsupported', async () => {
      const query = vi.fn(() => Promise.reject(new TypeError('unsupported')))
      stubPermissions(query)

      await mountPage()
      await flushPromises()

      // Both devices were actually queried and both queries rejected, so the
      // swallow path ran; the page neither crashed nor reported a denial.
      expect(query.mock.calls.map(([d]) => (d as { name: string }).name)).toEqual([
        'camera',
        'microphone',
      ])
      expect(mockPost).toHaveBeenCalledWith('ready')
      expect(mockPost).not.toHaveBeenCalledWith('permissions:denied')
    })

    it('does nothing where the Permissions API does not exist', async () => {
      Object.defineProperty(navigator, 'permissions', { configurable: true, value: undefined })

      await mountPage()

      expect(mockPost).toHaveBeenCalledWith('ready')
    })
  })
})
