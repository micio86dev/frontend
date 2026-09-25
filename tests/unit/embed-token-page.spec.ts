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
  holder: { session: null as unknown },
}))

vi.mock('ofetch', () => ({ $fetch: mockFetch }))

vi.mock('~/app/composables/useEmbedBridge', () => ({
  useEmbedBridge: () => ({ attach: vi.fn(), detach: vi.fn(), post: mockPost }),
}))

vi.mock('~/components/InterviewSession.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'InterviewSession',
      setup(_props, { expose }) {
        expose({ session: holder.session })
        return () => h('div', { 'data-testid': 'interview-session-stub' })
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

describe('embed/[token].vue — success path and event mapping', () => {
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
