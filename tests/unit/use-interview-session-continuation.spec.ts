/**
 * useInterviewSession — Tavus continuation and boundary flow
 * (tavus-single-session-interview, FE-04).
 *
 * One joined Tavus conversation serves several competency rows. The browser
 * asserts it is IN the room (`live_conversation_id`), the server answers with a
 * `continuation` (no handle), and the browser retargets the SAME conversation:
 * mute -> /end -> /start -> cursor move -> steering -> unmute at the ack.
 *
 * Harness mirrors use-interview-session-attribution.spec.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick, watch } from 'vue'

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
import { useInterviewSession, isValidStartResponse } from '~/app/composables/useInterviewSession'

type EventCallback = (payload: unknown) => void
type SteeringResult = { ok: true } | { ok: false; reason: string }

/** Everything observable, in order: `mute`, `unmute`, `send`, and one entry per HTTP path. */
let log: string[] = []

function createMockProvider(steerable: boolean) {
  const listeners = new Map<string, EventCallback[]>()
  // The composable wraps `provider.stop` (idempotent teardown), so assert on the original.
  const stopSpy = vi.fn(async () => undefined)
  const p = {
    _stop: stopSpy,
    on: vi.fn((evt: string, cb: EventCallback) => {
      listeners.set(evt, [...(listeners.get(evt) ?? []), cb])
    }),
    start: vi.fn(async () => ({ providerSessionId: 'p' })),
    stop: stopSpy,
    toggleMic: vi.fn(async () => undefined),
    setMicMuted: vi.fn(async (muted: boolean) => {
      log.push(muted ? 'mute' : 'unmute')
    }),
    nudgeWrapUp: vi.fn(),
    sendBoundary: vi.fn(async (): Promise<SteeringResult> => {
      log.push('send')
      return { ok: true }
    }),
    _emit(evt: string, payload: unknown) {
      for (const cb of listeners.get(evt) ?? []) cb(payload)
    },
  }
  if (!steerable) delete (p as Partial<typeof p>).sendBoundary
  return p
}

let providers: ReturnType<typeof createMockProvider>[] = []
let steerableProviders = true
const queues = new Map<string, unknown[]>()

class Thrown {
  constructor(readonly error: unknown) {}
}

/** Queue the next response(s) for a path; an `Error`-like value is thrown. */
function queue(path: string, ...responses: unknown[]) {
  queues.set(path, [...(queues.get(path) ?? []), ...responses])
}

const A = 42
const B = 77
const C = 103
const CONV = 'conv-1'

