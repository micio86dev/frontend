/**
 * useInterviewSession — attribution cursor (tavus-single-session-interview, FE-03).
 *
 * Today one handle serves one competency, so `handle.dbSessionId` and the cursor
 * are the same number and nothing observable changes. In the future single
 * conversation flow ONE handle serves several competency rows, so every reader
 * of "the current session id" must follow a moving cursor instead of the
 * handle's creation-time id. These tests move the cursor (the only way to make
 * the two diverge) and assert each reader follows it, and that the cursor is
 * written BEFORE any boundary signal reaches the provider.
 *
 * Harness mirrors use-interview-session.spec.ts (same mocks, same fixtures).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import type { IntegrityEventInternal } from '~/app/utils/proctor-config'
import { BoundarySendError } from '~/app/utils/attribution-cursor'

const { mockCandidateFetch, mockFlushIntegrityKeepalive, mockCreateProvider } = vi.hoisted(() => {
  class MockCandidateUnauthorizedError extends Error {}
  return {
    mockCandidateFetch: vi.fn(),
    mockFlushIntegrityKeepalive: vi.fn(),
    mockCreateProvider: vi.fn(),
    MockCandidateUnauthorizedError,
  }
})

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
  return {
    on: vi.fn((evt: string, cb: EventCallback) => {
      listeners.set(evt, [...(listeners.get(evt) ?? []), cb])
    }),
    start: vi.fn(async () => ({ providerSessionId: 'p' })),
    stop: vi.fn(async () => undefined),
    toggleMic: vi.fn(async () => undefined),
    setMicMuted: vi.fn(async () => undefined),
    nudgeWrapUp: vi.fn(),
    _emit(evt: string, payload: unknown) {
      for (const cb of listeners.get(evt) ?? []) cb(payload)
    },
  }
}

let providers: ReturnType<typeof createMockProvider>[] = []
const mockNavigateTo = vi.fn()

function startResponse(sessionId: number, provider = 'tavus') {
  return {
    session_id: sessionId,
    provider,
    provider_token: 'tok',
    conversation_url: null,
    audio_only: false,
    question_context: {
      competency_code: 'PRS',
      question_index: 0,
      end_phrase: 'Passiamo alla prossima domanda.',
      final_phrase: 'Grazie.',
    },
  }
}

const A = 42 // the handle's creation-time id
const B = 77 // the competency row the cursor moves to
const C = 103 // a second hop: A -> B -> C

async function flush() {
  for (let i = 0; i < 20; i++) await nextTick()
}

async function liveSession(options: Parameters<typeof useInterviewSession>[0] = {}) {
  const session = useInterviewSession(options)
  session.acceptConsent()
  mockCandidateFetch.mockResolvedValueOnce(startResponse(A))
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

function utterances(): Array<[number, string]> {
  return callsTo('/candidate/interview/utterance').map((c: unknown[]) => {
    const body = (c[1] as { body: { session_id: number; text: string } }).body
    return [body.session_id, body.text]
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCandidateFetch.mockReset()
  mockFlushIntegrityKeepalive.mockReset()
  mockCandidateFetch.mockResolvedValue(undefined)
  vi.useFakeTimers()
  providers = []
  mockCreateProvider.mockImplementation(() => {
    const p = createMockProvider()
    providers.push(p)
    return p
  })
  vi.stubGlobal('navigateTo', mockNavigateTo)
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useInterviewSession — attribution cursor readers', () => {
  it('sessionId starts on the handle id and follows the cursor', async () => {
    const session = await liveSession()
    expect(session.sessionId.value).toBe(A)

    session.advanceAttribution(B)

    expect(session.sessionId.value).toBe(B)
  })

  it('/end (avatar complete) is posted for the cursor, not the handle id', async () => {
    const session = await liveSession()
    session.advanceAttribution(B)
    mockCandidateFetch.mockResolvedValueOnce({ next_action: 'done' })

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(callsTo('/candidate/interview/end')[0]![1]).toMatchObject({ body: { session_id: B } })
  })

  it('/end (endQuestion timer) is posted for the cursor', async () => {
    const session = await liveSession()
    session.advanceAttribution(B)
    mockCandidateFetch.mockResolvedValueOnce({ next_action: 'done' })

    await session.endQuestion('timeout')

    expect(callsTo('/candidate/interview/end')[0]![1]).toMatchObject({ body: { session_id: B } })
  })

  it('/suspend (pause) is posted for the cursor', async () => {
    const session = await liveSession()
    session.advanceAttribution(B)

    session.pause()
    await flush()

    expect(callsTo('/candidate/interview/suspend')[0]![1]).toMatchObject({
      body: { session_id: B },
    })
  })

  it('a transcript line reads the cursor at EMIT time', async () => {
    const session = await liveSession()
    providers[0]!._emit('transcript', { role: 'user', text: 'before', ts: 1 })
    session.advanceAttribution(B)
    providers[0]!._emit('transcript', { role: 'user', text: 'after', ts: 2 })
    await flush()

    expect(utterances()).toEqual([
      [A, 'before'],
      [B, 'after'],
    ])
  })

  it('the resize integrity flush is addressed to the cursor', async () => {
    const pending: IntegrityEventInternal[] = [
      { type: 'tab_hidden', ts: 1 } as IntegrityEventInternal,
    ]
    const session = await liveSession({ getPendingIntegrityEvents: () => pending })
    session.advanceAttribution(B)
    mockFlushIntegrityKeepalive.mockClear()

    const listener = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'resize'
    )![1] as () => void
    ;(window as unknown as { innerWidth: number }).innerWidth = 800
    listener()

    expect(mockFlushIntegrityKeepalive).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: B })
    )
  })

  it('without a move, every reader keeps using the handle id (no behaviour change)', async () => {
    await liveSession()
    providers[0]!._emit('transcript', { role: 'user', text: 'x', ts: 1 })
    // Queued after the transcript so the /utterance call does not consume it.
    mockCandidateFetch.mockResolvedValueOnce({ next_action: 'done' })
    providers[0]!._emit('state', 'complete')
    await flush()

    expect(utterances()).toEqual([[A, 'x']])
    expect(callsTo('/candidate/interview/end')[0]![1]).toMatchObject({ body: { session_id: A } })
  })
})

describe('useInterviewSession — cursor-before-send ordering', () => {
  it('writes the cursor BEFORE the boundary signal reaches the provider', async () => {
    const session = await liveSession()
    const recorder: string[] = []
    const sendBoundary = vi.fn(() => {
      recorder.push(`send(sessionId=${session.sessionId.value})`)
    })

    recorder.push(`before(sessionId=${session.sessionId.value})`)
    session.advanceAttribution(B, sendBoundary)

    expect(recorder).toEqual([`before(sessionId=${A})`, `send(sessionId=${B})`])
    expect(sendBoundary).toHaveBeenCalledTimes(1)
    expect(sendBoundary).toHaveBeenCalledWith(expect.objectContaining({ sessionId: B }))
  })

  it('flushes unsent integrity events against the OUTGOING row before the cursor moves', async () => {
    const pending: IntegrityEventInternal[] = [
      { type: 'tab_hidden', ts: 1 } as IntegrityEventInternal,
    ]
    const onFlushed = vi.fn()
    const session = await liveSession({
      getPendingIntegrityEvents: () => pending,
      onIntegrityEventsFlushed: onFlushed,
    })
    const recorder: string[] = []
    mockFlushIntegrityKeepalive.mockImplementation((p: { session_id: number }) => {
      recorder.push(`flush(session_id=${p.session_id},cursor=${session.sessionId.value})`)
    })

    session.advanceAttribution(B, () => recorder.push('send'))

    expect(recorder).toEqual([`flush(session_id=${A},cursor=${A})`, 'send'])
    expect(onFlushed).toHaveBeenCalledWith(pending)
    expect(session.sessionId.value).toBe(B)
  })

  it('with no pending integrity events nothing is flushed', async () => {
    const session = await liveSession({ getPendingIntegrityEvents: () => [] })
    mockFlushIntegrityKeepalive.mockClear()

    session.advanceAttribution(B)

    expect(mockFlushIntegrityKeepalive).not.toHaveBeenCalled()
  })

  it('is a no-op (no cursor move, no signal) when no handle is live', async () => {
    const session = useInterviewSession()
    const sendBoundary = vi.fn()

    expect(session.advanceAttribution(B, sendBoundary)).toBeNull()
    expect(sendBoundary).not.toHaveBeenCalled()
    expect(session.sessionId.value).toBeNull()
  })
})

describe('useInterviewSession — advanceAttribution failure modes', () => {
  it('a throwing sendBoundary leaves the cursor advanced and rethrows with the ticket attached', async () => {
    const session = await liveSession()
    const boom = new Error('data channel closed')

    let thrown: unknown
    try {
      session.advanceAttribution(B, () => {
        throw boom
      })
    } catch (err) {
      thrown = err
    }

    // Not swallowed, and recoverable: the minted ticket and the original error
    // both travel on the thrown value.
    expect(thrown).toBeInstanceOf(BoundarySendError)
    const failure = thrown as BoundarySendError
    expect(failure.ticket.sessionId).toBe(B)
    expect(failure.cause).toBe(boom)
    expect(failure.message).toContain('data channel closed')

    // Write-before-send is the rule: the move is irreversible, so a failed send
    // does not roll it back. Every reader keeps following the new row.
    expect(session.sessionId.value).toBe(B)
    providers[0]!._emit('transcript', { role: 'user', text: 'after the failed send', ts: 3 })
    await flush()
    expect(utterances()).toEqual([[B, 'after the failed send']])
  })

  it('wraps a non-Error throw too, keeping it as the cause', async () => {
    const session = await liveSession()

    let thrown: unknown
    try {
      session.advanceAttribution(B, () => {
        throw 'plain string'
      })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(BoundarySendError)
    expect((thrown as BoundarySendError).cause).toBe('plain string')
    expect((thrown as BoundarySendError).ticket.sessionId).toBe(B)
  })

  it('an invalid next id is refused BEFORE anything is flushed, moved or sent', async () => {
    const pending: IntegrityEventInternal[] = [
      { type: 'tab_hidden', ts: 1 } as IntegrityEventInternal,
    ]
    const onFlushed = vi.fn()
    const session = await liveSession({
      getPendingIntegrityEvents: () => pending,
      onIntegrityEventsFlushed: onFlushed,
    })
    mockFlushIntegrityKeepalive.mockClear()
    const sendBoundary = vi.fn()

    expect(() => session.advanceAttribution(0, sendBoundary)).toThrow(RangeError)

    expect(mockFlushIntegrityKeepalive).not.toHaveBeenCalled()
    expect(onFlushed).not.toHaveBeenCalled()
    expect(sendBoundary).not.toHaveBeenCalled()
    expect(session.sessionId.value).toBe(A)
  })
})

describe('useInterviewSession — multi-hop cursor (A -> B -> C)', () => {
  /** Stays pending on every hop: the getter returns it again until it is acknowledged. */
  const pendingEvent = () => [{ type: 'tab_hidden', ts: 1 } as IntegrityEventInternal]

  it('every reader follows each hop and each integrity flush is addressed to the OUTGOING row', async () => {
    const flushedTo: Array<number | null> = []
    mockFlushIntegrityKeepalive.mockImplementation((p: { session_id: number | null }) => {
      flushedTo.push(p.session_id)
    })
    const pending = pendingEvent()
    const session = await liveSession({ getPendingIntegrityEvents: () => pending })
    const emit = (text: string) =>
      providers[0]!._emit('transcript', { role: 'user', text, ts: Date.now() })

    emit('on A')
    session.advanceAttribution(B)
    expect(session.sessionId.value).toBe(B)
    emit('on B')
    session.advanceAttribution(C)
    expect(session.sessionId.value).toBe(C)
    emit('on C')
    await flush()

    // Hop 1 flushed against A (outgoing) and hop 2 against B (outgoing) — never
    // against the row the cursor was moving TO.
    expect(flushedTo).toEqual([A, B])
    expect(utterances()).toEqual([
      [A, 'on A'],
      [B, 'on B'],
      [C, 'on C'],
    ])

    // /end follows the last hop, not any earlier row.
    mockCandidateFetch.mockResolvedValueOnce({ next_action: 'done' })
    providers[0]!._emit('state', 'complete')
    await flush()
    expect(callsTo('/candidate/interview/end')).toHaveLength(1)
    expect(callsTo('/candidate/interview/end')[0]![1]).toMatchObject({ body: { session_id: C } })
  })

  it('/suspend follows the last hop', async () => {
    const session = await liveSession()
    session.advanceAttribution(B)
    session.advanceAttribution(C)

    session.pause()
    await flush()

    expect(callsTo('/candidate/interview/suspend')).toHaveLength(1)
    expect(callsTo('/candidate/interview/suspend')[0]![1]).toMatchObject({
      body: { session_id: C },
    })
  })
})

