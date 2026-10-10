/**
 * useInterviewSession — Tavus ceiling handover (tavus-single-session-interview, FE-06).
 *
 * 06a: a fresh handle that arrives while a live one exists crossfades (whatever the
 * provider), and a conversation-age timer (`conversation_ttl_seconds` minus
 * `HANDOVER_LEAD_MS`) obtains that fresh handle mid-competency.
 * 06b: a Tavus conversation that ends unannounced while a competency is `in_corso`
 * is resumed through the same path (design N17).
 *
 * Harness mirrors use-interview-session-continuation.spec.ts.
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
const B = 77
const CONV = 'conv-1'
const TTL = 600
const LEAD_MS = 120_000
const AGE_MS = TTL * 1000 - LEAD_MS

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
async function paintIncoming(session: ReturnType<typeof useInterviewSession>) {
  const incoming = session.players.value.find((p) => p.role === 'incoming')!
  session.notifyPainted(incoming.key)
  await vi.advanceTimersByTimeAsync(300)
}

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

describe('FE-06a crossfade predicate: a fresh handle while a live one exists', () => {
  it('a Tavus fresh handle at a boundary crossfades instead of tearing the live one down', async () => {
    const session = await liveSession()
    queue('/candidate/interview/end', END_CONTINUE)
    queue('/candidate/interview/start', fresh(B))

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(session.state.value).toBe('live')
    expect(providers[0]!._stop).not.toHaveBeenCalled()
    expect(session.players.value.map((p) => p.role)).toEqual(['live', 'incoming'])
    expect(session.handoverInFlight.value).toBe(true)

    await paintIncoming(session)

    expect(session.players.value).toHaveLength(1)
    expect(session.sessionId.value).toBe(B)
    expect(session.state.value).toBe('live')
    expect(providers[1]!.setMicMuted).toHaveBeenLastCalledWith(false)
  })

  it('arms the 10 s bound when the fresh handle is published', async () => {
    const session = await liveSession()
    queue('/candidate/interview/end', END_CONTINUE)
    queue('/candidate/interview/start', fresh(B))
    providers[0]!._emit('state', 'complete')
    await flush()

    await vi.advanceTimersByTimeAsync(9_999)
    expect(session.state.value).toBe('live')
    await vi.advanceTimersByTimeAsync(1)

    expect(session.state.value).toBe('connecting')
    expect(session.players.value.map((p) => p.role)).toEqual(['incoming'])
  })
})

describe('FE-06a age timer', () => {
  it('fires at conversation_ttl_seconds minus HANDOVER_LEAD_MS and resumes the in_corso row', async () => {
    const session = await liveSession()
    queue('/candidate/interview/start', fresh(A))

    await vi.advanceTimersByTimeAsync(AGE_MS - 1)
    expect(starts()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await flush()

    expect(starts()).toHaveLength(2)
    expect(starts()[1]![1]).toEqual({ method: 'POST' })
    expect(ends()).toHaveLength(0)
    expect(session.sessionId.value).toBe(A)
    expect(session.players.value.map((p) => p.role)).toEqual(['live', 'incoming'])
    const keys = session.players.value.map((p) => p.key)
    expect(new Set(keys).size).toBe(2)
    expect(session.handoverInFlight.value).toBe(true)
  })

  it('keeps the competency: after the crossfade the new handle is live on the same row and re-arms', async () => {
    const session = await liveSession()
    queue('/candidate/interview/start', fresh(A), fresh(A))

    await vi.advanceTimersByTimeAsync(AGE_MS)
    await flush()
    await paintIncoming(session)

    expect(session.players.value).toHaveLength(1)
    expect(session.sessionId.value).toBe(A)
    expect(session.players.value[0]!.provider).toBe(providers[1])

    await vi.advanceTimersByTimeAsync(AGE_MS)
    await flush()
    expect(starts()).toHaveLength(3)
  })

  it('does not fire while a boundary is in flight', async () => {
    const session = await liveSession()
    let release!: (v: unknown) => void
    queue('/candidate/interview/end', new Promise((r) => (release = r)))
    queue('/candidate/interview/start', fresh(B))
    providers[0]!._emit('state', 'complete')
    await vi.advanceTimersByTimeAsync(10)
    expect(session.handoverInFlight.value).toBe(true)

    await vi.advanceTimersByTimeAsync(AGE_MS)

    expect(starts()).toHaveLength(1)
    release(END_CONTINUE)
    await flush()
  })

  it.each([
    ['no conversation_ttl_seconds', fresh(A, null)],
    ['a ttl not above the lead', fresh(A, 120)],
    ['a non-Tavus handle', response(A, { provider: 'heygen', conversation_ttl_seconds: TTL })],
  ])('does not fire for %s', async (_label, first) => {
    await liveSession(first)

    await vi.advanceTimersByTimeAsync(TTL * 1000 * 2)

    expect(starts()).toHaveLength(1)
  })

  it('is cancelled when the competency leaves live (pause)', async () => {
    const session = await liveSession()
    session.pause()

    await vi.advanceTimersByTimeAsync(AGE_MS * 2)

    expect(starts()).toHaveLength(1)
  })
})

describe('FE-06b unannounced end (N17)', () => {
  it('a stop the client did not request resumes the in_corso row via /start', async () => {
    const session = await liveSession()
    queue('/candidate/interview/start', fresh(A))

    providers[0]!._emit('state', 'stopped')
    await flush()

    expect(starts()).toHaveLength(2)
    expect(starts()[1]![1]).toEqual({ method: 'POST' })
    expect(ends()).toHaveLength(0)
    expect(session.sessionId.value).toBe(A)
    expect(session.players.value.map((p) => p.role)).toContain('incoming')
  })

  it('does not resume on a deliberate client-side stop', async () => {
    const session = await liveSession()
    queue('/candidate/interview/end', { next_action: 'pause' })

    await session.endQuestion('timeout')
    await flush()

    expect(providers[0]!._stop).toHaveBeenCalled()
    expect(starts()).toHaveLength(1)
  })

  it('does not resume when the client stops a Tavus handle that names no conversation', async () => {
    const session = await liveSession(response(A))
    queue('/candidate/interview/end', { next_action: 'pause' })

    await session.endQuestion('timeout')
    await flush()

    expect(providers[0]!._stop).toHaveBeenCalled()
    expect(starts()).toHaveLength(1)
    expect(session.state.value).toBe('end_of_question')
  })

  it('does not resume on a pause', async () => {
    const session = await liveSession()

    session.pause()
    await flush()

    expect(starts()).toHaveLength(1)
  })

  it('does not resume after the final competency', async () => {
    const session = await liveSession()
    queue('/candidate/interview/end', { next_action: 'done' })

    providers[0]!._emit('state', 'complete')
    await flush()
    providers[0]!._emit('state', 'stopped')
    await flush()

    expect(session.state.value).toBe('done')
    expect(starts()).toHaveLength(1)
  })
})
