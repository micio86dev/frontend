/**
 * invisible-competency-handover — D3/D5/D6 structural guarantees.
 *
 * `useInterviewSession()`'s composable-only tests (use-interview-session.spec.ts)
 * can prove state and call-argument correctness, but D3's central claim —
 * "`stop()` is called exactly once per provider session, structurally, because
 * removing a `ProviderSession` from `players` is what makes Vue unmount its
 * keyed `AvatarPlayer` instance" — can only be proven by actually mounting
 * `AvatarPlayer` (the REAL component, not a stub) inside a REAL keyed v-for
 * driven by the REAL composable. This file is that harness: it mirrors
 * exactly how `session.vue`'s player mount layer renders `session.players`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import AvatarPlayer from '~/app/components/AvatarPlayer.client.vue'
import { useInterviewSession } from '~/app/composables/useInterviewSession'
import type { SessionPlayer } from '~/app/composables/useInterviewSession'

// ---------------------------------------------------------------------------
// Hoisted mocks — mirrors use-interview-session.spec.ts's F4-fixed pattern.
// ---------------------------------------------------------------------------

const { mockCandidateFetch, mockCreateProvider, MockCandidateUnauthorizedError } = vi.hoisted(
  () => {
    const mockCandidateFetch = vi.fn()
    const mockCreateProvider = vi.fn()
    class MockCandidateUnauthorizedError extends Error {
      constructor(message = 'Candidate session unauthorized') {
        super(message)
        this.name = 'CandidateUnauthorizedError'
      }
    }
    return { mockCandidateFetch, mockCreateProvider, MockCandidateUnauthorizedError }
  }
)

vi.mock('~/app/providers/factory', () => ({
  createProvider: mockCreateProvider,
}))

vi.mock('~/app/utils/candidate-api', () => ({
  candidateFetch: mockCandidateFetch,
  flushIntegrityKeepalive: vi.fn(),
  CandidateUnauthorizedError: MockCandidateUnauthorizedError,
}))

vi.mock('~/app/composables/useCandidateSession', () => ({
  useCandidateSession: () => ({ clear: vi.fn(), read: vi.fn(), store: vi.fn() }),
}))

// ---------------------------------------------------------------------------
// Mock provider — a real InterviewProvider-shaped object per createProvider() call.
// ---------------------------------------------------------------------------

type EventCallback = (payload: unknown) => void

function createMockProvider() {
  const listeners = new Map<string, EventCallback[]>()
  function emit(evt: string, payload: unknown) {
    for (const cb of listeners.get(evt) ?? []) cb(payload)
  }
  const startMock = vi.fn(async () => ({ providerSessionId: 'mock' }))
  const stopMock = vi.fn(async () => undefined)

  return {
    on: vi.fn((evt: string, cb: EventCallback) => {
      listeners.set(evt, [...(listeners.get(evt) ?? []), cb])
    }),
    start: startMock,
    stop: stopMock,
    toggleMic: vi.fn(async () => undefined),
    setMicMuted: vi.fn(async () => undefined),
    nudgeWrapUp: vi.fn(),
    _emit: emit,
    _startMock: startMock,
    _stopMock: stopMock,
  }
}

let mockProviderRegistry: ReturnType<typeof createMockProvider>[] = []
function registerFreshMockProvider() {
  const instance = createMockProvider()
  mockProviderRegistry.push(instance)
  return instance
}

function makeStartResponse(
  overrides: { session_id?: number; provider?: string; question_index?: number } = {}
) {
  return {
    session_id: overrides.session_id ?? 1,
    provider: overrides.provider ?? 'heygen',
    provider_token: 'tok',
    conversation_url: null,
    // Required by the contract, so the fixture sends it — see the same note in
    // use-interview-session.spec.ts.
    audio_only: false,
    question_context: {
      competency_code: 'PRS',
      question_index: overrides.question_index ?? 0,
      end_phrase: 'Passiamo alla prossima domanda.',
      final_phrase: 'Grazie per il tuo tempo.',
    },
  }
}

// ---------------------------------------------------------------------------
// Harness — mirrors session.vue's player mount layer EXACTLY: one keyed
// v-for over `session.players`, each entry a real <AvatarPlayer>.
// ---------------------------------------------------------------------------

const Harness = defineComponent({
  setup() {
    const session = useInterviewSession()
    return { session }
  },
  render() {
    return h(
      'div',
      this.session.players.value.map((p: SessionPlayer) =>
        h(AvatarPlayer, {
          key: p.key,
          provider: p.provider,
          config: p.config,
          muted: p.muted,
          onPainted: () => this.session.notifyPainted(p.key),
        })
      )
    )
  },
})

async function paint(wrapper: ReturnType<typeof mount>, index: number) {
  const players = wrapper.findAllComponents(AvatarPlayer)
  players[index]!.find('video').element.dispatchEvent(new Event('loadeddata'))
  await nextTick()
}

async function flushPromises() {
  for (let i = 0; i < 5; i++) await nextTick()
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCandidateFetch.mockReset()
  vi.useFakeTimers()
  mockProviderRegistry = []
  mockCreateProvider.mockImplementation(() => registerFreshMockProvider())
  vi.stubGlobal(
    'useRuntimeConfig',
    vi.fn(() => ({ public: { apiBase: 'https://api.test', interviewProviderMock: 'false' } }))
  )
  vi.stubGlobal('window', globalThis.window)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Drives the harness to `live` with a single HeyGen session (session_id 42). */
