/**
 * useInterviewSession — a failed /end is retried for the SAME session, not restarted.
 *
 * Harness mirrors use-interview-session-ceiling.spec.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { useInterviewSession } from '~/app/composables/useInterviewSession'

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

type EventCallback = (payload: unknown) => void

function createMockProvider() {
  const listeners = new Map<string, EventCallback[]>()
  const emit = (evt: string, payload: unknown) => {
    for (const cb of listeners.get(evt) ?? []) cb(payload)
  }
  // The composable wraps `provider.stop`, so assert on the original. Like the
  // real provider, a stop reports `stopped`.
  const stopSpy = vi.fn(async () => {
    emit('state', 'stopped')
  })
  return {
    _stop: stopSpy,
    on: vi.fn((evt: string, cb: EventCallback) => {
      listeners.set(evt, [...(listeners.get(evt) ?? []), cb])
    }),
    start: vi.fn(async () => ({ providerSessionId: 'p' })),
    stop: stopSpy,
    toggleMic: vi.fn(async () => undefined),
    setMicMuted: vi.fn(async () => undefined),
    nudgeWrapUp: vi.fn(),
    sendBoundary: vi.fn(async () => ({ ok: true as const })),
    _emit: emit,
  }
}

let providers: ReturnType<typeof createMockProvider>[] = []
const queues = new Map<string, unknown[]>()

function queue(path: string, ...responses: unknown[]) {
  queues.set(path, [...(queues.get(path) ?? []), ...responses])
}

const A = 42
const CONV = 'conv-1'
const TTL = 600

function response(sessionId: number, extra: Record<string, unknown> = {}) {
  return {
    session_id: sessionId,
    provider: 'tavus',
    provider_token: null,
    conversation_url: 'https://tavus.test/room',
    audio_only: false,
    question_context: {
      competency_code: 'PRS',
      question_index: 0,
      end_phrase: 'Passiamo alla prossima domanda.',
      final_phrase: 'Grazie.',
      prompt_version: 'v1',
    },
    ...extra,
  }
}

const fresh = (sessionId = A, ttl: number | null = TTL) =>
  response(sessionId, {
    conversation_id: CONV,
    ...(ttl === null ? {} : { conversation_ttl_seconds: ttl }),
  })

const END_CONTINUE = { next_action: 'continue', ended_competencies: 1, total_competencies: 3 }

async function flush() {
  for (let i = 0; i < 30; i++) await nextTick()
}

async function liveSession(first: unknown = fresh()) {
  const session = useInterviewSession()
  session.acceptConsent()
  queue('/candidate/interview/start', first)
  session.confirmDevices()
  await flush()
  providers[0]!._emit('state', 'ready')
  await flush()
  expect(session.state.value).toBe('live')
  return session
}

const callsTo = (path: string) => mockCandidateFetch.mock.calls.filter((c) => c[0] === path)
const starts = () => callsTo('/candidate/interview/start')
const ends = () => callsTo('/candidate/interview/end')

/** Paint the incoming handle and let the crossfade finish. */

beforeEach(() => {
  vi.clearAllMocks()
  mockCandidateFetch.mockReset()
  mockFlushIntegrityKeepalive.mockReset()
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

describe('a failed /end on a live question', () => {
  it('shows the retryable error screen and sends no new start', async () => {
    const session = await liveSession()
    mockCandidateFetch.mockImplementationOnce(async () => {
      throw Object.assign(new Error('server error'), { status: 500 })
    })

    await session.endQuestion('completed')

    expect(session.state.value).toBe('error')
    expect(starts()).toHaveLength(1)
    expect(ends()).toHaveLength(1)
  })

  it('retry re-sends the same /end for the same session, then continues', async () => {
    const session = await liveSession()
    mockCandidateFetch.mockImplementationOnce(async () => {
      throw Object.assign(new Error('server error'), { status: 500 })
    })
    await session.endQuestion('completed')
    queue('/candidate/interview/end', END_CONTINUE)

    session.retry()
    await flush()

    const retried = ends()
    expect(retried).toHaveLength(2)
    expect(retried[1]![1]).toMatchObject({ body: { session_id: A, ended_reason: 'completed' } })
    // The confirmed end then continues to the next competency: that start comes after the retried end.
    const order = mockCandidateFetch.mock.calls.map((c) => c[0])
    expect(order.lastIndexOf('/candidate/interview/end')).toBeLessThan(
      order.lastIndexOf('/candidate/interview/start')
    )
  })
})
