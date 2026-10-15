/**
 * useInterviewSession — the candidate's microphone choice (live-interview-call-chrome, D9).
 *
 * The choice (`micMuted`) lives as long as the composable instance. Mutes owned
 * by the boundary and the handover win while they are in effect; every site
 * that reopens the uplink afterwards restores the candidate's choice instead of
 * unmuting unconditionally. Harness mirrors use-interview-session-continuation.spec.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'

const { mockCandidateFetch, mockCreateProvider } = vi.hoisted(() => ({
  mockCandidateFetch: vi.fn(),
  mockCreateProvider: vi.fn(),
}))

vi.mock('~/app/providers/factory', () => ({ createProvider: mockCreateProvider }))
vi.mock('~/app/utils/candidate-api', () => ({
  candidateFetch: mockCandidateFetch,
  flushIntegrityKeepalive: vi.fn(),
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
    setMicMuted: vi.fn(async (_muted: boolean) => undefined),
    nudgeWrapUp: vi.fn(),
    whenAvatarSilent: undefined as undefined | (() => Promise<void>),
    sendBoundary: vi.fn(async (): Promise<{ ok: true } | { ok: false; reason: string }> => ({
      ok: true,
    })),
    _emit(evt: string, payload: unknown) {
      for (const cb of listeners.get(evt) ?? []) cb(payload)
    },
  }
}

let providers: ReturnType<typeof createMockProvider>[] = []
const queues = new Map<string, unknown[]>()

class Thrown {
  constructor(readonly error: unknown) {}
}

function queue(path: string, ...responses: unknown[]) {
  queues.set(path, [...(queues.get(path) ?? []), ...responses])
}

const CONV = 'conv-1'
const END_CONTINUE = { next_action: 'continue', ended_competencies: 1, total_competencies: 3 }
const END_PAUSE = { next_action: 'pause', ended_competencies: 1, total_competencies: 3 }

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

/** A joined Tavus conversation (steerable, so the boundary path applies). */
const tavus = (sessionId = 42) => baseResponse(sessionId, { conversation_id: CONV })
const continuation = (sessionId: number) =>
  baseResponse(sessionId, {
    conversation_url: null,
    continuation: { conversation_id: CONV, competency_code: 'INN' },
  })
/** A HeyGen response: never steerable, so a `continue` runs the invisible handover. */
const heygen = (sessionId: number) =>
  baseResponse(sessionId, { provider: 'heygen', provider_token: 'tok', conversation_url: null })

async function flush() {
  for (let i = 0; i < 30; i++) await nextTick()
}