async function mountLive() {
  const wrapper = mount(Harness, { global: { mocks: { $t: (key: string) => key } } })
  const session = (wrapper.vm as unknown as { session: ReturnType<typeof useInterviewSession> })
    .session
  session.acceptConsent()
  mockCandidateFetch.mockResolvedValueOnce(makeStartResponse({ session_id: 42 }))
  session.confirmDevices()
  await flushPromises()
  mockProviderRegistry[0]!._emit('state', 'ready')
  await flushPromises()
  expect(session.state.value).toBe('live')
  return { wrapper, session }
}

/** From `live`, begins a HeyGen handover: complete → /end continue → incoming /start resolves. */
async function beginHandover(
  wrapper: ReturnType<typeof mount>,
  session: ReturnType<typeof useInterviewSession>
) {
  mockCandidateFetch.mockResolvedValueOnce({
    ended_competencies: 1,
    total_competencies: 3,
    next_action: 'continue',
  })
  mockCandidateFetch.mockResolvedValueOnce(makeStartResponse({ session_id: 99, question_index: 1 }))

  mockProviderRegistry[0]!._emit('state', 'complete')
  await flushPromises()

  expect(session.state.value).toBe('live') // never enters connecting (D2)
  expect(mockProviderRegistry.length).toBe(2)
  await nextTick() // let Vue mount the newly-added incoming <AvatarPlayer>

  return { outgoing: mockProviderRegistry[0]!, incoming: mockProviderRegistry[1]! }
}