function baseResponse(sessionId: number, extra: Record<string, unknown> = {}) {
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

/** A fresh single-session handle: names its conversation. */
const fresh = (sessionId = A) => baseResponse(sessionId, { conversation_id: CONV })

/** A granted continuation: no handle, the conversation is shared. */
const continuation = (sessionId: number, code = 'INN', conversationId = CONV) =>
  baseResponse(sessionId, {
    conversation_url: null,
    continuation: { conversation_id: conversationId, competency_code: code },
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

function callsTo(path: string) {
  return mockCandidateFetch.mock.calls.filter((c: unknown[]) => c[0] === path)
}
const starts = () => callsTo('/candidate/interview/start')
const ends = () => callsTo('/candidate/interview/end')
const startBody = (n: number) => (starts()[n]![1] as { body?: unknown }).body

beforeEach(() => {
  vi.clearAllMocks()
  mockCandidateFetch.mockReset()
  mockFlushIntegrityKeepalive.mockReset()
  log = []
  queues.clear()
  steerableProviders = true
  mockCandidateFetch.mockImplementation(async (path: string) => {
    log.push(path.replace('/candidate/interview/', ''))
    const next = queues.get(path)?.shift()
    if (next instanceof Thrown) throw next.error
    return next
  })
  vi.useFakeTimers()
  providers = []
  mockCreateProvider.mockImplementation(() => {
    const p = createMockProvider(steerableProviders)
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

describe('isValidStartResponse — continuation', () => {
  it('accepts a fresh response with conversation_id and a granted continuation', () => {
    expect(isValidStartResponse(fresh())).toBe(true)
    expect(isValidStartResponse(continuation(B))).toBe(true)
  })

  it('accepts a response with no continuation key (today)', () => {
    expect(isValidStartResponse(baseResponse(A))).toBe(true)
  })

  it.each([
    ['a non-object continuation', { conversation_url: null, continuation: 'INN' }],
    [
      'a continuation missing competency_code',
      { conversation_url: null, continuation: { conversation_id: CONV } },
    ],
    [
      'a continuation missing conversation_id',
      { conversation_url: null, continuation: { competency_code: 'INN' } },
    ],
    [
      'a competency_code that is prose',
      {
        conversation_url: null,
        continuation: { conversation_id: CONV, competency_code: 'begin INN now' },
      },
    ],
    [
      'a continuation combined with a conversation_url',
      { continuation: { conversation_id: CONV, competency_code: 'INN' } },
    ],
    [
      'a continuation combined with a provider_token',
      {
        conversation_url: null,
        provider_token: 'tok',
        continuation: { conversation_id: CONV, competency_code: 'INN' },
      },
    ],
    ['a non-string conversation_id', { conversation_id: 7 }],
  ])('rejects %s', (_label, extra) => {
    expect(isValidStartResponse(baseResponse(B, extra))).toBe(false)
  })
})

describe('single-session continuation flow', () => {
  it('serves three competencies from ONE provider, ONE player, and never reconnects', async () => {
    const states: string[] = []
    const session = await liveSession()
    watch(session.state, (s) => states.push(s), { flush: 'sync' })
    queue('/candidate/interview/end', END_CONTINUE, END_CONTINUE)
    queue('/candidate/interview/start', continuation(B, 'INN'), continuation(C, 'CSF'))

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(session.sessionId.value).toBe(B)
    expect(providers[0]!.sendBoundary).toHaveBeenCalledTimes(1)
    expect(providers[0]!.sendBoundary.mock.calls[0]![0]).toMatchObject({
      conversationId: CONV,
      competencyCode: 'INN',
    })

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(session.sessionId.value).toBe(C)
    expect(providers[0]!.sendBoundary).toHaveBeenCalledTimes(2)
    expect(mockCreateProvider).toHaveBeenCalledTimes(1)
    expect(session.players.value).toHaveLength(1)
    expect(states).not.toContain('connecting')
    expect(session.state.value).toBe('live')
    expect(ends().map((c) => (c[1] as { body: { session_id: number } }).body.session_id)).toEqual([
      A,
      B,
    ])
  })

  it('asserts the live conversation on /start only from the boundary', async () => {
    await liveSession()
    queue('/candidate/interview/end', END_CONTINUE)
    queue('/candidate/interview/start', continuation(B))

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(startBody(0)).toBeUndefined()
    expect(startBody(1)).toEqual({ live_conversation_id: CONV })
  })

  it('mutes BEFORE /end and unmutes only at the steering ack', async () => {
    const session = await liveSession()
    queue('/candidate/interview/end', END_CONTINUE)
    queue('/candidate/interview/start', continuation(B))
    let ack!: (r: SteeringResult) => void
    providers[0]!.sendBoundary.mockImplementationOnce(() => {
      log.push('send')
      return new Promise<SteeringResult>((resolve) => (ack = resolve))
    })
    log.length = 0

    providers[0]!._emit('state', 'complete')
    await flush()

    // Cursor already on B and the send out, but no ack yet: the mic is still closed.
    expect(session.sessionId.value).toBe(B)
    expect(log).toEqual(['mute', 'end', 'start', 'send'])

    ack({ ok: true })
    await flush()

    expect(log).toEqual(['mute', 'end', 'start', 'send', 'unmute'])
  })

  it('moves the cursor before the steering is sent', async () => {
    const session = await liveSession()
    queue('/candidate/interview/end', END_CONTINUE)
    queue('/candidate/interview/start', continuation(B))
    let sessionAtSend: number | null = null
    providers[0]!.sendBoundary.mockImplementationOnce(async () => {
      sessionAtSend = session.sessionId.value
      return { ok: true }
    })

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(sessionAtSend).toBe(B)
  })

  it('a response without continuation takes the fresh path unchanged', async () => {
    const session = await liveSession()
    queue('/candidate/interview/end', END_CONTINUE)
    queue('/candidate/interview/start', fresh(B))

    providers[0]!._emit('state', 'complete')
    await flush()

    // FE-06: a fresh handle arriving while a live one exists crossfades; the
    // old conversation is released when the new one has painted, not before.
    expect(mockCreateProvider).toHaveBeenCalledTimes(2)
    expect(providers[0]!.sendBoundary).not.toHaveBeenCalled()
    expect(session.state.value).toBe('live')
    expect(session.players.value.map((p) => p.role)).toEqual(['live', 'incoming'])
    expect(session.sessionId.value).toBe(A)
  })

  it('a Tavus handle that never named a conversation keeps today path (no mute, no assertion)', async () => {
    const session = await liveSession(baseResponse(A))
    queue('/candidate/interview/end', END_CONTINUE)
    queue('/candidate/interview/start', baseResponse(B))

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(providers[0]!.setMicMuted).not.toHaveBeenCalled()
    expect(startBody(1)).toBeUndefined()
    expect(mockCreateProvider).toHaveBeenCalledTimes(2)
    expect(session.sessionId.value).toBe(B)
  })

  it('a provider without context steering (mock/HeyGen shape) keeps today path', async () => {
    steerableProviders = false
    await liveSession()
    queue('/candidate/interview/end', END_CONTINUE)
    queue('/candidate/interview/start', baseResponse(B))

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(providers[0]!.setMicMuted).not.toHaveBeenCalled()
    expect(startBody(1)).toBeUndefined()
  })

  it('the 300 s timer routes through the same boundary (continue never tears the room down)', async () => {
    const session = await liveSession()
    queue('/candidate/interview/end', END_CONTINUE)
    queue('/candidate/interview/start', continuation(B))

    await session.endQuestion('timeout')
    await flush()

    expect(ends()[0]![1]).toMatchObject({ body: { session_id: A, ended_reason: 'timeout' } })
    expect(providers[0]!._stop).not.toHaveBeenCalled()
    expect(providers[0]!.sendBoundary).toHaveBeenCalledTimes(1)
    expect(session.sessionId.value).toBe(B)
  })

  it.each([
    ['a network error', () => new Thrown(new TypeError('Failed to fetch'))],
    ['a 5xx', () => new Thrown(Object.assign(new Error('boom'), { status: 503 }))],
  ])(
    'a non-409 /end failure (%s) restores the mic, frees the guard and advances nothing',
    async (_label, failure) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const session = await liveSession()
      queue('/candidate/interview/end', failure())
      queue('/candidate/interview/start', continuation(B))
      log.length = 0

      providers[0]!._emit('state', 'complete')
      await flush()

      // Degrades to the existing pause screen: no steering, no handle, cursor stays on A.
      expect(log).toEqual(['mute', 'end', 'unmute'])
      expect(starts()).toHaveLength(1)
      expect(providers[0]!.sendBoundary).not.toHaveBeenCalled()
      expect(mockCreateProvider).toHaveBeenCalledTimes(1)
      expect(session.sessionId.value).toBe(A)
      expect(session.state.value).toBe('end_of_question')

      // The in-flight guard was reset, so a later boundary is not locked out.
      expect(session.handoverInFlight.value).toBe(false)
    }
  )

  it('done after the last competency stops the provider and finishes', async () => {
    const session = await liveSession()
    queue('/candidate/interview/end', { next_action: 'done' })

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(session.state.value).toBe('done')
    expect(starts()).toHaveLength(1)
    expect(providers[0]!.sendBoundary).not.toHaveBeenCalled()
  })
})

describe('live_conversation_id is never sent without a joined handle', () => {
  it('not after a pause + resume (also the tab-hidden pause)', async () => {
    const session = await liveSession()
    queue('/candidate/interview/start', fresh(A))

    session.pause()
    session.resume()
    await flush()

    expect(startBody(1)).toBeUndefined()
  })

  it('not after retry() (also the embed re-entry)', async () => {
    const session = await liveSession()
    queue('/candidate/interview/start', fresh(A))

    session.retry()
    await flush()

    expect(startBody(1)).toBeUndefined()
  })

  it('not on a re-offer from the between-competencies screen', async () => {
    const session = await liveSession()
    queue('/candidate/interview/end', { next_action: 'pause' })
    queue('/candidate/interview/start', fresh(B))

    providers[0]!._emit('state', 'complete')
    await flush()
    expect(session.state.value).toBe('end_of_question')
    session.nextCompetency()
    await flush()

    expect(startBody(1)).toBeUndefined()
  })

  it('not on a reload (a new composable holds no handle)', async () => {
    await liveSession()
    const reloaded = useInterviewSession()
    reloaded.acceptConsent()
    queue('/candidate/interview/start', fresh(A))

    reloaded.confirmDevices()
    await flush()

    expect(startBody(1)).toBeUndefined()
  })
})

describe('assertBoundary', () => {
  it('racing inputs mint one ticket and one /end', async () => {
    const session = await liveSession()
    queue('/candidate/interview/end', END_CONTINUE)
    queue('/candidate/interview/start', continuation(B))

    providers[0]!._emit('state', 'complete')
    providers[0]!._emit('state', 'complete')
    void session.endQuestion('timeout')
    providers[0]!._emit('state', 'complete')
    await flush()

    expect(ends()).toHaveLength(1)
    expect(providers[0]!.sendBoundary).toHaveBeenCalledTimes(1)
    expect(session.sessionId.value).toBe(B)
  })

  it('a losing 409 is a no-op: no /start, no ticket, cursor unchanged, mic restored', async () => {
    const session = await liveSession()
    queue('/candidate/interview/end', new Thrown({ status: 409 }))

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(starts()).toHaveLength(1)
    expect(providers[0]!.sendBoundary).not.toHaveBeenCalled()
    expect(session.sessionId.value).toBe(A)
    expect(session.state.value).toBe('live')
    expect(log.at(-1)).toBe('unmute')
  })

  it('is usable again after it settled', async () => {
    const session = await liveSession()
    queue('/candidate/interview/end', new Thrown({ status: 409 }), END_CONTINUE)
    queue('/candidate/interview/start', continuation(B))

    providers[0]!._emit('state', 'complete')
    await flush()
    providers[0]!._emit('state', 'complete')
    await flush()

    expect(session.sessionId.value).toBe(B)
  })
})

describe('malformed continuation', () => {
  it.each([
    [
      'missing competency_code',
      { conversation_url: null, continuation: { conversation_id: CONV } },
    ],
    [
      'combined with a conversation_url',
      { continuation: { conversation_id: CONV, competency_code: 'INN' } },
    ],
  ])('%s shows the retryable error with no cursor move or send', async (_l, extra) => {
    const session = await liveSession()
    queue('/candidate/interview/end', END_CONTINUE)
    queue('/candidate/interview/start', baseResponse(B, extra))

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(session.state.value).toBe('error')
    expect(session.sessionId.value).toBe(A)
    expect(providers[0]!.sendBoundary).not.toHaveBeenCalled()
  })

  it('a continuation for a different conversation than the joined one is refused', async () => {
    const session = await liveSession()
    queue('/candidate/interview/end', END_CONTINUE)
    queue('/candidate/interview/start', continuation(B, 'INN', 'someone-else'))

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(session.state.value).toBe('error')
    expect(session.sessionId.value).toBe(A)
    expect(providers[0]!.sendBoundary).not.toHaveBeenCalled()
  })
})

describe('steering_failed handling', () => {
  it('unmutes, keeps the cursor and resends ONCE while joined', async () => {
    const session = await liveSession()
    queue('/candidate/interview/end', END_CONTINUE)
    queue('/candidate/interview/start', continuation(B))
    providers[0]!.sendBoundary
      .mockImplementationOnce(async () => {
        log.push('send')
        return { ok: false, reason: 'timeout' }
      })
      .mockImplementationOnce(async () => {
        log.push('send')
        return { ok: true }
      })
    log.length = 0

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(log).toEqual(['mute', 'end', 'start', 'send', 'unmute', 'send'])
    expect(providers[0]!.sendBoundary).toHaveBeenCalledTimes(2)
    expect(providers[0]!.sendBoundary.mock.calls[1]![0]).toBe(
      providers[0]!.sendBoundary.mock.calls[0]![0]
    )
    expect(ends()).toHaveLength(1)
    expect(session.sessionId.value).toBe(B)
    expect(session.state.value).toBe('live')
  })

  it('a second failure ends the NEW competency as timeout and re-issues fresh', async () => {
    const session = await liveSession()
    queue('/candidate/interview/end', END_CONTINUE, END_CONTINUE)
    queue('/candidate/interview/start', continuation(B), fresh(C))
    providers[0]!.sendBoundary.mockResolvedValue({ ok: false, reason: 'timeout' })

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(providers[0]!.sendBoundary).toHaveBeenCalledTimes(2)
    expect(providers[0]!._stop).toHaveBeenCalled()
    expect(ends()[1]![1]).toMatchObject({ body: { session_id: B, ended_reason: 'timeout' } })
    expect(startBody(2)).toBeUndefined()
    expect(session.sessionId.value).toBe(C)
    expect(mockCreateProvider).toHaveBeenCalledTimes(2)
  })

  it('a steering that cannot be sent (not joined) is not resent', async () => {
    await liveSession()
    queue('/candidate/interview/end', END_CONTINUE, { next_action: 'pause' })
    queue('/candidate/interview/start', continuation(B))
    providers[0]!.sendBoundary.mockResolvedValue({ ok: false, reason: 'not_joined' })

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(providers[0]!.sendBoundary).toHaveBeenCalledTimes(1)
    expect(ends()[1]![1]).toMatchObject({ body: { session_id: B, ended_reason: 'timeout' } })
  })
})
