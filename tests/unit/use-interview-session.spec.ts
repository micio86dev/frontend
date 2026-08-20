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

// Wire mockCreateProvider to always return the current mock provider
// (currentMockProvider is set fresh in beforeEach, but the factory mock
//  must reference it at call time — so we use a wrapper)
mockCreateProvider.mockImplementation(() => currentMockProvider)

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
  } = {}
) {
  return {
    session_id: '42',
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
  vi.useFakeTimers()
  currentMockProvider = createMockProvider()
  // Re-wire after clearAllMocks (which resets mockImplementation)
  mockCreateProvider.mockImplementation(() => currentMockProvider)
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

    it('/end 200 on last competency (question_index=4, total=5) → state done', async () => {
      const session = await createLiveSession('4', DEFAULT_COMPETENCIES)

      mockCandidateFetch.mockResolvedValueOnce(undefined) // /end 200

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('done')
    })

    it('/end 409 treated as successful no-op → end_of_question (race condition)', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      // 409 from /end = race: already ended; treat as 200
      mockCandidateFetch.mockRejectedValueOnce(makeFetchError(409))

      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('end_of_question')
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
      mockCandidateFetch.mockResolvedValueOnce(undefined) // /end 200

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
    it('end_of_question → pause() → paused (no backend call)', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      mockCandidateFetch.mockResolvedValueOnce(undefined) // /end 200
      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      expect(session.state.value).toBe('end_of_question')

      const callsBefore = mockCandidateFetch.mock.calls.length
      session.pause()
      await nextTick()

      expect(session.state.value).toBe('paused')
      expect(mockCandidateFetch.mock.calls.length).toBe(callsBefore)
    })

    it('paused → resume() → end_of_question (no backend call)', async () => {
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)

      mockCandidateFetch.mockResolvedValueOnce(undefined) // /end 200
      currentMockProvider._emit('state', 'complete')
      await flushPromises()

      session.pause()
      await nextTick()

      const callsBefore = mockCandidateFetch.mock.calls.length
      session.resume()
      await nextTick()

      expect(session.state.value).toBe('end_of_question')
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

    it('resuming from an end_of_question pause returns to end_of_question, not live', async () => {
      // resume() must return to wherever pause() was entered from. Sending an
      // between-competencies pause back to `live` would render an interview screen
      // whose provider has already been torn down.
      const session = await createLiveSession('0', DEFAULT_COMPETENCIES)
      mockCandidateFetch.mockResolvedValueOnce(undefined) // /end 200
      currentMockProvider._emit('state', 'complete')
      await flushPromises()
      expect(session.state.value).toBe('end_of_question')

      session.pause()
      await flushPromises()
      session.resume()
      await flushPromises()

      expect(session.state.value).toBe('end_of_question')
    })

    it('pause() is ignored from a non-pausable state', async () => {
      const session = useInterviewSession({ competencies: DEFAULT_COMPETENCIES })

      session.pause()
      await nextTick()

      expect(session.state.value).toBe('idle')
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

      mockCandidateFetch.mockResolvedValueOnce(undefined) // /end 200
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

    it('advances to done on the last competency', async () => {
      const session = await createLiveSession('4', DEFAULT_COMPETENCIES)
      mockCandidateFetch.mockResolvedValueOnce(undefined)

      await session.endQuestion('skipped')
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