async function liveSession(first: unknown = tavus()) {
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

/** The values the uplink was last set to, in order. */
const calls = (p: ReturnType<typeof createMockProvider>) =>
  p.setMicMuted.mock.calls.map((c) => c[0])
const lastCall = (p: ReturnType<typeof createMockProvider>) => calls(p).at(-1)
const ends = () => mockCandidateFetch.mock.calls.filter((c) => c[0] === '/candidate/interview/end')

/** HeyGen handover up to the incoming's first paint, then through the crossfade. */
async function handoverToIncoming(session: Awaited<ReturnType<typeof liveSession>>) {
  queue('/candidate/interview/end', END_CONTINUE)
  queue('/candidate/interview/start', heygen(99))
  providers[0]!._emit('state', 'complete')
  await flush()
  session.notifyPainted(99)
  await vi.advanceTimersByTimeAsync(300)
  await flush()
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCandidateFetch.mockReset()
  queues.clear()
  providers = []
  mockCandidateFetch.mockImplementation(async (path: string) => {
    const next = queues.get(path)?.shift()
    if (next instanceof Thrown) throw next.error
    return next
  })
  vi.useFakeTimers()
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

describe('the candidate microphone choice', () => {
  it('starts unmuted, and a new instance (a reload) starts unmuted again', async () => {
    const session = await liveSession()
    expect(session.micMuted.value).toBe(false)

    session.setMicMuted(true)
    expect(session.micMuted.value).toBe(true)

    expect(useInterviewSession().micMuted.value).toBe(false)
  })

  it('mutes and unmutes the active provider, and never calls /end', async () => {
    const session = await liveSession()

    session.setMicMuted(true)
    session.setMicMuted(false)

    expect(calls(providers[0]!)).toEqual([true, false])
    expect(ends()).toHaveLength(0)
  })

  it('records the choice and touches no provider while a boundary has the mic', async () => {
    const session = await liveSession()
    let release!: () => void
    providers[0]!.whenAvatarSilent = () => new Promise<void>((resolve) => (release = resolve))
    queue('/candidate/interview/end', new Thrown({ status: 409 }))

    providers[0]!._emit('state', 'complete')
    await flush()
    expect(session.boundaryInFlight.value).toBe(true)
    providers[0]!.setMicMuted.mockClear()

    session.setMicMuted(true)
    expect(session.micMuted.value).toBe(true)
    expect(providers[0]!.setMicMuted).not.toHaveBeenCalled()

    release()
    await flush()
    // The losing /end reopens the uplink, to the choice made meanwhile.
    expect(lastCall(providers[0]!)).toBe(true)
  })
})

describe('the choice survives a boundary on one joined conversation', () => {
  it.each([
    ['muted', true],
    ['unmuted', false],
  ])('a lost /end race returns a candidate who was %s to that state', async (_l, muted) => {
    const session = await liveSession()
    session.setMicMuted(muted)
    queue('/candidate/interview/end', new Thrown({ status: 409 }))

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(calls(providers[0]!)).toEqual([muted, true, muted])
    expect(session.boundaryInFlight.value).toBe(false)
  })

  it.each([
    ['muted', true],
    ['unmuted', false],
  ])('a steering acknowledgement returns a candidate who was %s', async (_l, muted) => {
    const session = await liveSession()
    session.setMicMuted(muted)
    queue('/candidate/interview/end', END_CONTINUE)
    queue('/candidate/interview/start', continuation(77))

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(session.sessionId.value).toBe(77)
    expect(lastCall(providers[0]!)).toBe(muted)
    expect(session.micMuted.value).toBe(muted)
  })

  it('a failed steering still returns a muted candidate to muted, never unmuted', async () => {
    const session = await liveSession()
    session.setMicMuted(true)
    providers[0]!.sendBoundary.mockResolvedValueOnce({ ok: false, reason: 'left' })
    queue('/candidate/interview/end', END_CONTINUE, END_PAUSE)
    queue('/candidate/interview/start', continuation(77))

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(lastCall(providers[0]!)).toBe(true)
    expect(calls(providers[0]!)).not.toContain(false)
  })

  it('a pause directive at the boundary leaves a muted candidate muted', async () => {
    const session = await liveSession()
    session.setMicMuted(true)
    queue('/candidate/interview/end', END_PAUSE)

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(lastCall(providers[0]!)).toBe(true)
  })
})

describe('a choice made while the restore is in flight is not lost', () => {
  /** Hold the second uplink call (the restore after the forced mute) until released. */
  function holdRestore(p: ReturnType<typeof createMockProvider>) {
    let release!: () => void
    p.setMicMuted.mockImplementation((_muted: boolean) =>
      p.setMicMuted.mock.calls.length === 2
        ? new Promise<undefined>((resolve) => (release = () => resolve(undefined)))
        : Promise.resolve(undefined)
    )
    return () => release()
  }

  it('re-applies a toggle made during the restore after a lost /end race', async () => {
    const session = await liveSession()
    const release = holdRestore(providers[0]!)
    queue('/candidate/interview/end', new Thrown({ status: 409 }))

    providers[0]!._emit('state', 'complete')
    await flush()
    expect(calls(providers[0]!)).toEqual([true, false]) // forced mute, then the pending restore

    session.setMicMuted(true) // the candidate mutes while the restore is awaited
    release()
    await flush()

    expect(session.boundaryInFlight.value).toBe(false)
    expect(lastCall(providers[0]!)).toBe(true)
  })

  it('re-applies the LATEST of several toggles made during the restore', async () => {
    const session = await liveSession()
    const release = holdRestore(providers[0]!)
    queue('/candidate/interview/end', new Thrown({ status: 409 }))

    providers[0]!._emit('state', 'complete')
    await flush()
    session.setMicMuted(true)
    session.setMicMuted(false)
    release()
    await flush()

    expect(session.micMuted.value).toBe(false)
    expect(lastCall(providers[0]!)).toBe(false)
  })

  it('re-applies a toggle made during the steering-acknowledgement restore', async () => {
    const session = await liveSession()
    const release = holdRestore(providers[0]!)
    queue('/candidate/interview/end', END_CONTINUE)
    queue('/candidate/interview/start', continuation(77))

    providers[0]!._emit('state', 'complete')
    await flush()
    session.setMicMuted(true)
    release()
    await flush()

    expect(session.sessionId.value).toBe(77)
    expect(session.boundaryInFlight.value).toBe(false)
    expect(lastCall(providers[0]!)).toBe(true)
  })

  it('does not touch the provider again when nothing was toggled', async () => {
    await liveSession()
    queue('/candidate/interview/end', new Thrown({ status: 409 }))

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(calls(providers[0]!)).toEqual([true, false])
  })
})

describe('the choice survives an invisible handover', () => {
  it.each([
    ['muted', true],
    ['unmuted', false],
  ])('promotes the incoming session with a candidate who was %s', async (_l, muted) => {
    const session = await liveSession(heygen(42))
    session.setMicMuted(muted)

    await handoverToIncoming(session)

    expect(session.sessionId.value).toBe(99)
    expect(lastCall(providers[1]!)).toBe(muted)
    expect(session.micMuted.value).toBe(muted)
  })

  it.each([
    ['muted', true],
    ['unmuted', false],
  ])('a lost /end race returns a candidate who was %s', async (_l, muted) => {
    const session = await liveSession(heygen(42))
    session.setMicMuted(muted)
    queue('/candidate/interview/end', new Thrown({ status: 409 }))

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(calls(providers[0]!)).toEqual([muted, true, muted])
  })

  it('a pause directive during the handover leaves a muted candidate muted', async () => {
    const session = await liveSession(heygen(42))
    session.setMicMuted(true)
    queue('/candidate/interview/end', END_PAUSE)

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(lastCall(providers[0]!)).toBe(true)
  })

  it('records a choice made mid-handover without touching the outgoing, and applies it at promotion', async () => {
    const session = await liveSession(heygen(42))
    queue('/candidate/interview/end', END_CONTINUE)
    queue('/candidate/interview/start', heygen(99))
    providers[0]!._emit('state', 'complete')
    await flush()
    expect(session.handoverInFlight.value).toBe(true)
    providers[0]!.setMicMuted.mockClear()

    session.setMicMuted(true)
    expect(providers[0]!.setMicMuted).not.toHaveBeenCalled()

    session.notifyPainted(99)
    await vi.advanceTimersByTimeAsync(300)
    await flush()
    expect(lastCall(providers[1]!)).toBe(true)
  })
})
