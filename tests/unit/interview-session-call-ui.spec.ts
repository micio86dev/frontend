/**
 * InterviewSession.vue behind the `candidateCallUi` flag
 * (candidate-interview-call-ui). Grows slice by slice; UI-04 is the written
 * question: only the avatar's words are displayed, and only the DISPLAY is
 * filtered.
 *
 * Unlike the neighbouring page specs this one runs the REAL `useInterviewSession`
 * (provider factory and network layer mocked, as in
 * use-interview-session-attribution.spec.ts) and a player stub that forwards the
 * provider's `transcript` events exactly as `AvatarPlayer` does. That is the only
 * way to prove the second half of the rule: a candidate entry never reaches the
 * screen but still reaches `POST /candidate/interview/utterance`, because the
 * server needs it. A mocked session cannot show that.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref, defineComponent, h } from 'vue'
import type { InterviewProvider } from '~/app/types/interview-provider'

vi.setConfig({ testTimeout: 30000 })

const { flag, captured, mockCandidateFetch, mockCreateProvider, mockUseExitRedirect } = vi.hoisted(
  () => ({
    flag: { on: true },
    captured: { session: null as null | Record<string, unknown> },
    mockCandidateFetch: vi.fn(),
    mockCreateProvider: vi.fn(),
    mockUseExitRedirect: vi.fn(),
  })
)

vi.mock('~/composables/useCandidateCallUi', () => ({ useCandidateCallUi: () => flag.on }))
vi.mock('~/composables/useExitRedirect', () => ({ useExitRedirect: mockUseExitRedirect }))
vi.mock('~/composables/useNetworkGuard', () => ({
  useNetworkGuard: () => ({ start: vi.fn(), stop: vi.fn() }),
}))
vi.mock('~/composables/useTabVisibilityGuard', () => ({
  useTabVisibilityGuard: () => ({ start: vi.fn(), stop: vi.fn() }),
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
// Hands the test the very session instance the component runs on.
vi.mock('~/composables/useInterviewSession', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/app/composables/useInterviewSession')>()
  return {
    ...real,
    useInterviewSession: (...args: Parameters<typeof real.useInterviewSession>) => {
      const session = real.useInterviewSession(...args)
      captured.session = session as unknown as Record<string, unknown>
      return session
    },
  }
})

type Listener = (payload: unknown) => void

function createMockProvider() {
  const listeners = new Map<string, Listener[]>()
  return {
    on: vi.fn((evt: string, cb: Listener) => {
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

const FIRST = 42
const NEXT = 77

function startResponse(sessionId: number) {
  return {
    session_id: sessionId,
    provider: 'tavus',
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

/** Mirrors `AvatarPlayer`: re-emits the provider's own events upwards. */
const AvatarPlayerStub = defineComponent({
  name: 'AvatarPlayer',
  props: {
    provider: { type: Object, required: true },
    config: { type: Object, required: true },
    muted: { type: Boolean, default: false },
    overlay: { type: Boolean, default: false },
    audioOnly: { type: Boolean, default: false },
  },
  emits: ['painted', 'state', 'transcript', 'error'],
  setup(props, { emit }) {
    const provider = props.provider as unknown as InterviewProvider
    provider.on('transcript', (payload) => emit('transcript', payload))
    return () => h('div', { 'data-testid': 'avatar-player' })
  },
})

const InterviewCaptionStub = defineComponent({
  name: 'InterviewCaption',
  props: { text: { type: String, required: true } },
  setup: (props) => () => h('p', { 'data-testid': 'caption' }, props.text),
})

async function mountLive() {
  const { default: Component } = await import('~/components/InterviewSession.vue')
  const wrapper = mount(Component, {
    global: {
      mocks: { $t: (key: string) => key },
      stubs: {
        ClientOnly: defineComponent({
          setup:
            (_p, { slots }) =>
            () =>
              h('div', slots.default?.()),
        }),
        AvatarPlayer: AvatarPlayerStub,
        InterviewCaption: InterviewCaptionStub,
        DeviceCheck: true,
        ProctorOverlay: true,
        InterviewTimer: true,
        InterviewProgressBar: true,
      },
    },
  })
  const session = captured.session as unknown as {
    acceptConsent: () => void
    confirmDevices: () => void
    advanceAttribution: (id: number) => unknown
    state: { value: string }
  }

  session.acceptConsent()
  mockCandidateFetch.mockResolvedValueOnce(startResponse(FIRST))
  session.confirmDevices()
  await flushPromises()
  providers[0]!._emit('state', 'ready')
  await flushPromises()
  expect(session.state.value).toBe('live')

  return { wrapper, session }
}

function utterances() {
  return mockCandidateFetch.mock.calls
    .filter((call: unknown[]) => call[0] === '/candidate/interview/utterance')
    .map((call: unknown[]) => (call[1] as { body: Record<string, unknown> }).body)
}

/** What the candidate reads: the band with the flag on, the legacy caption with it off. */
const caption = (wrapper: Awaited<ReturnType<typeof mountLive>>['wrapper']) => {
  if (!flag.on) return wrapper.get('[data-testid="caption"]').text()
  const question = wrapper.find('[data-testid="call-question"] p:not([data-testid])')
  return question.exists() ? question.text() : ''
}