describe('useInterviewSession — attribution tape across a cursor move', () => {
  it('[u1(A), end, u2(window), u3(B)] posts exactly the expected (session_id, text) multiset', async () => {
    const session = await liveSession()
    const provider = providers[0]!
    const emit = (role: 'user' | 'avatar', text: string) =>
      provider._emit('transcript', { role, text, ts: Date.now() })

    emit('user', 'u1 answer on A') // u1 — before the move: row A
    emit('avatar', 'Passiamo alla prossima domanda.') // end — the closing line is still A's
    session.advanceAttribution(B, () => {
      // u2 — fires inside the window: after the cursor write, before the signal
      // reaches the provider. It belongs to the NEW row, never the old one.
      emit('user', 'u2 inside the window')
    })
    emit('avatar', 'u3 opening of B') // u3 — after the move: row B
    await flush()

    const sortKey = (p: [number, string]) => `${p[0]}|${p[1]}`
    expect(utterances().sort((x, y) => sortKey(x).localeCompare(sortKey(y)))).toEqual(
      (
        [
          [A, 'u1 answer on A'],
          [A, 'Passiamo alla prossima domanda.'],
          [B, 'u2 inside the window'],
          [B, 'u3 opening of B'],
        ] as Array<[number, string]>
      ).sort((x, y) => sortKey(x).localeCompare(sortKey(y)))
    )
  })

  it('/end for the outgoing row is posted for A while the cursor is still on A', async () => {
    const session = await liveSession()
    mockCandidateFetch.mockResolvedValueOnce({ next_action: 'continue' })
    // endQuestion on a live Tavus handle: /end(A) with the cursor still on A.
    await session.endQuestion('timeout')

    expect(callsTo('/candidate/interview/end')).toHaveLength(1)
    expect(callsTo('/candidate/interview/end')[0]![1]).toMatchObject({ body: { session_id: A } })
  })
})
