/**
 * useInterviewSession — a connect-time failure of an `hr_avatar` handle (hr-avatar-adapter, F3).
 *
 * The browser's connect is the first call that touches the engine, so its refusals
 * (concurrency limit, missing credential, provider error) surface only AFTER `/start` has
 * already answered 201. The adapter reports each as `sdk_error`. The retry path is existing
 * code: the session shows the retryable error screen (not the terminal one), runs no 429
 * backoff (that rule keys on the `/start` HTTP status, which was 201), and the candidate's
 * retry calls `/start` again, with no `live_conversation_id`, and builds a fresh provider.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'

const { mockCandidateFetch, mockFlushIntegrityKeepalive, mockCreateProvider } = vi.hoisted(() => ({
  mockCandidateFetch: vi.fn(),
  mockFlushIntegrityKeepalive: vi.fn(),
  mockCreateProvider: vi.fn(),
}))

vi.mock('~/app/providers/factory', () => ({ createProvider: mockCreateProvider }))
vi.mock('~/app/utils/candidate-api', () => ({
  candidateFetch: mockCandidateFetch,
  flushIntegrityKeepalive: mockFlushIntegrityKeepalive,
  CandidateUnauthorizedError: class CandidateUnauthorizedError extends Error {},
}))
vi.mock('~/app/composables/useCandidateSession', () => ({
  useCandidateSession: () => ({ clear: vi.fn(), read: vi.fn(), store: vi.fn() }),
}))

// eslint-disable-next-line import/first
import { useInterviewSession } from '~/app/composables/useInterviewSession'

type EventCallback = (payload: unknown) => void

function createMockProvider() {
  const listeners = new Map<string, EventCallback[]>()
  // The composable wraps `provider.stop` (idempotent teardown), so assert on the original.
  const stopSpy = vi.fn(async () => undefined)
  return {
    _stop: stopSpy,
    on: vi.fn((evt: string, cb: EventCallback) => {
      listeners.set(evt, [...(listeners.get(evt) ?? []), cb])
    }),
    start: vi.fn(async () => ({})),
    stop: stopSpy,
    toggleMic: vi.fn(async () => undefined),
    setMicMuted: vi.fn(async () => undefined),
    nudgeWrapUp: vi.fn(),
    _emit(evt: string, payload: unknown) {
      for (const cb of listeners.get(evt) ?? []) cb(payload)
    },
  }
}

let providers: ReturnType<typeof createMockProvider>[] = []
const queues = new Map<string, unknown[]>()

function queue(path: string, ...responses: unknown[]) {
  queues.set(path, [...(queues.get(path) ?? []), ...responses])
}

const hrAvatarBody = (secret: string) => ({
  session_id: 42,
  provider: 'hr_avatar',
  provider_token: secret,
  conversation_url: null,
  audio_only: false,
  question_context: {
    competency_code: 'PRS',
    question_index: 0,
    end_phrase: 'Passiamo alla prossima domanda.',
    final_phrase: 'Grazie.',
    prompt_version: 'v1',
  },
  hr_avatar: { base_url: 'https://hra.test', publishable_key: 'PK' },
})

async function flush() {
  for (let i = 0; i < 30; i++) await nextTick()
}

const starts = () =>
  mockCandidateFetch.mock.calls.filter((c: unknown[]) => c[0] === '/candidate/interview/start')

beforeEach(() => {
  vi.clearAllMocks()
  mockCandidateFetch.mockReset()
  queues.clear()
  mockCandidateFetch.mockImplementation(async (path: string) => queues.get(path)?.shift())
  vi.useFakeTimers()
  providers = []
  mockCreateProvider.mockImplementation(() => {
    const p = createMockProvider()
    providers.push(p)
    return p
  })
  vi.stubGlobal('navigateTo', vi.fn())
  vi.stubGlobal(
    'useRuntimeConfig',
    vi.fn(() => ({ public: { apiBase: 'https://api.test', interviewProviderMock: 'false' } }))
  )
  vi.stubGlobal('window', {
    innerWidth: 1280,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('an hr_avatar handle whose connect fails after a 201 /start', () => {
  async function failedConnect() {
    const session = useInterviewSession()
    session.acceptConsent()
    queue('/candidate/interview/start', hrAvatarBody('FIRST_SECRET'))
    session.confirmDevices()
    await flush()
    providers[0]!._emit('error', { code: 'sdk_error', message: 'provider_unavailable' })
    await flush()
    return session
  }

  it('shows the retryable error screen, not the terminal one', async () => {
    const session = await failedConnect()

    expect(session.state.value).toBe('error')
    expect(session.terminalReason.value).toBeNull()
    expect(providers[0]!._stop).toHaveBeenCalled()
  })

  it('runs no automatic backoff: /start is not called again on its own', async () => {
    await failedConnect()

    await vi.advanceTimersByTimeAsync(60_000)
    await flush()

    expect(starts()).toHaveLength(1)
    expect(mockCreateProvider).toHaveBeenCalledTimes(1)
  })

  it('the candidate retry issues a second /start without live_conversation_id and a fresh provider', async () => {
    const session = await failedConnect()
    queue('/candidate/interview/start', hrAvatarBody('SECOND_SECRET'))

    session.retry()
    await flush()

    expect(starts()).toHaveLength(2)
    expect((starts()[1]![1] as { body?: unknown }).body).toBeUndefined()
    expect(mockCreateProvider).toHaveBeenCalledTimes(2)
    expect(providers[1]).not.toBe(providers[0])
    expect(session.state.value).toBe('connecting')
    expect(session.activeConfig.value?.sessionToken).toBe('SECOND_SECRET')
  })
})