const hint = (wrapper: Awaited<ReturnType<typeof mountLive>>['wrapper']) =>
  wrapper.find('[data-testid="call-question-hint"]')

beforeEach(() => {
  vi.clearAllMocks()
  flag.on = true
  captured.session = null
  providers = []
  mockCandidateFetch.mockReset()
  mockCandidateFetch.mockResolvedValue(undefined)
  mockCreateProvider.mockImplementation(() => {
    const provider = createMockProvider()
    providers.push(provider)
    return provider
  })
  mockUseExitRedirect.mockReturnValue({
    exitRedirectUrl: ref<string | null>(null),
    errorRedirectUrl: ref<string | null>(null),
    sessionFetchFailed: ref<'unauthenticated' | 'unavailable' | null>(null),
    fetchSession: vi.fn(async () => undefined),
    redirect: vi.fn(() => false),
    redirectToError: vi.fn(() => false),
  })
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useHead', vi.fn())
  vi.stubGlobal(
    'useI18n',
    vi.fn(() => ({ t: (key: string) => key, locale: ref('it') }))
  )
  vi.stubGlobal(
    'useRuntimeConfig',
    vi.fn(() => ({ public: { apiBase: 'https://api.test', interviewProviderMock: 'false' } }))
  )
  vi.stubGlobal('navigateTo', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('InterviewSession — the written question (flag on)', () => {
  it('renders the question band instead of the legacy caption', async () => {
    const { wrapper } = await mountLive()
    providers[0]!._emit('transcript', { role: 'avatar', text: 'First question', ts: 1 })
    await flushPromises()

    expect(wrapper.get('[data-testid="call-question"]').text()).toBe('First question')
    expect(wrapper.find('[data-testid="caption"]').exists()).toBe(false)
  })

  it("shows the avatar's utterance and replaces it with the next one", async () => {
    const { wrapper } = await mountLive()

    providers[0]!._emit('transcript', { role: 'avatar', text: 'First question', ts: 1 })
    await flushPromises()
    expect(caption(wrapper)).toBe('First question')

    providers[0]!._emit('transcript', { role: 'avatar', text: 'A follow-up', ts: 2 })
    await flushPromises()
    expect(caption(wrapper)).toBe('A follow-up')
  })

  it("never shows the candidate's words, but still posts them as the candidate's utterance", async () => {
    const { wrapper } = await mountLive()
    providers[0]!._emit('transcript', { role: 'avatar', text: 'First question', ts: 1 })
    await flushPromises()

    providers[0]!._emit('transcript', { role: 'user', text: 'My spoken answer', ts: 2 })
    await flushPromises()

    expect(caption(wrapper)).toBe('First question')
    expect(wrapper.text()).not.toContain('My spoken answer')
    expect(utterances()).toContainEqual(
      expect.objectContaining({
        session_id: FIRST,
        speaker: 'candidate',
        text: 'My spoken answer',
      })
    )
    expect(utterances()).toContainEqual(
      expect.objectContaining({ session_id: FIRST, speaker: 'avatar', text: 'First question' })
    )
  })

  it('keeps the hint when the first thing heard is the candidate', async () => {
    const { wrapper } = await mountLive()

    providers[0]!._emit('transcript', { role: 'user', text: 'Hello?', ts: 1 })
    await flushPromises()

    expect(caption(wrapper)).toBe('')
    expect(hint(wrapper).exists()).toBe(true)
    expect(utterances()).toContainEqual(
      expect.objectContaining({ speaker: 'candidate', text: 'Hello?' })
    )
  })

  it('clears the band to the hint when a new session id arrives', async () => {
    const { wrapper, session } = await mountLive()
    providers[0]!._emit('transcript', { role: 'avatar', text: 'Closing phrase', ts: 1 })
    await flushPromises()
    expect(caption(wrapper)).toBe('Closing phrase')

    session.advanceAttribution(NEXT)
    await flushPromises()

    expect(caption(wrapper)).toBe('')
    expect(hint(wrapper).exists()).toBe(true)

    providers[0]!._emit('transcript', { role: 'avatar', text: 'Second competency', ts: 2 })
    await flushPromises()
    expect(caption(wrapper)).toBe('Second competency')
  })
})

describe('InterviewSession — the legacy caption (flag off)', () => {
  it('renders the legacy caption and hint, not the question band', async () => {
    flag.on = false
    const { wrapper } = await mountLive()

    expect(wrapper.find('[data-testid="caption"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="live-hint"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="call-question"]').exists()).toBe(false)
  })

  it('behaves exactly as before: whatever the provider says is the caption, and a new session does not clear it', async () => {
    flag.on = false
    const { wrapper, session } = await mountLive()

    providers[0]!._emit('transcript', { role: 'avatar', text: 'First question', ts: 1 })
    providers[0]!._emit('transcript', { role: 'user', text: 'My spoken answer', ts: 2 })
    await flushPromises()
    expect(caption(wrapper)).toBe('My spoken answer')

    session.advanceAttribution(NEXT)
    await flushPromises()
    expect(caption(wrapper)).toBe('My spoken answer')
  })
})
