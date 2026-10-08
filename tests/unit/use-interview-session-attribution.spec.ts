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
