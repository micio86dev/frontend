/**
 * useInterviewSession — state machine unit tests (Task 3.1 RED)
 *
 * Coverage targets (~95% on the state machine):
 *   - All state transitions: idle→device_check→connecting→live→end_of_question→paused→done/error/terminal
 *   - 429 provider_busy retry: 3 total attempts (1 initial + 2 retries), 3s backoff
 *   - 409 silent-drop from /end and /utterance
 *   - 403 terminal redirect (no retry)
 *   - 502 retryable error
 *   - Resume-on-remount guard
 *   - Last-competency detection (question_index + 1 >= total_competency_count → done)
 *   - Absent end_phrase / final_phrase → terminal
 *   - Resize listener teardown on done/terminal/error
 *   - nested question_context.end_phrase vs top-level response.end_phrase disambiguation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before any other imports using vi.hoisted
// ---------------------------------------------------------------------------

const {
  mockCandidateFetch,
  mockFlushIntegrityKeepalive,
  mockCreateProvider,
  mockClearSession,
  MockCandidateUnauthorizedError,
} = vi.hoisted(() => {
  const mockCandidateFetch = vi.fn()
  const mockFlushIntegrityKeepalive = vi.fn()
  const mockCreateProvider = vi.fn()
  const mockClearSession = vi.fn()
  // A real class (not just a spy) — useInterviewSession does `instanceof`
  // checks against this, so the test and the source must share the exact
  // same class reference via the mocked module.
  class MockCandidateUnauthorizedError extends Error {
    constructor(message = 'Candidate session unauthorized') {
      super(message)
      this.name = 'CandidateUnauthorizedError'
    }
  }
  return {
    mockCandidateFetch,
    mockFlushIntegrityKeepalive,
    mockCreateProvider,
    mockClearSession,
    MockCandidateUnauthorizedError,
  }
})

// Mock the provider factory BEFORE importing the composable
vi.mock('~/app/providers/factory', () => ({
  createProvider: mockCreateProvider,
}))

// useInterviewSession is migrated onto the single authenticated transport
// (D-B/D-C, Task 1.6/1.9) — mock candidate-api directly instead of raw ofetch.
vi.mock('~/app/utils/candidate-api', () => ({
  candidateFetch: mockCandidateFetch,
  flushIntegrityKeepalive: mockFlushIntegrityKeepalive,
  CandidateUnauthorizedError: MockCandidateUnauthorizedError,
}))

// Verification finding #1: the candidate session MUST be cleared on every
// terminal/done transition, not just the 401 path (candidateFetch already
// clears on 401 internally — this mock proves useInterviewSession ALSO
// clears directly, defense in depth, for 403/absent_phrase/malformed_response/done).
vi.mock('~/app/composables/useCandidateSession', () => ({
  useCandidateSession: () => ({ clear: mockClearSession, read: vi.fn(), store: vi.fn() }),
}))

// eslint-disable-next-line import/first
import { useInterviewSession } from '~/app/composables/useInterviewSession'

// ---------------------------------------------------------------------------
// Mock provider type
// ---------------------------------------------------------------------------

type EventCallback = (payload: unknown) => void

function createMockProvider() {
  const listeners = new Map<string, EventCallback[]>()
  const startMock = vi.fn(async () => ({ providerSessionId: 'test-session-id' }))
  const stopMock = vi.fn(async () => undefined)
  const toggleMicMock = vi.fn(async () => undefined)
  const setMicMutedMock = vi.fn(async (_muted: boolean) => undefined)

  function emit(evt: string, eventPayload: unknown) {
    for (const cb of listeners.get(evt) ?? []) cb(eventPayload)
  }

  return {
    on: vi.fn((evt: string, cb: EventCallback) => {
      listeners.set(evt, [...(listeners.get(evt) ?? []), cb])
    }),
    start: startMock,
    stop: stopMock,
    toggleMic: toggleMicMock,
    setMicMuted: setMicMutedMock,
    nudgeWrapUp: vi.fn(),
    // Test helper to emit events
    _emit: emit,
    _startMock: startMock,
    _stopMock: stopMock,
  }
}

let currentMockProvider: ReturnType<typeof createMockProvider>

/**
 * F4 fix — the harness prerequisite this whole change is blocked on.
 *
 * `mockCreateProvider` used to return the SAME `currentMockProvider` object
 * for every `createProvider()` call within a test (it was created once, in
 * beforeEach, before any session code ran). Under a single-session model
 * that was invisible: `useInterviewSession` only ever called `createProvider()`
 * once per test. Under the handover, it is called TWICE in the same test (the
 * outgoing, then the incoming) — and with the old wiring, "outgoing" and
 * "incoming" were literally `.toBe()` the same object, so no assertion about
 * event identity (D2) could ever fail for the right reason.
 *
 * Every call now mints a FRESH mock instance and appends it to
 * `mockProviderRegistry`, in creation order — `mockProviderRegistry[0]` is
 * always the outgoing handle, `[1]` the incoming. `currentMockProvider` keeps
 * tracking "the most recently created" one, so every EXISTING single-session
 * test in this file (which only ever calls `createProvider()` once) is
 * unaffected.
 */
let mockProviderRegistry: ReturnType<typeof createMockProvider>[] = []

function registerFreshMockProvider() {
  const instance = createMockProvider()
  mockProviderRegistry.push(instance)
  currentMockProvider = instance
  return instance
}

mockCreateProvider.mockImplementation(() => registerFreshMockProvider())

// Mock navigateTo
const mockNavigateTo = vi.fn()
vi.stubGlobal('navigateTo', mockNavigateTo)

// ---------------------------------------------------------------------------
// Default /start 201 response fixture
// ---------------------------------------------------------------------------

function makeStartResponse(
  overrides: {
    question_index?: string
    end_phrase?: string
    final_phrase?: string
    competency_code?: string
    provider?: string
    session_id?: string
  } = {}
) {
  return {
    session_id: overrides.session_id ?? '42',
    provider: overrides.provider ?? 'heygen',
    provider_token: 'tok-123',
    conversation_url: null,
    question_context: {
      competency_code: overrides.competency_code ?? 'PRS',
      question_index: overrides.question_index ?? '0',
      end_phrase: overrides.end_phrase ?? 'Passiamo alla prossima domanda.',
      final_phrase: overrides.final_phrase ?? 'Grazie per il tuo tempo.',
    },
  }
}

// Default competency list (5 items — question_index 0–4)
const DEFAULT_COMPETENCIES = ['PRS', 'STG', 'INN', 'JDG', 'DRV']

// Snapshot interval mirror of the composable constant (10s)
const SNAPSHOT_INTERVAL_MS_TEST = 10_000

// ---------------------------------------------------------------------------
// Test helpers for fake errors
// ---------------------------------------------------------------------------

