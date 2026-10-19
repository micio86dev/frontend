/**
 * useInterviewSession — the `/start` body of an `hr_avatar` session becomes a typed
 * `StartConfig` (hr-avatar-adapter, F1).
 *
 * `provider_token` is the client secret, `hr_avatar.{base_url, publishable_key}` are the
 * join inputs, and the key is ABSENT for every other provider (a closed shape, no index
 * signature). An `hr_avatar` handle owns no shared conversation, so the session loop must
 * never send `live_conversation_id` nor treat the response as a continuation.
 *
 * Harness mirrors use-interview-session-continuation.spec.ts (stubbed candidateFetch and
 * factory).
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
import { useInterviewSession, isValidStartResponse } from '~/app/composables/useInterviewSession'

type EventCallback = (payload: unknown) => void

function createMockProvider() {
  const listeners = new Map<string, EventCallback[]>()
  return {
    on: vi.fn((evt: string, cb: EventCallback) => {
      listeners.set(evt, [...(listeners.get(evt) ?? []), cb])
    }),
    start: vi.fn(async () => ({})),
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
const queues = new Map<string, unknown[]>()

function queue(path: string, ...responses: unknown[]) {
  queues.set(path, [...(queues.get(path) ?? []), ...responses])
}

const QUESTION_CONTEXT = {
  competency_code: 'PRS',
  question_index: 0,
  end_phrase: 'Passiamo alla prossima domanda.',
  final_phrase: 'Grazie.',
  prompt_version: 'v1',
}

const hrAvatarBody = (extra: Record<string, unknown> = {}) => ({
  session_id: 42,
  provider: 'hr_avatar',
  provider_token: 'CS',
  conversation_url: null,
  audio_only: false,
  question_context: QUESTION_CONTEXT,
  hr_avatar: { base_url: 'https://hra.test', publishable_key: 'PK' },
  ...extra,
})

const heygenBody = () => ({
  session_id: 43,
  provider: 'heygen',
  provider_token: 'HEYGEN_TOKEN',
  conversation_url: null,
  audio_only: false,
  question_context: QUESTION_CONTEXT,
})

const tavusBody = () => ({
  session_id: 44,
  provider: 'tavus',
  provider_token: null,
  conversation_url: 'https://tavus.test/room',
  audio_only: false,
  question_context: QUESTION_CONTEXT,
})

async function flush() {
  for (let i = 0; i < 30; i++) await nextTick()
}

async function liveSession(first: unknown) {
  const session = useInterviewSession()
  session.acceptConsent()
  queue('/candidate/interview/start', first)
  session.confirmDevices()
  await flush()
  providers[0]!._emit('state', 'ready')
  await flush()
  return session
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

describe('hr_avatar start config', () => {
  it('maps the secret, the join inputs and the phrases onto StartConfig', async () => {
    const session = await liveSession(hrAvatarBody())

    expect(mockCreateProvider).toHaveBeenCalledWith('hr_avatar', false)
    expect(session.activeConfig.value).toEqual({
      dbSessionId: 42,
      sessionToken: 'CS',
      conversationUrl: undefined,
      endPhrase: 'Passiamo alla prossima domanda.',
      finalPhrase: 'Grazie.',
      hrAvatar: { baseUrl: 'https://hra.test', publishableKey: 'PK' },
    })
  })

  it('accepts the body as a valid start response', () => {
    expect(isValidStartResponse(hrAvatarBody())).toBe(true)
  })

  it.each([
    ['heygen', heygenBody],
    ['tavus', tavusBody],
  ])('leaves the hrAvatar key absent for a %s body', async (_name, body) => {
    const session = await liveSession(body())

    expect(session.activeConfig.value).not.toBeNull()
    expect('hrAvatar' in session.activeConfig.value!).toBe(false)
  })

  it('leaves the hrAvatar key absent when an hr_avatar body carries no join object', async () => {
    const session = await liveSession(hrAvatarBody({ hr_avatar: undefined }))

    expect('hrAvatar' in session.activeConfig.value!).toBe(false)
  })

  it('never sends live_conversation_id for an hr_avatar handle', async () => {
    await liveSession(hrAvatarBody())
    queue('/candidate/interview/end', {
      next_action: 'continue',
      ended_competencies: 1,
      total_competencies: 3,
    })
    queue('/candidate/interview/start', { ...hrAvatarBody(), session_id: 77 })

    providers[0]!._emit('state', 'complete')
    await flush()

    expect(starts()).toHaveLength(2)
    expect((starts()[1]![1] as { body?: unknown }).body).toBeUndefined()
    expect(mockCreateProvider).toHaveBeenCalledTimes(2)
  })
})