describe('invisible-competency-handover — D3: exactly-once teardown across all exit paths', () => {
  it('2.4 — happy path: incoming paints, promotes, outgoing unmounts and stops exactly once', async () => {
    const { wrapper, session } = await mountLive()
    const { outgoing, incoming } = await beginHandover(wrapper, session)

    expect(wrapper.findAllComponents(AvatarPlayer)).toHaveLength(2)

    await paint(wrapper, 1) // the incoming's <video> fires loadeddata

    // Crossfade delay (200ms) before promote() actually runs.
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()

    expect(session.state.value).toBe('live')
    expect(outgoing._stopMock).toHaveBeenCalledTimes(1)
    expect(incoming._stopMock).not.toHaveBeenCalled()
    expect(wrapper.findAllComponents(AvatarPlayer)).toHaveLength(1)

    // D6 remount trap: the promoted instance is the SAME component instance
    // that was rendering as `incoming` — never unmounted+remounted.
    const survivingProvider = wrapper.findAllComponents(AvatarPlayer)[0]!.props('provider')
    expect(survivingProvider).toBe(incoming)
  })

  it('2.5 — bound exceeded: outgoing releases and stops exactly once; incoming survives, never stopped', async () => {
    const { wrapper, session } = await mountLive()
    const { outgoing, incoming } = await beginHandover(wrapper, session)

    // The incoming never paints.
    await vi.advanceTimersByTimeAsync(10_000)
    await flushPromises()

    expect(session.state.value).toBe('connecting')
    expect(outgoing._stopMock).toHaveBeenCalledTimes(1)
    expect(incoming._stopMock).not.toHaveBeenCalled()
    // The incoming's AvatarPlayer is STILL mounted — D5's "stays in its
    // slot, promoted when it eventually paints."
    expect(wrapper.findAllComponents(AvatarPlayer)).toHaveLength(1)
    expect(wrapper.findAllComponents(AvatarPlayer)[0]!.props('provider')).toBe(incoming)
  })

  it('2.6 — incoming errors mid-overlap: BOTH release and stop exactly once each; error screen shown', async () => {
    const { wrapper, session } = await mountLive()
    const { outgoing, incoming } = await beginHandover(wrapper, session)

    incoming._emit('error', { code: 'sdk_error', message: 'incoming failed' })
    await flushPromises()

    expect(session.state.value).toBe('error')
    expect(outgoing._stopMock).toHaveBeenCalledTimes(1)
    expect(incoming._stopMock).toHaveBeenCalledTimes(1)
    expect(wrapper.findAllComponents(AvatarPlayer)).toHaveLength(0)
  })

  it('C2 — an explicit teardown() and the structural AvatarPlayer unmount both reach for the SAME session; the underlying stop() still fires exactly once', async () => {
    // Four-lens review C2: before the wrapping this diff adds, `teardown()`'s
    // own explicit `stop()` and `AvatarPlayer:onUnmounted`'s structural
    // `stop()` (fired once the nulled ref drops the player out of
    // `players`) both reach the same provider — "exactly once" held only by
    // a call-ordering coincidence with zero redundancy. This drives BOTH
    // paths against the SAME session and proves the underlying teardown
    // still runs at most once.
    const { wrapper, session } = await mountLive()
    const live = mockProviderRegistry[0]!

    await session.teardown()
    await flushPromises() // let Vue's own reactive unmount ALSO run

    expect(live._stopMock).toHaveBeenCalledTimes(1)
    expect(wrapper.findAllComponents(AvatarPlayer)).toHaveLength(0)
  })

  it('C2 — the incoming, mid-overlap, gets the same double-reach: teardown() explicit + structural unmount → exactly one real stop()', async () => {
    const { wrapper, session } = await mountLive()
    const { outgoing, incoming } = await beginHandover(wrapper, session)

    await session.teardown()
    await flushPromises()

    expect(outgoing._stopMock).toHaveBeenCalledTimes(1)
    expect(incoming._stopMock).toHaveBeenCalledTimes(1)
  })

  it('2.7 — page unmount mid-overlap: BOTH release and stop exactly once each (structural — the whole players subtree unmounts)', async () => {
    // Deliberately NOT combined with session.teardown() here: teardown()'s
    // OWN explicit stop() calls are pre-existing (kept for an immediate
    // guarantee during navigation, see useInterviewSession.ts) and are
    // already covered by use-interview-session.spec.ts's dedicated
    // `teardown()` test. This test isolates the STRUCTURAL guarantee this
    // change adds: unmounting the players subtree alone — with no explicit
    // stop() call site of its own — still releases both sessions exactly
    // once each, via AvatarPlayer's existing onUnmounted.
    const { wrapper, session } = await mountLive()
    const { outgoing, incoming } = await beginHandover(wrapper, session)

    wrapper.unmount()
    await flushPromises()

    expect(outgoing._stopMock).toHaveBeenCalledTimes(1)
    expect(incoming._stopMock).toHaveBeenCalledTimes(1)
  })
})
