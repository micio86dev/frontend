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

const {
  flag,
  captured,
  guards,
  storedSession,
  exitRedirect,
  mockCandidateFetch,
  mockCreateProvider,
  mockUseExitRedirect,
} = vi.hoisted(() => ({
  flag: { on: true },
  captured: {
    session: null as null | Record<string, unknown>,
    handover: null as null | { value: boolean },
  },
  // The options each guard was built with, so a test can fire its callbacks.
  guards: {
    tab: null as null | { onHiddenTimeout: () => void },
    network: null as null | { onOffline: () => void },
  },
  // ONE set of spies for every `useCandidateSession()` call: an Exit that cleared
  // the stored session would otherwise clear a throwaway object and pass.
  storedSession: { read: vi.fn(), clear: vi.fn(), store: vi.fn() },
  exitRedirect: { redirect: vi.fn(() => false), redirectToError: vi.fn(() => false) },
  mockCandidateFetch: vi.fn(),
  mockCreateProvider: vi.fn(),
  mockUseExitRedirect: vi.fn(),
}))

vi.mock('~/composables/useCandidateCallUi', () => ({ useCandidateCallUi: () => flag.on }))
vi.mock('~/composables/useExitRedirect', () => ({ useExitRedirect: mockUseExitRedirect }))
vi.mock('~/composables/useNetworkGuard', () => ({
  useNetworkGuard: (options: { onOffline: () => void }) => {
    guards.network = options
    return { start: vi.fn(), stop: vi.fn() }
  },
}))
vi.mock('~/composables/useTabVisibilityGuard', () => ({
  useTabVisibilityGuard: (options: { onHiddenTimeout: () => void }) => {
    guards.tab = options
    return { start: vi.fn(), stop: vi.fn() }
  },
}))
vi.mock('~/app/providers/factory', () => ({ createProvider: mockCreateProvider }))
vi.mock('~/app/utils/candidate-api', () => ({
  candidateFetch: mockCandidateFetch,
  flushIntegrityKeepalive: vi.fn(),
  CandidateUnauthorizedError: class CandidateUnauthorizedError extends Error {},
}))
vi.mock('~/composables/useCandidateSession', () => ({
  useCandidateSession: () => storedSession,
}))
// Hands the test the very session instance the component runs on.
vi.mock('~/composables/useInterviewSession', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/app/composables/useInterviewSession')>()
  return {
    ...real,
    useInterviewSession: (...args: Parameters<typeof real.useInterviewSession>) => {
      // `handoverInFlight` is swapped for a ref the test owns: the real one only
      // flips inside a HeyGen handover, which this spec does not stage.
      const handover = ref(false)
      const session = { ...real.useInterviewSession(...args), handoverInFlight: handover }
      captured.handover = handover
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

const mounted: Array<{ unmount: () => void }> = []

async function mountLive({ attach = false } = {}) {
  const { default: Component } = await import('~/components/InterviewSession.vue')
  const wrapper = mount(Component, {
    attachTo: attach ? document.body : undefined,
    global: {
      // Params are echoed so a test can read the deadline the copy was given.
      mocks: {
        $t: (key: string, params?: Record<string, unknown>) =>
          params ? `${key}|${JSON.stringify(params)}` : key,
      },
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
  mounted.push(wrapper)
  const session = captured.session as unknown as {
    acceptConsent: () => void
    confirmDevices: () => void
    advanceAttribution: (id: number) => unknown
    state: { value: string }
    pause: () => void
    resume: () => void
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
  guards.tab = null
  guards.network = null
  storedSession.read.mockReset()
  storedSession.read.mockReturnValue(null)
  mockUseExitRedirect.mockReturnValue({
    exitRedirectUrl: ref<string | null>(null),
    errorRedirectUrl: ref<string | null>(null),
    sessionFetchFailed: ref<'unauthenticated' | 'unavailable' | null>(null),
    fetchSession: vi.fn(async () => undefined),
    ...exitRedirect,
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
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  document.body.innerHTML = ''
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

  it('treats an entry with no role like the candidate: never displayed, still posted as it is today', async () => {
    // Every provider sets `role`, so this is a guard, not a live path. The display
    // filter is deliberately conservative: words that might be the candidate's are
    // never shown. The utterance path is a separate listener and is NOT filtered, so
    // a role-less entry is posted with the speaker it resolves to there (`avatar`,
    // since only `role: 'user'` maps to `candidate`) — pinned as observed, not endorsed.
    const { wrapper } = await mountLive()
    providers[0]!._emit('transcript', { role: 'avatar', text: 'First question', ts: 1 })
    await flushPromises()

    providers[0]!._emit('transcript', { text: 'Words of unknown origin', ts: 2 })
    await flushPromises()

    expect(caption(wrapper)).toBe('First question')
    expect(wrapper.text()).not.toContain('Words of unknown origin')
    expect(utterances()).toContainEqual(
      expect.objectContaining({
        session_id: FIRST,
        speaker: 'avatar',
        text: 'Words of unknown origin',
      })
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

// ---------------------------------------------------------------------------
// UI-07 — Exit suspends through the existing pause; the suspended wording is for
// a deliberate exit only.
// ---------------------------------------------------------------------------

const EXP = Date.UTC(2026, 9, 9, 14, 30) / 1000
const clock = new Intl.DateTimeFormat('it', { hour: '2-digit', minute: '2-digit' }).format(
  EXP * 1000
)

const exitButton = () => document.querySelector<HTMLButtonElement>('[data-testid="call-exit"]')!
const confirmButton = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="call-exit-confirm"]')!
const resumeButton = (wrapper: Awaited<ReturnType<typeof mountLive>>['wrapper']) =>
  wrapper.findAll('button').find((b) => b.text().includes('interview.paused.resume'))!

async function settle() {
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await flushPromises()
}

/** Click Exit, then "Suspend and leave". */
async function exitTheInterview() {
  exitButton().click()
  await settle()
  confirmButton().click()
  await settle()
}

describe('InterviewSession — Exit (flag on)', () => {
  it('confirming suspends through the existing pause, exactly once', async () => {
    const { wrapper, session } = await mountLive({ attach: true })
    const pause = vi.spyOn(session, 'pause')

    await exitTheInterview()

    expect(pause).toHaveBeenCalledTimes(1)
    expect(session.state.value).toBe('paused')
    expect(mockCandidateFetch).toHaveBeenCalledWith(
      '/candidate/interview/suspend',
      expect.anything()
    )
    expect(wrapper.find('[data-testid="paused-live-panel"]').exists()).toBe(true)
  })

  it('does not suspend until the candidate confirms', async () => {
    const { session } = await mountLive({ attach: true })
    const pause = vi.spyOn(session, 'pause')

    exitButton().click()
    await settle()

    expect(pause).not.toHaveBeenCalled()
    expect(session.state.value).toBe('live')
  })

  it('never uses the exit redirect and never clears the stored session', async () => {
    await mountLive({ attach: true })

    await exitTheInterview()

    expect(exitRedirect.redirect).not.toHaveBeenCalled()
    expect(exitRedirect.redirectToError).not.toHaveBeenCalled()
    expect(storedSession.clear).not.toHaveBeenCalled()
  })

  it('shows the suspended wording with the stored session deadline, and moves focus to its heading', async () => {
    storedSession.read.mockReturnValue({ exp: EXP })
    const { wrapper } = await mountLive({ attach: true })

    await exitTheInterview()

    const heading = wrapper.get('#paused-heading')
    expect(heading.text()).toBe('interview.call.suspended.title')
    expect(heading.attributes('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(heading.element)
    expect(wrapper.get('[data-testid="paused-live-panel"]').text()).toContain(
      `interview.call.suspended.body|${JSON.stringify({ time: clock })}`
    )
    expect(wrapper.text()).not.toContain('interview.paused.title')
    expect(wrapper.text()).not.toContain('interview.paused.body')
  })

  it('drops the deadline from the suspended wording when the stored session cannot be read', async () => {
    storedSession.read.mockReturnValue(null)
    const { wrapper } = await mountLive({ attach: true })

    await exitTheInterview()

    const panel = wrapper.get('[data-testid="paused-live-panel"]').text()
    expect(panel).toContain('interview.call.suspended.body_no_deadline')
    expect(panel).not.toContain('"time"')
  })

  it('Resume on the suspended screen calls session.resume()', async () => {
    const { wrapper, session } = await mountLive({ attach: true })
    const resume = vi.spyOn(session, 'resume')

    await exitTheInterview()
    await resumeButton(wrapper).trigger('click')

    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('disables the Exit button while a handover is in flight, never hides it', async () => {
    await mountLive({ attach: true })
    expect(exitButton().disabled).toBe(false)

    captured.handover!.value = true
    await settle()

    expect(exitButton()).not.toBeNull()
    expect(exitButton().disabled).toBe(true)
    expect(exitButton().getAttribute('aria-busy')).toBe('true')
  })

  it('keeps the existing paused copy for a manual pause', async () => {
    const { wrapper } = await mountLive({ attach: true })

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('interview.live.pause'))!
      .trigger('click')
    await settle()

    expect(wrapper.get('#paused-heading').text()).toBe('interview.paused.title')
    expect(wrapper.text()).not.toContain('interview.call.suspended')
    expect(wrapper.get('#paused-heading').attributes('tabindex')).toBeUndefined()
  })

  it('keeps the existing paused copy for a tab-hidden pause', async () => {
    const { wrapper } = await mountLive({ attach: true })

    guards.tab!.onHiddenTimeout()
    await settle()

    expect(wrapper.get('#paused-heading').text()).toBe('interview.paused.title')
    expect(wrapper.find('[data-testid="tab-hidden-warning"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('interview.call.suspended')
  })

  it('keeps the existing paused copy for a network pause', async () => {
    const { wrapper } = await mountLive({ attach: true })

    guards.network!.onOffline()
    await settle()

    expect(wrapper.get('#paused-heading').text()).toBe('interview.paused.title')
    expect(wrapper.find('[data-testid="network-reconnecting-notice"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('interview.call.suspended')
  })

  it('shows the plain paused copy again after an exit, resume and a tab-hidden pause', async () => {
    const { wrapper, session } = await mountLive({ attach: true })

    await exitTheInterview()
    expect(wrapper.get('#paused-heading').text()).toBe('interview.call.suspended.title')

    session.state.value = 'live'
    await settle()
    guards.tab!.onHiddenTimeout()
    await settle()

    expect(wrapper.get('#paused-heading').text()).toBe('interview.paused.title')
  })
})

describe('InterviewSession — Exit (flag off)', () => {
  it('renders no Exit button: the old screen is exactly as it was', async () => {
    flag.on = false
    await mountLive({ attach: true })

    expect(exitButton()).toBeNull()
  })
})