function makeFetchError(status: number) {
  const err = new Error(`HTTP ${status}`) as Error & { status: number; statusCode: number }
  err.status = status
  err.statusCode = status
  return err
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks calls mockClear(), which resets recorded calls but NOT the
  // queue left by mockResolvedValueOnce/mockRejectedValueOnce. Any value a test
  // queued and did not consume therefore leaked into the next one — and a RED
  // test queues for behaviour that does not exist yet, so it leaks by
  // construction. That produced a dozen failures in tests nobody had touched,
  // each one an off-by-one against its neighbour's fixture.
  mockCandidateFetch.mockReset()
  vi.useFakeTimers()
  mockProviderRegistry = []
  // Re-wire after clearAllMocks (which resets mockImplementation) — see the
  // F4 comment above registerFreshMockProvider().
  mockCreateProvider.mockImplementation(() => registerFreshMockProvider())
  mockNavigateTo.mockReset()

  // Re-stub navigateTo (afterEach calls vi.unstubAllGlobals, so we must re-stub each time)
  vi.stubGlobal('navigateTo', mockNavigateTo)

  // Re-stub useRuntimeConfig after vi.clearAllMocks() clears the setup.ts stub
  vi.stubGlobal(
    'useRuntimeConfig',
    vi.fn(() => ({
      public: { apiBase: 'https://api.test', interviewProviderMock: 'false' },
    }))
  )

  // Stub window with tracking for resize listener
  vi.stubGlobal('window', {
    innerWidth: 1280,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })

  // Stub navigator.sendBeacon
  vi.stubGlobal('navigator', {
    sendBeacon: vi.fn(() => true),
    userAgent: 'Chrome/120',
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Flush micro-tasks and pending promises without running all timers
// (runAllTimersAsync causes infinite loop with setInterval in snapshot/integrity cadence)
async function flushPromises() {
  // Flush microtasks via multiple nextTick cycles
  for (let i = 0; i < 5; i++) {
    await nextTick()
  }
}

// Create a session and advance to live state
async function createLiveSession(
  questionIndex = '0',
  competencies = DEFAULT_COMPETENCIES,
  audioDeviceId?: string
) {
  const session = useInterviewSession({ competencies })
  session.acceptConsent()

  mockCandidateFetch.mockResolvedValueOnce(makeStartResponse({ question_index: questionIndex }))
  session.confirmDevices(audioDeviceId)
  await nextTick()

  // Provider emits ready
  currentMockProvider._emit('state', 'ready')
  await nextTick()

  return session
}

/**
 * Both sessions healthy and live at once — the common overlap window.
 *
 * Module-scoped (not local to a single describe block) — several
 * post-review-restructuring suites (observability, B2, M1) need the same
 * "two healthy sessions overlapping" fixture the original D2 event-identity
 * suite established.
 */
describe('boundary-window utterance loss', () => {
  it('the avatar closing line is persisted BEFORE /end is called', async () => {
    // The closing sentence is the phrase that MARKS the boundary, and it was
    // the one most likely to be lost: `transcript` fired sendUtterance() as
    // fire-and-forget, `complete` fired callEnd() immediately after, the
    // server flipped the row out of `in_corso`, and the still-in-flight POST
    // came back 409 — which the client swallows without even a warning.
    //
    // Asserted as an ORDERING, not as "the call happened": a test that only
    // checked /utterance was called would pass against the losing code, since
    // it IS called — it just loses the race.
    const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
    const provider = mockProviderRegistry[0]!

    let releaseUtterance!: () => void
    const utteranceInFlight = new Promise<void>((resolve) => {
      releaseUtterance = () => resolve()
    })
    mockCandidateFetch.mockImplementation((url: string) => {
      if (url === '/candidate/interview/utterance') return utteranceInFlight
      if (url === '/candidate/interview/end') {
        return Promise.resolve({
          ended_competencies: 1,
          total_competencies: 3,
          next_action: 'done',
        })
      }
      return Promise.resolve(undefined)
    })

    provider._emit('transcript', {
      role: 'avatar',
      text: 'Passiamo alla prossima domanda.',
      ts: Date.now(),
    })
    provider._emit('state', 'complete')
    await flushPromises()

    const endCalled = () =>
      mockCandidateFetch.mock.calls.some((c: unknown[]) => c[0] === '/candidate/interview/end')

    expect(
      mockCandidateFetch.mock.calls.some(
        (c: unknown[]) => c[0] === '/candidate/interview/utterance'
      )
    ).toBe(true)
    expect(endCalled()).toBe(false)

    releaseUtterance()
    // Twice: the drain adds an await hop between the utterance settling and
    // callEnd resuming, so one flush lands in the middle of it.
    await flushPromises()
    await flushPromises()

    expect(endCalled()).toBe(true)
    expect(session).toBeDefined()
  })
})

async function beginHealthyHeyGenOverlap() {
  const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
  const outgoing = mockProviderRegistry[0]!

  mockCandidateFetch.mockResolvedValueOnce({
    ended_competencies: 1,
    total_competencies: 3,
    next_action: 'continue',
  })
  // A DISTINCT session_id from the outgoing's (42) — a test that reused
  // the same id for both would pass even with the contamination bug,
  // since "wrong" and "right" would be indistinguishable numbers.
  mockCandidateFetch.mockResolvedValueOnce(
    makeStartResponse({ question_index: '1', provider: 'heygen', session_id: '99' })
  )

  outgoing._emit('state', 'complete')
  await flushPromises()

  const incoming = mockProviderRegistry[1]!
  return { session, outgoing, incoming }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useInterviewSession', () => {
  describe('initial state', () => {
    it('starts in idle state', () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      expect(session.state.value).toBe('idle')
    })

    it('exposes required reactive properties', () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      expect(session.state).toBeDefined()
      expect(session.retryAttemptCount).toBeDefined()
      expect(session.currentCompetencyIndex).toBeDefined()
      expect(session.terminalReason).toBeDefined()
      expect(session.acceptConsent).toBeTypeOf('function')
      expect(session.confirmDevices).toBeTypeOf('function')
      expect(session.pause).toBeTypeOf('function')
      expect(session.resume).toBeTypeOf('function')
      expect(session.retry).toBeTypeOf('function')
      expect(session.nextCompetency).toBeTypeOf('function')
      expect(session.teardown).toBeTypeOf('function')
    })
  })

  describe('acceptConsent()', () => {
    it('transitions idle → device_check', () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()
      expect(session.state.value).toBe('device_check')
    })
  })

  describe('confirmDevices() → /start', () => {
    it('transitions device_check → connecting immediately', () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())

      session.confirmDevices()

      // connecting is set synchronously before the async /start call resolves
      expect(session.state.value).toBe('connecting')
    })

    it('transitions connecting → live when provider emits ready', async () => {
      const session = await createLiveSession()
      expect(session.state.value).toBe('live')
    })

    it('calls candidateFetch with the /candidate/interview/start endpoint', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())

      session.confirmDevices()
      await nextTick()

      // candidateFetch resolves the URL internally (D-B) — the caller passes
      // the API-relative path, not a pre-built absolute URL.
      expect(mockCandidateFetch).toHaveBeenCalledWith(
        '/candidate/interview/start',
        expect.any(Object)
      )
    })
  })

  describe('isMock() env-var coercion (C10 PR7 regression)', () => {
    it('NUXT_PUBLIC_INTERVIEW_PROVIDER_MOCK as a real boolean true (Nitro destr coercion) → mock provider used', async () => {
      // Nuxt/Nitro coerces NUXT_PUBLIC_* env values via destr at runtime, so a real
      // deployment exposes the BOOLEAN `true` here, not the string 'true' the
      // Vitest stubs elsewhere in this file use. A strict `=== 'true'` string
      // comparison silently never activates the mock provider in a real build.
      vi.stubGlobal(
        'useRuntimeConfig',
        vi.fn(() => ({
          public: { apiBase: 'https://api.test', interviewProviderMock: true },
        }))
      )

      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())

      session.confirmDevices()
      await nextTick()

      expect(mockCreateProvider).toHaveBeenCalledWith('heygen', true)
    })
  })

  describe('end_phrase / final_phrase nested path consumption (D4 critical)', () => {
    it('reads end_phrase from question_context NOT from top-level response', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()

      // Response with end_phrase ONLY inside question_context (correct path)
      // A stale top-level end_phrase field should NOT be picked up
      const response = {
        session_id: '42',
        provider: 'heygen',
        provider_token: 'tok-123',
        conversation_url: null,
        // stale top-level field — MUST NOT be used (design note: destructure from question_context)
        question_context: {
          competency_code: 'PRS',
          question_index: '0',
          end_phrase: 'Nested phrase correct.',
          final_phrase: 'Grazie per il tuo tempo.',
        },
      }

      mockCandidateFetch.mockResolvedValueOnce(response)
      session.confirmDevices()
      await nextTick()

      // The composable publishes the StartConfig; AvatarPlayer is what calls
      // provider.start() with it, against the real <video> element.
      expect(session.activeConfig.value).toMatchObject({
        endPhrase: 'Nested phrase correct.',
        finalPhrase: 'Grazie per il tuo tempo.',
      })
    })

    it('absent end_phrase (provider emits error) → terminal state', async () => {
      const session = await createLiveSession()

      // Provider detects absent phrase and emits error
      currentMockProvider._emit('error', 'absent_phrase')
      await nextTick()

      expect(session.state.value).toBe('terminal')
      expect(session.terminalReason.value).toBe('absent_phrase')
    })
  })

  describe('provider complete → /end → end_of_question / done', () => {
    it('provider emits complete → calls POST /end with ended_reason=completed', async () => {
      await createLiveSession()

      mockCandidateFetch.mockResolvedValueOnce(undefined) // /end 200

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      const endCall = mockCandidateFetch.mock.calls.find((c) => c[0] === '/candidate/interview/end')
      expect(endCall).toBeDefined()
      expect((endCall![1] as { body: { ended_reason: string } }).body.ended_reason).toBe(
        'completed'
      )
    })

    it('/end 200 with competencies remaining → state end_of_question', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      mockCandidateFetch.mockResolvedValueOnce(undefined) // /end 200

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('end_of_question')
    })

    it('/end says done on the last competency → state done', async () => {
      // Superseded by D11: this used to assert client-side last-competency
      // detection from `question_index + 1 >= competencies.length`. That
      // comparison ran against a list the page never filled, so it was `0 >= 0`
      // and ended every interview after one question. The server decides now.
      const session = await createLiveSession('4', DEFAULT_COMPETENCIES)

      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 5,
        total_competencies: 5,
        next_action: 'done',
      })

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('done')
    })

    it('/end 409 causes NO transition — the race loser must not act', async () => {
      // Superseded by D11. It used to advance to `end_of_question`, which was
      // harmless only because both racers advanced to the same place. Under a
      // directive-driven machine the loser has no directive, and the winner is
      // already advancing.
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      mockCandidateFetch.mockRejectedValueOnce(makeFetchError(409))

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('live')
    })
  })

  describe('/utterance 409 silent drop', () => {
    it('409 from /utterance is silently ignored; session state unchanged', async () => {
      const session = await createLiveSession()

      // Transcript triggers /utterance call which returns 409
      mockCandidateFetch.mockRejectedValueOnce(makeFetchError(409))

      currentMockProvider._emit('transcript', { role: 'candidate', text: 'Hello', ts: Date.now() })
      await flushPromises()

      expect(session.state.value).toBe('live')
    })
  })

  describe("/snapshot is NOT this composable's responsibility", () => {
    it('never issues a /snapshot request, at any point in the session', async () => {
      const session = await createLiveSession()

      // The old implementation scheduled sendSnapshot() every 10s for the whole
      // session. sendSnapshot()'s body was entirely comments, so the interval, its
      // 413/422 catch handler and the docblock's "5-endpoint loop" claim were all
      // machinery around a call that could never happen — the composable holds no
      // video element to capture from. useProctor.takeSnapshot() is the real path.
      await vi.advanceTimersByTimeAsync(SNAPSHOT_INTERVAL_MS_TEST * 6)
      await nextTick()

      const snapshotCalls = mockCandidateFetch.mock.calls.filter((c) =>
        String(c[0]).includes('/candidate/interview/snapshot')
      )
      expect(snapshotCalls).toHaveLength(0)
      expect(session.state.value).toBe('live')
    })
  })

  describe('429 retry + backoff', () => {
    it('429 on attempt 1 → state stays connecting; after 3s retries and succeeds', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()

      // Attempt 1: 429 | Attempt 2: 201 success
      mockCandidateFetch
        .mockRejectedValueOnce(makeFetchError(429))
        .mockResolvedValueOnce(makeStartResponse())

      session.confirmDevices()
      await nextTick()

      // State is still connecting while waiting for backoff
      expect(session.state.value).toBe('connecting')

      // Fast-forward 3s backoff
      await vi.advanceTimersByTimeAsync(3000)
      await nextTick()

      currentMockProvider._emit('state', 'ready')
      await nextTick()

      expect(session.state.value).toBe('live')
    })

    it('429 on all 3 attempts → state error; retryAttemptCount reset to 0', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()

      mockCandidateFetch
        .mockRejectedValueOnce(makeFetchError(429))
        .mockRejectedValueOnce(makeFetchError(429))
        .mockRejectedValueOnce(makeFetchError(429))

      session.confirmDevices()
      await nextTick()

      await vi.advanceTimersByTimeAsync(3000)
      await nextTick()
      await vi.advanceTimersByTimeAsync(3000)
      await nextTick()

      expect(session.state.value).toBe('error')
      expect(session.retryAttemptCount.value).toBe(0)
    })

    it('user presses Retry after 3× 429 → new attempt sequence with counter reset', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()

      mockCandidateFetch
        .mockRejectedValueOnce(makeFetchError(429))
        .mockRejectedValueOnce(makeFetchError(429))
        .mockRejectedValueOnce(makeFetchError(429))

      session.confirmDevices()
      await nextTick()
      await vi.advanceTimersByTimeAsync(3000)
      await nextTick()
      await vi.advanceTimersByTimeAsync(3000)
      await nextTick()

      expect(session.state.value).toBe('error')

      // User presses Retry — new sequence begins
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())
      session.retry()
      await nextTick()

      // Counter is 0 at start of new sequence
      expect(session.retryAttemptCount.value).toBe(0)
    })
  })

  describe('403 terminal / 502 error', () => {
    it('/start 403 → state terminal with reason 403 (non-retryable)', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()

      mockCandidateFetch.mockRejectedValueOnce(makeFetchError(403))

      session.confirmDevices()
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(session.terminalReason.value).toBe('403')
    })

    it('/start 502 → state error (retryable)', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()

      mockCandidateFetch.mockRejectedValueOnce(makeFetchError(502))

      session.confirmDevices()
      await flushPromises()

      expect(session.state.value).toBe('error')
    })
  })

  // ---------------------------------------------------------------------------
  // 401 → session_expired (Task 2.6/2.7 RED — candidate-session-auth D-E)
  //
  // candidateFetch throws a typed CandidateUnauthorizedError on any 401 — both
  // a LIVE 401 response and a session that was already expired before the
  // call was attempted (candidateFetch's own guard rejects before any network
  // call in that case). Either way, the session machine must land on a
  // DISTINCT, non-retryable terminal state — never the retryable `error`
  // state, and never an automatic retry.
  // ---------------------------------------------------------------------------

  describe('401 → session_expired (non-retryable, distinct from 403)', () => {
    it('/start 401 (CandidateUnauthorizedError) → terminal with reason session_expired', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()

      mockCandidateFetch.mockRejectedValueOnce(new MockCandidateUnauthorizedError())

      session.confirmDevices()
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(session.terminalReason.value).toBe('session_expired')
    })

    it('/start 401 → does NOT retry automatically (unlike 429)', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()

      mockCandidateFetch.mockRejectedValueOnce(new MockCandidateUnauthorizedError())

      session.confirmDevices()
      await flushPromises()

      // No backoff timer, no further /start attempt — a single terminal call.
      const startCalls = mockCandidateFetch.mock.calls.filter(
        (c) => c[0] === '/candidate/interview/start'
      )
      expect(startCalls).toHaveLength(1)
      expect(session.state.value).toBe('terminal')
    })

    it('/end 401 (CandidateUnauthorizedError) → terminal with reason session_expired, not the generic 403 path', async () => {
      const session = await createLiveSession()

      mockCandidateFetch.mockRejectedValueOnce(new MockCandidateUnauthorizedError())

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(session.terminalReason.value).toBe('session_expired')
    })

    it('/utterance 401 (CandidateUnauthorizedError) → terminal with reason session_expired', async () => {
      const session = await createLiveSession()

      mockCandidateFetch.mockRejectedValueOnce(new MockCandidateUnauthorizedError())

      currentMockProvider._emit('transcript', { role: 'candidate', text: 'Hello', ts: Date.now() })
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(session.terminalReason.value).toBe('session_expired')
    })
  })

  // ---------------------------------------------------------------------------
  // Malformed /start response shape → malformed_response (Task 2.6/2.7 RED)
  //
  // Today, an unguarded `response.question_context.end_phrase` read throws
  // inside the try block on a bad body; `status` is undefined, so it lands in
  // the retryable `error` state — retrying forever against a server that will
  // answer identically. An explicit shape guard makes this the SAME defect
  // class as the 401 fix: a non-retryable terminal, not an infinite retry.
  // ---------------------------------------------------------------------------

  describe('malformed /start response shape → malformed_response (not retryable error)', () => {
    it('missing question_context entirely → terminal with reason malformed_response', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()

      mockCandidateFetch.mockResolvedValueOnce({
        session_id: '42',
        provider: 'heygen',
        provider_token: 'tok-123',
        conversation_url: null,
        // question_context is entirely absent — the contract violation.
      })

      session.confirmDevices()
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(session.terminalReason.value).toBe('malformed_response')
    })

    it('question_context present but missing end_phrase → terminal with reason malformed_response', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()

      mockCandidateFetch.mockResolvedValueOnce({
        session_id: '42',
        provider: 'heygen',
        provider_token: 'tok-123',
        conversation_url: null,
        question_context: {
          competency_code: 'PRS',
          question_index: '0',
          // end_phrase and final_phrase both absent
        },
      })

      session.confirmDevices()
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(session.terminalReason.value).toBe('malformed_response')
    })

    it('a malformed response does NOT retry automatically — one /start call only', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()

      mockCandidateFetch.mockResolvedValueOnce({ session_id: '42' })

      session.confirmDevices()
      await flushPromises()

      const startCalls = mockCandidateFetch.mock.calls.filter(
        (c) => c[0] === '/candidate/interview/start'
      )
      expect(startCalls).toHaveLength(1)
    })

    it('a well-formed response does NOT trigger the malformed_response path', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())

      session.confirmDevices()
      await nextTick()

      expect(session.state.value).not.toBe('terminal')
      expect(session.terminalReason.value).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Verification Finding #1 — session clearing on EVERY terminal/done
  // transition, not just the 401 path.
  //
  // candidateFetch already clears on a LIVE 401 (candidate-api.spec.ts covers
  // that). This suite proves useInterviewSession ALSO clears directly and
  // unconditionally whenever the state machine reaches `done` or `terminal`
  // — 403, absent_phrase, malformed_response, and session_expired all funnel
  // through the SAME `transitionTo()` call, so a single centralized clear()
  // there covers every current and future terminal reason, not a per-branch
  // patch that the next new reason could forget.
  // ---------------------------------------------------------------------------

  describe('session clearing on every terminal/done transition (Verification Finding #1)', () => {
    it('/start 403 → clears the candidate session', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()
      mockCandidateFetch.mockRejectedValueOnce(makeFetchError(403))

      session.confirmDevices()
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(mockClearSession).toHaveBeenCalled()
    })

    it('/end 403 → clears the candidate session', async () => {
      const session = await createLiveSession()
      mockCandidateFetch.mockRejectedValueOnce(makeFetchError(403))

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(mockClearSession).toHaveBeenCalled()
    })

    it('absent_phrase (provider verdict) → clears the candidate session', async () => {
      const session = await createLiveSession()

      currentMockProvider._emit('error', 'absent_phrase')
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(session.terminalReason.value).toBe('absent_phrase')
      expect(mockClearSession).toHaveBeenCalled()
    })

    it('malformed_response (/start bad shape) → clears the candidate session', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce({ session_id: '42' })

      session.confirmDevices()
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(session.terminalReason.value).toBe('malformed_response')
      expect(mockClearSession).toHaveBeenCalled()
    })

    it('session_expired (401 mid-session) → clears the candidate session (via useInterviewSession, not only candidateFetch)', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()
      mockCandidateFetch.mockRejectedValueOnce(new MockCandidateUnauthorizedError())

      session.confirmDevices()
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(mockClearSession).toHaveBeenCalled()
    })

    it('reaching `done` on the last competency → clears the candidate session', async () => {
      const session = await createLiveSession('4', DEFAULT_COMPETENCIES) // last competency
      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 5,
        total_competencies: 5,
        next_action: 'done',
      }) // /end 200 — server says the interview is over

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('done')
      expect(mockClearSession).toHaveBeenCalled()
    })

    it('a retryable `error` state (502) does NOT clear the session — it is not terminal', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()
      mockCandidateFetch.mockRejectedValueOnce(makeFetchError(502))

      session.confirmDevices()
      await flushPromises()

      expect(session.state.value).toBe('error')
      expect(mockClearSession).not.toHaveBeenCalled()
    })

    it('reaching `end_of_question` (not terminal) does NOT clear the session', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      mockCandidateFetch.mockResolvedValueOnce(undefined) // /end 200

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('end_of_question')
      expect(mockClearSession).not.toHaveBeenCalled()
    })
  })

  describe('pause / resume (client-side only)', () => {
    // REMOVED by D13: `end_of_question` is now the SA-04 scheduled-pause screen,
    // so it no longer carries a Pause control — a Pause button on a pause screen
    // is meaningless, and that control was the only trigger for this edge.
    // Its replacement lives in "pause narrows to live": pause() from
    // end_of_question is a no-op.

    it('paused → resume() → live (no backend call)', async () => {
      // Destination changed by D13: `live` is the only entry edge now, so it is
      // also the only place resume() can land. The old `?? 'end_of_question'`
      // fallback would send a mid-competency resume to the scheduled-pause
      // screen, whose Continue calls /start for the NEXT competency — tearing
      // the avatar down and losing the turn in progress.
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      session.pause()
      await nextTick()

      const callsBefore = mockCandidateFetch.mock.calls.length
      session.resume()
      await nextTick()

      expect(session.state.value).toBe('live')
      expect(mockCandidateFetch.mock.calls.length).toBe(callsBefore)
    })

    // The Pause control is rendered while the session is `live` (session.vue), but
    // pause() only ever accepted `end_of_question`. Pressing it mid-interview was a
    // silent no-op — the candidate asked for a break and the recording kept running.

    it('live → pause() → paused (no backend call)', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      expect(session.state.value).toBe('live')

      const callsBefore = mockCandidateFetch.mock.calls.length
      session.pause()
      await nextTick()

      expect(session.state.value).toBe('paused')
      expect(mockCandidateFetch.mock.calls.length).toBe(callsBefore)
    })

    it('pausing a live question mutes the microphone', async () => {
      // A pause that leaves the mic open is not a pause: the candidate believes
      // they are off the record while their audio still reaches the provider.
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      session.pause()
      await flushPromises()

      expect(currentMockProvider.setMicMuted).toHaveBeenCalledWith(true)
    })

    it('resuming from a live pause returns to live and unmutes', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      session.pause()
      await flushPromises()
      session.resume()
      await flushPromises()

      expect(session.state.value).toBe('live')
      expect(currentMockProvider.setMicMuted).toHaveBeenLastCalledWith(false)
    })

    // REMOVED (D13): this asserted pre-D13 behaviour — that resume() returns to
    // end_of_question. It kept passing only because pause() from that state is
    // now a no-op, so the session never entered `paused` and the assertion
    // compared end_of_question against itself. A test that passes for a reason
    // unrelated to its name is worse than none.
    // Replaced by "pause() from end_of_question is a no-op" and
    // "resume() from paused can only land on live".

    it('pause() is ignored from a non-pausable state', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })

      session.pause()
      await nextTick()

      expect(session.state.value).toBe('idle')
    })
  })

  describe('server-directed flow (D11)', () => {
    // The client stops deciding whether the interview continues. It used to
    // compare a question index against a competency list the page never filled,
    // so `0 >= 0` was true and every interview ended after one question. The
    // server now says what happens next and this composable obeys it.

    it('next_action=continue on HeyGen starts the next competency with NO screen in between (invisible-competency-handover D2)', async () => {
      // Superseded by invisible-competency-handover: the OLD assertion here
      // was `state === 'connecting'` — the exact D12 gap this change closes.
      // Strictly stronger replacement: the machine now stays `live` through
      // the whole handover (D2) AND a second, DISTINCT provider session was
      // genuinely requested for the next competency — never absence alone,
      // which would pass just as happily on a machine that silently dropped
      // the next competency altogether.
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      const outgoing = mockProviderRegistry[0]!

      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 1,
        total_competencies: 3,
        next_action: 'continue',
      })
      mockCandidateFetch.mockResolvedValueOnce(
        makeStartResponse({ question_index: '1', provider: 'heygen' })
      )

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('live')
      const startCalls = mockCandidateFetch.mock.calls.filter(
        (c) => c[0] === '/candidate/interview/start'
      )
      expect(startCalls.length).toBe(2)
      expect(mockProviderRegistry.length).toBe(2)
      const incoming = mockProviderRegistry[1]!
      expect(incoming).not.toBe(outgoing)
    })

    it('next_action=pause shows the scheduled-pause screen and calls no /start', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 2,
        total_competencies: 6,
        next_action: 'pause',
      })

      const callsBefore = mockCandidateFetch.mock.calls.length
      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('end_of_question')
      expect(mockCandidateFetch.mock.calls.length).toBe(callsBefore + 1)
    })

    it('next_action=done goes straight to the done screen', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 3,
        total_competencies: 3,
        next_action: 'done',
      })

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('done')
    })

    it('exposes the server progress counts', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 2,
        total_competencies: 5,
        next_action: 'pause',
      })

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.endedCompetencies.value).toBe(2)
      expect(session.totalCompetencies.value).toBe(5)
    })

    it('an absent directive degrades to pause, never to done', async () => {
      // A stale server, a proxy that strips the body, an unknown future value:
      // all land on the screen that asks the candidate to press continue. The
      // failure mode that must never happen is silently ending an interview that
      // is not over — that is the defect this change removes.
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      mockCandidateFetch.mockResolvedValueOnce(undefined)

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('end_of_question')
    })

    it('an unrecognised directive value also degrades to pause', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 1,
        total_competencies: 3,
        next_action: 'teleport',
      })

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('end_of_question')
    })

    it('HTTP 409 causes NO transition at all', async () => {
      // 409 is the loser of the avatar-complete/timer race. Both callers used to
      // advance, harmlessly, because they advanced to the same state. Under a
      // directive-driven machine the loser has no directive and must not act.
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      mockCandidateFetch.mockRejectedValueOnce({ status: 409 })

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('live')
    })
  })

  describe('Skip is gone (D11)', () => {
    it('endQuestion only accepts timeout', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 1,
        total_competencies: 3,
        next_action: 'continue',
      })
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse({ question_index: '1' }))

      await session.endQuestion('timeout')
      await flushPromises()

      const endCall = mockCandidateFetch.mock.calls.find((c) => c[0] === '/candidate/interview/end')
      expect((endCall![1] as { body: Record<string, unknown> }).body.ended_reason).toBe('timeout')
    })
  })

  describe('pause narrows to live (D13)', () => {
    it('pause() from end_of_question is a no-op', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 1,
        total_competencies: 3,
        next_action: 'pause',
      })
      currentMockProvider._emit('state', 'complete')
      await flushPromises()
      expect(session.state.value).toBe('end_of_question')

      session.pause()
      await nextTick()

      expect(session.state.value).toBe('end_of_question')
    })

    it('resume() from paused can only land on live', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      session.pause()
      await flushPromises()
      expect(session.state.value).toBe('paused')

      session.resume()
      await flushPromises()

      expect(session.state.value).toBe('live')
    })
  })

  // ---------------------------------------------------------------------------
  // invisible-competency-handover — D2 event identity (the crux)
  //
  // Two `ProviderSession` handles can be live at once during a HeyGen
  // handover. Today's handlers used to read shared module state, so a
  // SECOND live session did not merely overlap — it corrupted: an outgoing
  // `ready` could flip the machine live with no avatar on screen, an
  // outgoing `transcript` could post against the INCOMING's dbSessionId
  // (the exact data-loss shape repaired in api v0.26.4), and an outgoing
  // `error` could kill a healthy incoming session. Every handler below
  // resolves by IDENTITY instead (`handle === activeSession.value` /
  // `=== incomingSession.value`).
  //
  // Both helpers below depend on the F4 harness fix above: `mockProviderRegistry`
  // must hold two DISTINCT provider objects (outgoing at [0], incoming at
  // [1]) for any of this to be meaningful.
  // ---------------------------------------------------------------------------

  describe('invisible-competency-handover — D2 event identity (the crux)', () => {
    /** The incoming's own /start never resolves — the 10s bound fires and releases the outgoing. */
    async function beginStalledHeyGenOverlap() {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      const outgoing = mockProviderRegistry[0]!

      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 1,
        total_competencies: 3,
        next_action: 'continue',
      })
      mockCandidateFetch.mockImplementationOnce(() => new Promise(() => undefined))

      outgoing._emit('state', 'complete')
      await flushPromises()

      await vi.advanceTimersByTimeAsync(10_000)

      return { session, outgoing }
    }

    it('1.1 RED — a stray `ready` from the RELEASED outgoing, after the bound fires, does NOT flip state back to `live`', async () => {
      const { session, outgoing } = await beginStalledHeyGenOverlap()
      expect(session.state.value).toBe('connecting')

      // The outgoing's listeners are never unsubscribed — a late/queued SDK
      // event can still arrive after release. Under shared-state resolution
      // this flips state to `live` with no avatar actually on screen (F1).
      outgoing._emit('state', 'ready')
      await flushPromises()

      expect(session.state.value).toBe('connecting')
    })

    it("1.2 RED — an outgoing transcript mid-overlap posts against the OUTGOING dbSessionId, never the incoming's", async () => {
      const { outgoing } = await beginHealthyHeyGenOverlap()

      mockCandidateFetch.mockResolvedValueOnce(undefined) // /utterance 202

      outgoing._emit('transcript', { role: 'avatar', text: 'still finishing up', ts: Date.now() })
      await flushPromises()

      const utteranceCall = mockCandidateFetch.mock.calls.find(
        (c) => c[0] === '/candidate/interview/utterance'
      )
      expect(utteranceCall).toBeDefined()
      // 42 is the OUTGOING's dbSessionId — makeStartResponse()'s default session_id.
      // The incoming's /start in beginHealthyHeyGenOverlap() resolves with a
      // DIFFERENT session_id from a fresh makeStartResponse() call, so a
      // contaminated post would read something other than 42.
      expect((utteranceCall![1] as { body: { session_id: number } }).body.session_id).toBe(42)
    })

    it('1.3 RED — an outgoing error mid-overlap does NOT kill the healthy incoming session', async () => {
      const { session, outgoing } = await beginHealthyHeyGenOverlap()

      outgoing._emit('error', { code: 'sdk_error', message: 'connection lost' })
      await flushPromises()

      // Falls to the SAME fallback the bound timer uses — "what we were
      // holding open is already gone" — never the terminal `error` screen
      // while a healthy incoming exists.
      expect(session.state.value).not.toBe('error')
      expect(session.state.value).toBe('connecting')
    })

    it('1.6 — endQuestion() is refused while a handover is in flight (incomingSession !== null)', async () => {
      const { session } = await beginHealthyHeyGenOverlap()
      const callsBefore = mockCandidateFetch.mock.calls.length

      await session.endQuestion('timeout')

      expect(mockCandidateFetch.mock.calls.length).toBe(callsBefore)
      expect(session.state.value).toBe('live')
    })

    it('1.7 — pause() is refused while a handover is in flight; handoverInFlight is true for the :disabled binding', async () => {
      const { session } = await beginHealthyHeyGenOverlap()

      expect(session.handoverInFlight.value).toBe(true)
      session.pause()
      await nextTick()

      expect(session.state.value).toBe('live') // never entered `paused`
    })
  })

  // ---------------------------------------------------------------------------
  // Four-lens review "also fix" — the `noop` (409) branch's `endHandover()`
  // was asserted only by the absence of a different symptom, never directly
  // and never across time. This advances timers and proves the bound does
  // NOT fire on a healthy live session after the /end race is lost.
  // ---------------------------------------------------------------------------

  describe('invisible-competency-handover — the noop (409) branch genuinely cancels the bound, across time', () => {
    it('409 on the handover /end → the bound timer is cancelled; advancing 10s+ does NOT release the outgoing or touch state', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      const outgoing = mockProviderRegistry[0]!

      mockCandidateFetch.mockRejectedValueOnce({ status: 409 })

      outgoing._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('live')

      // If the bound were still armed, this is where it would fire.
      await vi.advanceTimersByTimeAsync(15_000)
      await flushPromises()

      expect(session.state.value).toBe('live')
      expect(outgoing._stopMock).not.toHaveBeenCalled()
      expect(session.activeProvider.value).toBe(outgoing)
    })
  })

  // ---------------------------------------------------------------------------
  // Four-lens review "also fix" — none of the five `target === 'incoming'`
  // failure branches in `startSession()` were exercised. Dropping any ONE
  // guard turns "next competency failed to connect" into a candidate-facing
  // terminal screen mid-interview.
  // ---------------------------------------------------------------------------

  describe('invisible-competency-handover — the five target==="incoming" /start failure branches', () => {
    async function beginHealthyOverlapPendingIncomingStart() {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      const outgoing = mockProviderRegistry[0]!
      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 1,
        total_competencies: 3,
        next_action: 'continue',
      })
      return { session, outgoing }
    }

    it('malformed /start response for the incoming → abandoned, outgoing stays live, bound still governs (mid-overlap)', async () => {
      const { session, outgoing } = await beginHealthyOverlapPendingIncomingStart()
      mockCandidateFetch.mockResolvedValueOnce({ session_id: '99' }) // malformed

      outgoing._emit('state', 'complete')
      await flushPromises()

      // Mid-overlap: the outgoing is untouched, still governed by the bound.
      expect(session.state.value).toBe('live')
      expect(outgoing._stopMock).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(10_000)
      await flushPromises()
      // The bound's own release (`releaseOutgoing`) is structural: it clears
      // the live slot and Vue's own AvatarPlayer unmount is what calls
      // `stop()` (D3) — this composable-only harness renders no component,
      // so the STOP guarantee itself is proven at the DOM level instead, by
      // interview-handover.spec.ts's 2.5. What this level CAN prove is that
      // the slot itself was actually released.
      expect(session.state.value).toBe('connecting')
      expect(session.activeProvider.value).toBeNull()
    })

    it('401 (CandidateUnauthorizedError) on the incoming /start → terminal with session_expired, both slots cleared', async () => {
      const { session, outgoing } = await beginHealthyOverlapPendingIncomingStart()
      mockCandidateFetch.mockRejectedValueOnce(new MockCandidateUnauthorizedError())

      outgoing._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(session.terminalReason.value).toBe('session_expired')
      expect(session.activeProvider.value).toBeNull()
    })

    it('403 on the incoming /start → terminal with reason 403, both slots cleared', async () => {
      const { session, outgoing } = await beginHealthyOverlapPendingIncomingStart()
      mockCandidateFetch.mockRejectedValueOnce(makeFetchError(403))

      outgoing._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(session.terminalReason.value).toBe('403')
      expect(session.activeProvider.value).toBeNull()
    })

    it('429 on the incoming /start exhausts all 3 attempts → abandoned, outgoing stays live mid-overlap, bound still governs', async () => {
      const { session, outgoing } = await beginHealthyOverlapPendingIncomingStart()
      mockCandidateFetch
        .mockRejectedValueOnce(makeFetchError(429))
        .mockRejectedValueOnce(makeFetchError(429))
        .mockRejectedValueOnce(makeFetchError(429))

      outgoing._emit('state', 'complete')
      await flushPromises()
      await vi.advanceTimersByTimeAsync(3000)
      await flushPromises()
      await vi.advanceTimersByTimeAsync(3000)
      await flushPromises()

      // Still mid-overlap (< 10s bound): the outgoing is untouched.
      expect(session.state.value).toBe('live')
      expect(outgoing._stopMock).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(4001) // total > 10s from complete
      await flushPromises()
      expect(session.state.value).toBe('connecting')
    })

    it('502 (generic error) on the incoming /start → abandoned, outgoing stays live mid-overlap, bound still governs', async () => {
      const { session, outgoing } = await beginHealthyOverlapPendingIncomingStart()
      mockCandidateFetch.mockRejectedValueOnce(makeFetchError(502))

      outgoing._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('live')
      expect(outgoing._stopMock).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(10_000)
      await flushPromises()
      expect(session.state.value).toBe('connecting')
    })
  })

  // ---------------------------------------------------------------------------
  // Four-lens review "also fix" — observability. Every degrade path is
  // deliberately non-throwing, so nothing recorded it happening. Assert by
  // CONTENT (event name + detail), never by incidental call count.
  // ---------------------------------------------------------------------------

  describe('invisible-competency-handover — observability breadcrumbs on every degrade path', () => {
    it('logs a structured breadcrumb when the bound fires', async () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      const outgoing = mockProviderRegistry[0]!
      mockCandidateFetch.mockImplementationOnce(() => new Promise(() => undefined))

      outgoing._emit('state', 'complete')
      await flushPromises()
      await vi.advanceTimersByTimeAsync(10_000)
      await flushPromises()

      expect(session.state.value).toBe('connecting')
      expect(infoSpy).toHaveBeenCalledWith(
        '[handover] outgoing-released',
        expect.objectContaining({ reason: 'bound' })
      )
      infoSpy.mockRestore()
    })

    it('logs a structured breadcrumb when the incoming is released (error mid-overlap)', async () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
      const { incoming } = await beginHealthyHeyGenOverlap()

      incoming._emit('error', { code: 'sdk_error', message: 'incoming failed' })
      await flushPromises()

      expect(infoSpy).toHaveBeenCalledWith('[handover] incoming-released', expect.any(Object))
      infoSpy.mockRestore()
    })

    it('logs a structured breadcrumb when the connecting-ceiling gives up', async () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      const outgoing = mockProviderRegistry[0]!
      mockCandidateFetch.mockImplementationOnce(() => new Promise(() => undefined))

      outgoing._emit('state', 'complete')
      await flushPromises()
      await vi.advanceTimersByTimeAsync(10_000)
      await flushPromises()
      await vi.advanceTimersByTimeAsync(20_000)
      await flushPromises()

      expect(session.state.value).toBe('error')
      expect(infoSpy).toHaveBeenCalledWith(
        '[handover] connecting-ceiling-exceeded',
        expect.any(Object)
      )
      infoSpy.mockRestore()
    })

    it('logs a structured breadcrumb when an incoming /start attempt is abandoned', async () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
      await createLiveSession('0', DEFAULT_COMPETENCIES)
      const outgoing = mockProviderRegistry[0]!
      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 1,
        total_competencies: 3,
        next_action: 'continue',
      })
      mockCandidateFetch.mockRejectedValueOnce(makeFetchError(502))

      outgoing._emit('state', 'complete')
      await flushPromises()

      expect(infoSpy).toHaveBeenCalledWith(
        '[handover] incoming-attempt-abandoned',
        expect.any(Object)
      )
      infoSpy.mockRestore()
    })

    it('logs a structured breadcrumb when a promote is raced by the outgoing dying mid-crossfade (C1)', async () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      const outgoing = mockProviderRegistry[0]!
      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 1,
        total_competencies: 3,
        next_action: 'continue',
      })
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse({ session_id: '99' }))

      outgoing._emit('state', 'complete')
      await flushPromises()
      session.notifyPainted(99)
      await nextTick()
      outgoing._emit('error', { code: 'sdk_error', message: 'connection lost' })
      await flushPromises()

      expect(infoSpy).toHaveBeenCalledWith(
        '[handover] promote-raced-outgoing-death',
        expect.any(Object)
      )
      infoSpy.mockRestore()
    })
  })

  // ---------------------------------------------------------------------------
  // Four-lens review B2 — endQuestion()/pause() guard the WHOLE handover
  // window, not just the window after `incomingSession` is populated.
  //
  // `beginHandover()` mutes the outgoing and arms the bound BEFORE `/end` is
  // even dispatched, and `incomingSession` is only populated several round
  // trips later (after `/end` resolves `continue` AND the incoming `/start`
  // resolves). The OLD guard (`incomingSession.value !== null`) was open for
  // that whole window — a per-question timer landing there raced a second
  // `/end` against a session that was still the rendered live player.
  // ---------------------------------------------------------------------------

  describe('invisible-competency-handover — B2: guards close the WHOLE handover window', () => {
    /** Captures the exact window: complete handled, /end dispatched, still pending. */
    async function beginHandoverWithEndPending() {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      const outgoing = mockProviderRegistry[0]!
      mockCandidateFetch.mockImplementationOnce(() => new Promise(() => undefined))

      outgoing._emit('state', 'complete')
      // Deliberately NOT awaiting flushPromises(): /end is still in flight,
      // so under the OLD guard incomingSession.value is still null here.

      return { session, outgoing }
    }

    it('B2 RED — endQuestion() is refused BEFORE incomingSession exists (bound armed, /end still pending)', async () => {
      const { session } = await beginHandoverWithEndPending()
      const callsBefore = mockCandidateFetch.mock.calls.length

      await session.endQuestion('timeout')

      // No SECOND /end call was dispatched against the still-live handle.
      expect(mockCandidateFetch.mock.calls.length).toBe(callsBefore)
      expect(session.state.value).toBe('live')
    })

    it('B2 RED — pause() is refused in the same window; handoverInFlight is already true before incomingSession exists', async () => {
      const { session } = await beginHandoverWithEndPending()

      expect(session.handoverInFlight.value).toBe(true)
      session.pause()
      await nextTick()

      expect(session.state.value).toBe('live') // never entered `paused`
    })
  })

  // ---------------------------------------------------------------------------
  // Four-lens review M1 — confirmDevices()/retry() abandon a leftover bound
  // timer UNCONDITIONALLY, even in the pre-incomingSession window.
  // ---------------------------------------------------------------------------

  describe('invisible-competency-handover — M1: confirmDevices()/retry() abandon the bound timer even before incomingSession exists', () => {
    it('M1 RED — retry() mid-handover (before incomingSession exists) does NOT leave the bound timer armed against the FRESH session it just started', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      const outgoing = mockProviderRegistry[0]!

      // /end never resolves — incomingSession never gets populated.
      mockCandidateFetch.mockImplementationOnce(() => new Promise(() => undefined))
      outgoing._emit('state', 'complete')
      await nextTick()

      // The candidate (or an operator flow) retries — a fresh session begins.
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse({ session_id: '77' }))
      session.retry()
      await flushPromises()

      const freshProvider = mockProviderRegistry[mockProviderRegistry.length - 1]!
      freshProvider._emit('state', 'ready')
      await flushPromises()

      expect(session.state.value).toBe('live')
      const freshSessionId = session.sessionId.value

      // The stale bound timer — if still armed — fires here.
      await vi.advanceTimersByTimeAsync(10_000)
      await flushPromises()

      // The FRESH session must be untouched: still live, same session id.
      expect(session.state.value).toBe('live')
      expect(session.sessionId.value).toBe(freshSessionId)
    })
  })

  // ---------------------------------------------------------------------------
  // Four-lens review C1 — the outgoing dying INSIDE the crossfade window
  // (incoming already painted, promoteTimer pending) must finish the
  // promotion, not strand the already-visible incoming.
  // ---------------------------------------------------------------------------

  describe('invisible-competency-handover — C1: outgoing dies mid-crossfade → the already-painted incoming is promoted, not stranded', () => {
    it('C1 RED — outgoing error AFTER the incoming has painted (mid-crossfade) still promotes the incoming to live', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      const outgoing = mockProviderRegistry[0]!

      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 1,
        total_competencies: 3,
        next_action: 'continue',
      })
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse({ session_id: '99' }))

      outgoing._emit('state', 'complete')
      await flushPromises()

      const incoming = mockProviderRegistry[1]!
      // The incoming paints — enters the ~200ms crossfade window.
      session.notifyPainted(99)
      await nextTick()

      // The outgoing dies INSIDE that window, before the crossfade timer fires.
      outgoing._emit('error', { code: 'sdk_error', message: 'connection lost' })
      await flushPromises()

      // Promoted immediately — never fell to the connecting/panel fallback,
      // never stuck as a hidden `entering` player behind a `hasLivePlayer:
      // false` collapse.
      expect(session.state.value).toBe('live')
      expect(session.sessionId.value).toBe(99)
      expect(session.activeProvider.value).toBe(incoming)
    })
  })

  // ---------------------------------------------------------------------------
  // Four-lens review B3/B4/C3 — the connecting-ceiling bounds the
  // bound-exceeded `connecting` fallback, which previously had no ceiling
  // at all.
  // ---------------------------------------------------------------------------

  describe('invisible-competency-handover — B3/B4/C3: the connecting-ceiling bounds the post-bound wait', () => {
    it('B3 RED — the incoming reports readiness but never paints: the ceiling gives up and surfaces the retryable error screen, never an infinite wait', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      const outgoing = mockProviderRegistry[0]!

      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 1,
        total_competencies: 3,
        next_action: 'continue',
      })
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse({ session_id: '99' }))

      outgoing._emit('state', 'complete')
      await flushPromises()

      // The incoming reports 'ready'/'listening' (readiness) but NEVER emits
      // `painted` — no test-level rVFC/loadeddata simulation here at all,
      // mirroring a throttled tab or a stalled decoder in production.
      const incoming = mockProviderRegistry[1]!
      incoming._emit('state', 'ready')
      await flushPromises()

      // The 10s bound fires first: outgoing releases, state degrades to connecting.
      await vi.advanceTimersByTimeAsync(10_000)
      await flushPromises()
      expect(session.state.value).toBe('connecting')

      // Today (pre-fix): NOTHING bounds this. The candidate would sit here
      // forever. Advance well past the connecting-ceiling.
      await vi.advanceTimersByTimeAsync(20_000)
      await flushPromises()

      expect(session.state.value).toBe('error')
      // The stuck incoming was released, not left running invisibly.
      expect(incoming._stopMock).toHaveBeenCalled()
    })

    it('B4 RED — the incoming exhausts its /start retries AFTER the bound already fired: the ceiling still recovers the interview, never an unrecoverable dead end', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      const outgoing = mockProviderRegistry[0]!

      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 1,
        total_competencies: 3,
        next_action: 'continue',
      })
      // The incoming's /start fails all 3 attempts (429 provider_busy).
      mockCandidateFetch
        .mockRejectedValueOnce(makeFetchError(429))
        .mockRejectedValueOnce(makeFetchError(429))
        .mockRejectedValueOnce(makeFetchError(429))

      outgoing._emit('state', 'complete')
      await flushPromises()

      // The bound fires BEFORE the incoming's retries exhaust (backoff alone
      // can eat 6s of the 10s bound on a slow connection).
      await vi.advanceTimersByTimeAsync(10_000)
      await flushPromises()
      expect(session.state.value).toBe('connecting')

      // Let the retries keep exhausting in the background, then the ceiling.
      await vi.advanceTimersByTimeAsync(20_000)
      await flushPromises()

      // Recoverable: a retryable error screen, not a permanent dead end with
      // no session, no timer, and no reachable control.
      expect(session.state.value).toBe('error')
    })

    it('the connecting-ceiling does NOT fire when promote() succeeds first — no stray error after a healthy handover', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      const outgoing = mockProviderRegistry[0]!

      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 1,
        total_competencies: 3,
        next_action: 'continue',
      })
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse({ session_id: '99' }))

      outgoing._emit('state', 'complete')
      await flushPromises()

      // The bound fires, degrading to connecting — the ceiling is now armed.
      await vi.advanceTimersByTimeAsync(10_000)
      await flushPromises()
      expect(session.state.value).toBe('connecting')

      // The incoming FINALLY paints, inside the ceiling window.
      session.notifyPainted(99)
      await vi.advanceTimersByTimeAsync(200) // crossfade
      await flushPromises()
      expect(session.state.value).toBe('live')

      // Advance well past where the ceiling WOULD have fired — it must not.
      await vi.advanceTimersByTimeAsync(30_000)
      await flushPromises()

      expect(session.state.value).toBe('live')
    })
  })

  // ---------------------------------------------------------------------------
  // invisible-competency-handover — D8/D9: HeyGen-only handover gate
  // ---------------------------------------------------------------------------

  describe('invisible-competency-handover — D8/D9: HeyGen-only handover gate', () => {
    it("a Tavus continue keeps today's exact path — full teardown before the next /start, no handover", async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse({ provider: 'tavus' }))
      session.confirmDevices()
      await nextTick()
      currentMockProvider._emit('state', 'ready')
      await nextTick()
      expect(session.state.value).toBe('live')

      const outgoing = mockProviderRegistry[0]!

      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 1,
        total_competencies: 3,
        next_action: 'continue',
      })
      mockCandidateFetch.mockResolvedValueOnce(
        makeStartResponse({ question_index: '1', provider: 'tavus' })
      )

      outgoing._emit('state', 'complete')
      await flushPromises()

      // Today's non-handover path: the outgoing is stopped BEFORE the next
      // /start is even requested, and the machine passes back through
      // `connecting` — exactly as it did before this change.
      expect(outgoing._stopMock).toHaveBeenCalled()
      expect(session.state.value).toBe('connecting')
    })
  })

  // ---------------------------------------------------------------------------
  // invisible-competency-handover — D4: uplink guard ordering (Task 3.2)
  // ---------------------------------------------------------------------------

  describe('invisible-competency-handover — D4: the outgoing mic is muted BEFORE /end', () => {
    it('3.2 — setMicMuted(true) is called on the OUTGOING before POST /end is dispatched', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      const outgoing = mockProviderRegistry[0]!

      const callOrder: string[] = []
      outgoing.setMicMuted.mockImplementation(async () => {
        callOrder.push('setMicMuted')
      })
      mockCandidateFetch.mockImplementationOnce(async () => {
        callOrder.push('/end')
        return { ended_competencies: 1, total_competencies: 3, next_action: 'continue' }
      })
      // The incoming's own /start — left pending; ordering is decided before it matters.
      mockCandidateFetch.mockImplementationOnce(() => new Promise(() => undefined))

      outgoing._emit('state', 'complete')
      await flushPromises()

      expect(outgoing.setMicMuted).toHaveBeenCalledWith(true)
      expect(callOrder).toEqual(['setMicMuted', '/end'])
      expect(session.state.value).toBe('live')
    })
  })

  describe('microphone selection handoff', () => {
    it('threads the confirmed audioDeviceId into the published StartConfig', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())

      session.confirmDevices('mic-actual')
      await flushPromises()

      expect(session.activeConfig.value?.audioDeviceId).toBe('mic-actual')
    })

    it('omits audioDeviceId when the device check reported no microphone id', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())

      session.confirmDevices()
      await flushPromises()

      expect(session.activeConfig.value?.audioDeviceId).toBeUndefined()
    })

    it('keeps the microphone selection across competencies', async () => {
      // nextCompetency() re-enters confirmDevices() to issue the next provider
      // session. Losing the id there would silently switch microphones halfway
      // through the interview.
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES, 'mic-actual')

      mockCandidateFetch.mockResolvedValueOnce(undefined) // /end 200
      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse({ question_index: '1' }))
      session.nextCompetency()
      await flushPromises()

      expect(session.activeConfig.value?.audioDeviceId).toBe('mic-actual')
    })
  })

  describe('resume-on-remount guard', () => {
    it('second confirmDevices() while first is in-flight → second call skipped', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()

      // First call will resolve eventually
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())

      // Call twice rapidly before first resolves
      session.confirmDevices()
      session.confirmDevices() // should be a no-op (isResuming guard)
      await flushPromises()

      // /start should only have been called ONCE despite two confirmDevices() calls
      const startCalls = mockCandidateFetch.mock.calls.filter(
        (c) => c[0] === '/candidate/interview/start'
      )
      expect(startCalls.length).toBe(1)
    })
  })

  describe('resize listener lifecycle', () => {
    it('attaches window resize listener when entering live state', async () => {
      await createLiveSession()
      expect(window.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
    })

    it('removes resize listener on transition to done', async () => {
      const session = await createLiveSession('4', DEFAULT_COMPETENCIES) // last competency

      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 5,
        total_competencies: 5,
        next_action: 'done',
      }) // /end 200 — server says the interview is over
      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('done')
      expect(window.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
    })

    it('removes resize listener on transition to terminal (when live state was reached first)', async () => {
      // Reach live state (which attaches resize listener), then go terminal via absent_phrase
      const session = await createLiveSession()
      expect(window.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function))

      // Reset removeEventListener spy count so we can check it's called fresh
      ;(window.removeEventListener as ReturnType<typeof vi.fn>).mockClear()

      // Provider emits error (absent_phrase) → terminal
      currentMockProvider._emit('error', 'absent_phrase')
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(window.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
    })

    it('removes resize listener on transition to error (when live state was reached first)', async () => {
      // Reach live state, then simulate a network error during /end → error
      const session = await createLiveSession()
      expect(window.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function))

      ;(window.removeEventListener as ReturnType<typeof vi.fn>).mockClear()

      // Simulate provider error for a non-404 non-fatal (we'll use teardown)
      await session.teardown()

      // teardown removes the listener
      expect(window.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
    })
  })

  describe('/end 403 → terminal', () => {
    it('403 from /end → state terminal with reason 403', async () => {
      const session = await createLiveSession()

      // /end returns 403
      mockCandidateFetch.mockRejectedValueOnce(makeFetchError(403))

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(session.terminalReason.value).toBe('403')
    })
  })

  describe('nextCompetency() — advance to next /start', () => {
    it('nextCompetency from end_of_question → calls /start again', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      mockCandidateFetch.mockResolvedValueOnce(undefined) // /end 200
      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('end_of_question')

      // Next competency
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse({ question_index: '1' }))
      session.nextCompetency()
      await nextTick()

      expect(session.state.value).toBe('connecting')

      const startCalls = mockCandidateFetch.mock.calls.filter(
        (c) => c[0] === '/candidate/interview/start'
      )
      expect(startCalls.length).toBe(2) // one per competency
    })
  })

  describe('teardown()', () => {
    it('calls provider.stop() and removes resize listener', async () => {
      const session = await createLiveSession()

      await session.teardown()

      expect(currentMockProvider._stopMock).toHaveBeenCalled()
      expect(window.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
    })
  })

  // ---------------------------------------------------------------------------
  // Branch coverage: resize keepalive-flush handler invocation path
  // (originally C4 RED→GREEN; migrated off sendBeacon by Task 1.9 — D-C)
  // ---------------------------------------------------------------------------

  describe('resize keepalive-flush handler — coverage branches', () => {
    it('resize to < 1024px with pending integrity events → flushIntegrityKeepalive called with the mapped payload', async () => {
      // Arrange: provide pending events via getPendingIntegrityEvents option
      const pendingEvents = [{ type: 'tab_hidden', ts: 1000, meta: null }]

      const session = useInterviewSession({
        competencies: DEFAULT_COMPETENCIES,
        getPendingIntegrityEvents: () => pendingEvents,
      })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())
      session.confirmDevices()
      await nextTick()
      currentMockProvider._emit('state', 'ready')
      await nextTick()

      // Session should be live — resize listener is attached
      expect(session.state.value).toBe('live')
      expect(window.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function))

      // Capture the resize listener
      const addCalls = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls
      const resizeCall = addCalls.find((c: unknown[]) => c[0] === 'resize')
      expect(resizeCall).toBeDefined()
      const resizeHandler = resizeCall![1] as () => void

      // Simulate viewport shrinking below 1024px
      ;(window as Record<string, unknown>).innerWidth = 900

      // Invoke the resize handler directly
      resizeHandler()

      // flushIntegrityKeepalive replaces sendBeacon (D-C) — carries the same
      // kind-mapped payload shape the beacon used to build.
      expect(mockFlushIntegrityKeepalive).toHaveBeenCalledWith(
        expect.objectContaining({
          events: [expect.objectContaining({ kind: 'tab_hidden', ts: 1000 })],
        })
      )
    })

    it('resize to < 1024px with NO pending events → flushIntegrityKeepalive NOT called; navigateTo called', async () => {
      // No pending events — flush path skipped, but navigateTo is still called
      const session = useInterviewSession({
        competencies: DEFAULT_COMPETENCIES,
        getPendingIntegrityEvents: () => [],
      })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())
      session.confirmDevices()
      await nextTick()
      currentMockProvider._emit('state', 'ready')
      await nextTick()

      expect(session.state.value).toBe('live')

      const addCalls = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls
      const resizeCall = addCalls.find((c: unknown[]) => c[0] === 'resize')
      expect(resizeCall).toBeDefined()
      const resizeHandler = resizeCall![1] as () => void

      ;(window as Record<string, unknown>).innerWidth = 900
      resizeHandler()

      // flushIntegrityKeepalive NOT called (no events)
      expect(mockFlushIntegrityKeepalive).not.toHaveBeenCalled()
      // navigateTo is called to redirect to /unsupported
      expect(mockNavigateTo).toHaveBeenCalledWith('/unsupported')
    })

    it('resize to < 1024px with pending events → provider.stop() called before navigateTo', async () => {
      const pendingEvents = [{ type: 'focus_lost', ts: 2000, meta: null }]

      const session = useInterviewSession({
        competencies: DEFAULT_COMPETENCIES,
        getPendingIntegrityEvents: () => pendingEvents,
      })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())
      session.confirmDevices()
      await nextTick()
      currentMockProvider._emit('state', 'ready')
      await nextTick()

      expect(session.state.value).toBe('live')

      const addCalls = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls
      const resizeCall = addCalls.find((c: unknown[]) => c[0] === 'resize')
      const resizeHandler = resizeCall![1] as () => void

      ;(window as Record<string, unknown>).innerWidth = 500
      resizeHandler()

      // Provider.stop() is called during teardown before navigateTo
      expect(currentMockProvider._stopMock).toHaveBeenCalled()
      expect(mockNavigateTo).toHaveBeenCalledWith('/unsupported')
    })

    it('resize to < 1024px with pending events → acknowledges on dispatch (D-C), before the flush settles', async () => {
      // fetch(..., { keepalive: true }) returns a promise that will not settle
      // before the page/navigation completes, so acknowledgement happens on
      // dispatch rather than on settlement — unlike the old sendBeacon path,
      // which only acknowledged when the synchronous return value was truthy.
      const pendingEvents = [{ type: 'tab_hidden', ts: 1000, meta: null }]
      const flushed: unknown[] = []

      const session = useInterviewSession({
        competencies: DEFAULT_COMPETENCIES,
        getPendingIntegrityEvents: () => pendingEvents,
        onIntegrityEventsFlushed: (events) => flushed.push(events),
      })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())
      session.confirmDevices()
      await nextTick()
      currentMockProvider._emit('state', 'ready')
      await nextTick()

      const addCalls = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls
      const resizeCall = addCalls.find((c: unknown[]) => c[0] === 'resize')
      const resizeHandler = resizeCall![1] as () => void

      ;(window as Record<string, unknown>).innerWidth = 900
      resizeHandler()

      // Acknowledged synchronously — no await needed, unlike a settlement-based ack.
      expect(flushed).toHaveLength(1)
      expect(flushed[0]).toEqual(pendingEvents)
    })

    it('resize to ≥ 1024px → no flush, no navigateTo (branch NOT taken)', async () => {
      const session = useInterviewSession({
        competencies: DEFAULT_COMPETENCIES,
        getPendingIntegrityEvents: () => [{ type: 'tab_hidden', ts: 1000, meta: null }],
      })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())
      session.confirmDevices()
      await nextTick()
      currentMockProvider._emit('state', 'ready')
      await nextTick()

      const addCalls = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls
      const resizeCall = addCalls.find((c: unknown[]) => c[0] === 'resize')
      const resizeHandler = resizeCall![1] as () => void

      // Width stays above threshold — branch not taken
      ;(window as Record<string, unknown>).innerWidth = 1440
      resizeHandler()

      expect(mockFlushIntegrityKeepalive).not.toHaveBeenCalled()
      expect(mockNavigateTo).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // Branch coverage: /utterance non-409 warning branch (C4 RED→GREEN)
  // ---------------------------------------------------------------------------

  describe('/utterance non-409 error → console.warn logged', () => {
    it('500 from /utterance → console.warn fired; session state unchanged', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const session = await createLiveSession()

      // Transcript triggers /utterance call which returns 500 (non-409)
      mockCandidateFetch.mockRejectedValueOnce(makeFetchError(500))

      currentMockProvider._emit('transcript', {
        role: 'candidate',
        text: 'Non-409 utterance error test',
        ts: Date.now(),
      })
      await flushPromises()

      // console.warn should have been called (non-409 branch)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[useInterviewSession] /utterance error (non-fatal):'),
        expect.anything()
      )

      // Session stays live — utterance errors are non-fatal
      expect(session.state.value).toBe('live')

      warnSpy.mockRestore()
    })
  })

  // ---------------------------------------------------------------------------
  // Branch coverage: /end non-409/non-403 error logging (C4 RED→GREEN)
  // ---------------------------------------------------------------------------

  describe('/end unexpected error → console.warn; state transitions normally', () => {
    it('502 from /end → console.warn fired; state transitions to end_of_question', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      // /end returns 502 (not 409, not 403) → warn is logged, then state proceeds
      mockCandidateFetch.mockRejectedValueOnce(makeFetchError(502))

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      // The warn branch fires for unexpected /end errors
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[useInterviewSession] /end unexpected error:'),
        expect.anything()
      )

      // After the error, callEnd exits without setting state — handleProviderComplete
      // then checks state. Since /end errored (not 403), the catch exits, callEnd
      // resolves (catch branch returns), then the .then() checks for terminal.
      // State was NOT set to terminal (502 ≠ 403), so the .then() branch runs.
      // The session transitions to end_of_question (competencies remain).
      expect(session.state.value).toBe('end_of_question')

      warnSpy.mockRestore()
    })
  })

  // ---------------------------------------------------------------------------
  // activeProvider / activeConfig publication — the live screen's render gate
  // ---------------------------------------------------------------------------

  describe('activeProvider / activeConfig publication', () => {
    it('both are null before /start resolves', () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })

      expect(session.activeProvider.value).toBeNull()
      expect(session.activeConfig.value).toBeNull()
    })

    it('publishes the created provider and its StartConfig once /start resolves', async () => {
      // The interview page renders AvatarPlayer only when BOTH are non-null. They were
      // page-local refs initialised to null and never assigned, so the gate was
      // permanently false and the live interview screen could never render.
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())

      session.confirmDevices()
      await nextTick()

      expect(session.activeProvider.value).toBe(currentMockProvider)
      expect(session.activeConfig.value).toMatchObject({
        dbSessionId: 42,
        sessionToken: 'tok-123',
        endPhrase: 'Passiamo alla prossima domanda.',
        finalPhrase: 'Grazie per il tuo tempo.',
      })
    })

    it('does NOT start the provider itself — AvatarPlayer owns the mount element', async () => {
      // provider.start(mountEl) attaches media ONLY when mountEl is an HTMLMediaElement.
      // Starting here against a detached <div> meant the interviewer's video/audio was
      // never attached to anything.
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())

      session.confirmDevices()
      await nextTick()

      expect(currentMockProvider._startMock).not.toHaveBeenCalled()
      expect(session.activeProvider.value).toBe(currentMockProvider)
    })

    it('exposes the DB session id from the /start response', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())

      session.confirmDevices()
      await nextTick()

      expect(session.sessionId.value).toBe(42)
    })

    it('unpublishes both when the question ends (end_of_question)', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      expect(session.activeProvider.value).toBe(currentMockProvider)

      mockCandidateFetch.mockResolvedValueOnce(undefined) // /end 200
      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('end_of_question')
      expect(session.activeProvider.value).toBeNull()
      expect(session.activeConfig.value).toBeNull()
    })

    it('unpublishes both on a terminal transition', async () => {
      const session = await createLiveSession()

      currentMockProvider._emit('error', 'absent_phrase')
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(session.activeProvider.value).toBeNull()
      expect(session.activeConfig.value).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // endQuestion() — timer expiry and skip (both were inert affordances)
  // ---------------------------------------------------------------------------

  describe('endQuestion()', () => {
    it("timeout → POST /end with ended_reason 'timeout'", async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      mockCandidateFetch.mockResolvedValueOnce(undefined) // /end 200

      await session.endQuestion('timeout')
      await flushPromises()

      const endCall = mockCandidateFetch.mock.calls.find((c) => c[0] === '/candidate/interview/end')
      expect(endCall).toBeDefined()
      expect((endCall![1] as { body: { ended_reason: string } }).body.ended_reason).toBe('timeout')
    })

    it("skip → POST /end with ended_reason 'skipped'", async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      mockCandidateFetch.mockResolvedValueOnce(undefined) // /end 200

      await session.endQuestion('skipped')
      await flushPromises()

      const endCall = mockCandidateFetch.mock.calls.find((c) => c[0] === '/candidate/interview/end')
      expect((endCall![1] as { body: { ended_reason: string } }).body.ended_reason).toBe('skipped')
    })

    it('advances to end_of_question when competencies remain', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      mockCandidateFetch.mockResolvedValueOnce(undefined)

      await session.endQuestion('timeout')
      await flushPromises()

      expect(session.state.value).toBe('end_of_question')
    })

    it('advances to done when the server says the interview is over', async () => {
      // Superseded by D11 twice over: the destination comes from the directive
      // now, and `skipped` is no longer a reason the client can produce — the
      // Skip control is gone and only the timer ends a question early.
      const session = await createLiveSession('4', DEFAULT_COMPETENCIES)
      mockCandidateFetch.mockResolvedValueOnce({
        ended_competencies: 5,
        total_competencies: 5,
        next_action: 'done',
      })

      await session.endQuestion('timeout')
      await flushPromises()

      expect(session.state.value).toBe('done')
    })

    it('stops the provider — it is cut off mid-turn, unlike the completed path', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      mockCandidateFetch.mockResolvedValueOnce(undefined)

      await session.endQuestion('timeout')
      await flushPromises()

      expect(currentMockProvider._stopMock).toHaveBeenCalled()
    })

    it('403 from /end → terminal, and does NOT advance to end_of_question', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      mockCandidateFetch.mockRejectedValueOnce(makeFetchError(403))

      await session.endQuestion('timeout')
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(session.terminalReason.value).toBe('403')
    })

    it('is a no-op outside the live state (no /end call)', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()

      await session.endQuestion('timeout')

      expect(session.state.value).toBe('device_check')
      expect(mockCandidateFetch).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // Provider error classification (domain-sensitive)
  // ---------------------------------------------------------------------------

  describe("provider 'error' events — absent_phrase vs infrastructure failure", () => {
    it("object payload { code: 'absent_phrase' } → terminal with reason absent_phrase", async () => {
      // Real providers emit { code, message } objects; reading the payload as a bare
      // string meant the genuine absent_phrase code was never matched.
      const session = await createLiveSession()

      currentMockProvider._emit('error', {
        code: 'absent_phrase',
        message: 'endPhrase and finalPhrase must both be non-empty strings',
      })
      await flushPromises()

      expect(session.state.value).toBe('terminal')
      expect(session.terminalReason.value).toBe('absent_phrase')
    })

    it('sdk_error while live → retryable error screen, NOT the absent_phrase verdict', async () => {
      // absent_phrase relates to interview VALIDITY. A dropped WebRTC connection is
      // not a failed presence check and must never be reported as one.
      const session = await createLiveSession()

      currentMockProvider._emit('error', { code: 'sdk_error', message: 'connection lost' })
      await flushPromises()

      expect(session.state.value).toBe('error')
      expect(session.terminalReason.value).toBeNull()
    })

    it('sdk_error while connecting → retryable error screen', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())
      session.confirmDevices()
      await nextTick()
      expect(session.state.value).toBe('connecting')

      currentMockProvider._emit('error', { code: 'sdk_error', message: 'ICE failed' })
      await flushPromises()

      expect(session.state.value).toBe('error')
      expect(session.terminalReason.value).toBeNull()
    })

    it('a payload with no recognisable code while live → retryable error', async () => {
      const session = await createLiveSession()

      currentMockProvider._emit('error', { message: 'something went wrong' })
      await flushPromises()

      expect(session.state.value).toBe('error')
      expect(session.terminalReason.value).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Integrity flush acknowledgement (FINDING 4 — buffer was append-only)
  //
  // D-C changed WHEN acknowledgement happens: sendBeacon returned a
  // synchronous boolean the old code branched on; fetch(..., { keepalive })
  // returns a promise that will not settle before the page/navigation
  // completes, so acknowledgement now happens unconditionally on dispatch,
  // not conditionally on the (unobservable, at this point) flush outcome.
  // ---------------------------------------------------------------------------

  describe('integrity flush acknowledgement — acknowledge on dispatch (D-C)', () => {
    async function liveSessionWithPending(pendingEvents: { type: string; ts: number }[]) {
      const flushed: unknown[][] = []
      const session = useInterviewSession({
        competencies: DEFAULT_COMPETENCIES,
        getPendingIntegrityEvents: () =>
          pendingEvents as unknown as Parameters<
            NonNullable<Parameters<typeof useInterviewSession>[0]['onIntegrityEventsFlushed']>
          >[0],
        onIntegrityEventsFlushed: (events) => {
          flushed.push(events as unknown[])
        },
      })
      session.acceptConsent()
      mockCandidateFetch.mockResolvedValueOnce(makeStartResponse())
      session.confirmDevices()
      await nextTick()
      currentMockProvider._emit('state', 'ready')
      await nextTick()

      const addCalls = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls
      const resizeCall = addCalls.find((c: unknown[]) => c[0] === 'resize')
      return { session, flushed, resizeHandler: resizeCall![1] as () => void }
    }

    it('acknowledges exactly the dispatched events', async () => {
      const pendingEvents = [{ type: 'tab_hidden', ts: 1000, meta: null }]
      const { flushed, resizeHandler } = await liveSessionWithPending(pendingEvents)

      ;(window as Record<string, unknown>).innerWidth = 900
      resizeHandler()

      expect(mockFlushIntegrityKeepalive).toHaveBeenCalled()
      expect(flushed).toHaveLength(1)
      expect(flushed[0]).toEqual(pendingEvents)
    })

    it('acknowledges on dispatch even before flushIntegrityKeepalive settles asynchronously', async () => {
      // Simulate the real transport's shape: fire-and-forget, no return value
      // the caller can branch on.
      mockFlushIntegrityKeepalive.mockImplementationOnce(() => undefined)
      const pendingEvents = [{ type: 'focus_lost', ts: 2000, meta: null }]
      const { flushed, resizeHandler } = await liveSessionWithPending(pendingEvents)

      ;(window as Record<string, unknown>).innerWidth = 900
      resizeHandler()

      // No await needed — acknowledgement is synchronous with dispatch, not
      // gated on a promise settling.
      expect(flushed).toHaveLength(1)
    })
  })
})
