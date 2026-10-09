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
import { ref, defineComponent, h, markRaw, onMounted, onUnmounted } from 'vue'
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
  speakerTurn,
} = vi.hoisted(() => ({
  // `raw` overrides what the runtime config carries, so a test can feed the REAL
  // `useCandidateCallUi` a value that is neither 'true' nor empty ('1', 'yes').
  flag: { on: true, raw: undefined as unknown },
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
  // What the page handed `useSpeakerTurn`, and the signal it gets back. The
  // composable's own rules are proven in use-speaker-turn.spec.ts; here only the
  // wiring is: which inputs it is given and what the tiles do with its answer.
  speakerTurn: {
    options: null as null | Record<string, { value: unknown }>,
    speaker: null as null | { value: 'avatar' | 'candidate' | 'none' },
  },
}))

vi.mock('~/composables/useExitRedirect', () => ({ useExitRedirect: mockUseExitRedirect }))
vi.mock('~/composables/useSpeakerTurn', async () => {
  const { ref: vueRef } = await import('vue')
  return {
    useSpeakerTurn: (options: Record<string, { value: unknown }>) => {
      speakerTurn.options = options
      const speaker = vueRef<'avatar' | 'candidate' | 'none'>('none')
      speakerTurn.speaker = speaker
      return { speaker, stop: vi.fn() }
    },
  }
})
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
  // The session wraps `provider.stop` to run at most once; the raw mock is kept so
  // a test can count what really reached the provider.
  const rawStop = vi.fn(async () => undefined)
  return {
    on: vi.fn((evt: string, cb: Listener) => {
      listeners.set(evt, [...(listeners.get(evt) ?? []), cb])
    }),
    start: vi.fn(async () => ({ providerSessionId: 'p' })),
    stop: rawStop,
    _rawStop: rawStop,
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

/** Mounts and unmounts of the player stub: the R1 guarantee counts instances, not renders. */
const playerLifecycle = { mounted: 0, unmounted: 0 }

/** Mirrors `AvatarPlayer`: re-emits the provider's own events upwards and stops its provider when it unmounts. */
const AvatarPlayerStub = defineComponent({
  name: 'AvatarPlayer',
  props: {
    provider: { type: Object, required: true },
    config: { type: Object, required: true },
    muted: { type: Boolean, default: false },
    overlay: { type: Boolean, default: false },
    audioOnly: { type: Boolean, default: false },
  },
  emits: ['painted', 'state', 'stream', 'transcript', 'error'],
  setup(props, { emit }) {
    const provider = props.provider as unknown as InterviewProvider
    provider.on('transcript', (payload) => emit('transcript', payload))
    provider.on('state', (payload) => emit('state', payload))
    onMounted(() => {
      playerLifecycle.mounted += 1
    })
    onUnmounted(() => {
      playerLifecycle.unmounted += 1
      void provider.stop()
    })
    return () => h('div', { 'data-testid': 'avatar-player' })
  },
})

const DeviceCheckStub = defineComponent({
  name: 'DeviceCheck',
  emits: ['confirmed'],
  setup: () => () => h('div', { 'data-testid': 'device-check' }),
})

/** Counts how often the proctoring overlay is mounted: it must exist only while live. */
const overlayLifecycle = { mounted: 0, unmounted: 0 }
const ProctorOverlayStub = defineComponent({
  name: 'ProctorOverlay',
  props: { stream: { type: Object, required: true }, sessionId: { type: Number, default: null } },
  setup() {
    onMounted(() => {
      overlayLifecycle.mounted += 1
    })
    onUnmounted(() => {
      overlayLifecycle.unmounted += 1
    })
    return () => h('div', { 'data-testid': 'proctor-overlay' })
  },
})

/** The question counter: records how often it is created and what it was started from. */
const timerLifecycle = { mounted: 0 }
const InterviewTimerCounterStub = defineComponent({
  name: 'InterviewTimer',
  props: { seconds: { type: Number, required: true }, label: { type: String, default: '' } },
  emits: ['tick', 'expired'],
  setup(props) {
    timerLifecycle.mounted += 1
    return () =>
      h('div', { 'data-testid': 'question-timer', 'data-seconds': String(props.seconds) })
  },
})

/** Props the own tile was given. */
const CallSelfViewStub = defineComponent({
  name: 'CallSelfView',
  props: {
    stream: { type: Object, required: true },
    speaking: { type: Boolean, default: false },
    speakingLabel: { type: String, default: '' },
  },
  setup: (props) => () =>
    h('div', {
      'data-testid': 'call-self-view',
      'data-speaking': String(props.speaking),
      'data-speaking-label': props.speakingLabel,
    }),
})

/** A stream that carries no tracks: enough for the wiring, which never reads one. */
function fakeStream(): MediaStream {
  // Raw, like a real MediaStream: Vue never wraps a host object in a reactive proxy.
  return markRaw({
    getVideoTracks: () => [],
    getAudioTracks: () => [],
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }) as unknown as MediaStream
}

const InterviewCaptionStub = defineComponent({
  name: 'InterviewCaption',
  props: { text: { type: String, required: true } },
  setup: (props) => () => h('p', { 'data-testid': 'caption' }, props.text),
})

const mounted: Array<{ unmount: () => void }> = []

async function mountLive({
  attach = false,
  stream = null,
  stubs = {},
  provider = 'tavus',
  ready = true,
  props = {},
}: {
  attach?: boolean
  /** Which provider the first /start names; only a HeyGen competency hands over. */
  provider?: string
  /** False stops at `connecting`: the provider is published but has not reported ready. */
  ready?: boolean
  /** Props for the session component, e.g. `{ embedded: true }`. */
  props?: Record<string, unknown>
  /** Confirms the device check with this stream, as the real flow does. */
  stream?: MediaStream | null
  stubs?: Record<string, unknown>
} = {}) {
  const { default: Component } = await import('~/components/InterviewSession.vue')
  const wrapper = mount(Component, {
    props,
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
        DeviceCheck: stream ? DeviceCheckStub : true,
        ProctorOverlay: true,
        CallSelfView: CallSelfViewStub,
        InterviewTimer: true,
        InterviewProgressBar: true,
        ...stubs,
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
  mockCandidateFetch.mockResolvedValueOnce(startResponse(FIRST, provider))
  if (stream) {
    await flushPromises()
    wrapper.findComponent(DeviceCheckStub).vm.$emit('confirmed', stream, 'mic-1')
  } else {
    session.confirmDevices()
  }
  await flushPromises()
  if (!ready) return { wrapper, session }
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
  flag.raw = undefined
  playerLifecycle.mounted = 0
  playerLifecycle.unmounted = 0
  overlayLifecycle.mounted = 0
  overlayLifecycle.unmounted = 0
  timerLifecycle.mounted = 0
  speakerTurn.options = null
  speakerTurn.speaker = null
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
    vi.fn(() => ({
      public: {
        apiBase: 'https://api.test',
        interviewProviderMock: 'false',
        candidateCallUi: flag.raw !== undefined ? flag.raw : flag.on ? 'true' : '',
      },
    }))
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

  it("keeps the existing paused copy for a manual pause (the old screen's Pause button; the call screen has none)", async () => {
    flag.on = false
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

  it('shows the plain paused copy for a network pause after an exit and a real resume', async () => {
    const { wrapper, session } = await mountLive({ attach: true })

    await exitTheInterview()
    expect(wrapper.get('#paused-heading').text()).toBe('interview.call.suspended.title')

    mockCandidateFetch.mockResolvedValueOnce(startResponse(FIRST + 1))
    await resumeButton(wrapper).trigger('click')
    await settle()
    providers[1]!._emit('state', 'ready')
    await settle()
    expect(session.state.value).toBe('live')
    guards.network!.onOffline()
    await settle()

    expect(wrapper.get('#paused-heading').text()).toBe('interview.paused.title')
    expect(wrapper.find('[data-testid="network-reconnecting-notice"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('interview.call.suspended')
  })
})

describe('InterviewSession — Exit (flag off)', () => {
  it('renders no Exit button: the old screen is exactly as it was', async () => {
    flag.on = false
    await mountLive({ attach: true })

    expect(exitButton()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// UI-09 — the stage, assembled behind the flag.
// ---------------------------------------------------------------------------

describe('InterviewSession — the live tree with the flag off (characterization)', () => {
  // Recorded from the code before the stage was assembled (develop at UI-08). Only the exact string 'true'
  // (or the boolean) switches the call screen on, so these values must all render
  // the old screen, byte for byte.
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['1', '1'],
    ['yes', 'yes'],
    ['false', 'false'],
  ])('renders the old live screen byte for byte when the flag is %s', async (_label, raw) => {
    flag.on = false
    flag.raw = raw === undefined ? '' : raw
    const { wrapper } = await mountLive()

    // Elements, attributes and text. Comment nodes (the template's own comments and
    // Vue's `v-if` placeholders) are not part of what a candidate gets.
    const tree = wrapper
      .html()
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\n[ \t]*(?=\n)/g, '')
    await expect(tree).toMatchFileSnapshot('./__snapshots__/interview-session-live-flag-off.snap')
  })
})

type Mounted = Awaited<ReturnType<typeof mountLive>>['wrapper']

const layer = (wrapper: Mounted) => wrapper.get('[data-slot="avatar-layer"]').element
const layout = (wrapper: Mounted) => wrapper.get('[data-slot="call-layout"]').element

/** The grid child that holds `el`: a stage part sits one wrapper below the layout. */
const gridChildOf = (wrapper: Mounted, el: Element) => {
  let node: Element | null = el
  while (node && node.parentElement !== layout(wrapper)) node = node.parentElement
  return node
}

/** What the end of a competency reports, and the next /start for a HeyGen handover. */
async function beginHandover(session: { state: { value: string } }) {
  mockCandidateFetch.mockResolvedValueOnce({
    ended_competencies: 1,
    total_competencies: 3,
    next_action: 'continue',
  })
  mockCandidateFetch.mockResolvedValueOnce(startResponse(NEXT, 'heygen'))
  providers[0]!._emit('state', 'complete')
  await settle()
  expect(session.state.value).toBe('live')
}

describe('InterviewSession — the stage (flag on)', () => {
  it('renders the four stage parts and none of the old live chrome', async () => {
    const { wrapper } = await mountLive({ stream: fakeStream() })

    for (const gone of ['interview-status', 'live-dock', 'question-label']) {
      expect(wrapper.find(`[data-testid="${gone}"]`).exists(), gone).toBe(false)
    }
    expect(wrapper.findAll('button').some((b) => b.text().includes('interview.live.pause'))).toBe(
      false
    )
    expect(wrapper.find('[data-testid="live-hint"]').exists()).toBe(false)

    const parts = {
      question: wrapper.get('[data-testid="call-question"]').element,
      panel: wrapper.get('[data-testid="call-panel"]').element,
      own: wrapper.get('[data-testid="call-self-view"]').element,
    }
    // Siblings of the player layer: each one is a grid child of the same layout.
    expect(layer(wrapper).parentElement).toBe(layout(wrapper))
    for (const part of Object.values(parts)) {
      const cell = gridChildOf(wrapper, part)
      expect(cell).not.toBeNull()
      expect(cell).not.toBe(layer(wrapper))
    }
  })

  it('puts Exit and then the help link in the panel, and the timer in the panel only', async () => {
    const { wrapper } = await mountLive({
      attach: true,
      stubs: { InterviewTimer: InterviewTimerCounterStub },
    })

    const panel = wrapper.get('[data-testid="call-panel"]').element
    const exit = panel.querySelector('[data-testid="call-exit"]')!
    const help = panel.querySelector('[data-testid="call-help-link"]')!
    expect(exit.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(wrapper.findAll('[data-testid="question-timer"]')).toHaveLength(1)
    expect(panel.querySelector('[data-testid="question-timer"]')).not.toBeNull()
  })

  it('draws no own tile until the device check has confirmed a stream', async () => {
    const { wrapper } = await mountLive()

    expect(wrapper.find('[data-testid="call-self-view"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="call-panel"]').exists()).toBe(true)
  })

  it('shows the server counters, and never the competency', async () => {
    const { wrapper, session } = await mountLive()
    const store = session as unknown as {
      endedCompetencies: { value: number | null }
      totalCompetencies: { value: number | null }
    }
    expect(wrapper.get('[data-testid="call-panel"]').text()).not.toContain(
      'interview.call.progress'
    )

    store.endedCompetencies.value = 1
    store.totalCompetencies.value = 3
    await flushPromises()

    const panel = wrapper.get('[data-testid="call-panel"]')
    expect(panel.get('[data-testid="call-panel-progress-text"]').text()).toBe(
      `interview.call.progress|${JSON.stringify({ n: 2, total: 3 })}`
    )
    // The start response carried the code `PRS`; nothing on the stage may reveal it.
    expect(wrapper.html()).not.toContain('PRS')
  })

  it('lights the interviewer tile, and only it, while the avatar speaks', async () => {
    const { wrapper } = await mountLive({ stream: fakeStream() })
    const tile = () => wrapper.get('[data-slot="avatar-layer"] [data-slot="call-tile"]')
    const own = () => wrapper.get('[data-testid="call-self-view"]')
    expect(tile().attributes('data-speaking')).toBe('false')

    speakerTurn.speaker!.value = 'avatar'
    await flushPromises()
    expect(tile().attributes('data-speaking')).toBe('true')
    expect(tile().text()).toContain('interview.call.avatar_speaking')
    expect(own().attributes('data-speaking')).toBe('false')

    speakerTurn.speaker!.value = 'candidate'
    await flushPromises()
    expect(tile().attributes('data-speaking')).toBe('false')
    expect(own().attributes('data-speaking')).toBe('true')
    expect(own().attributes('data-speaking-label')).toBe('interview.call.candidate_speaking')
  })

  it('feeds the speaker signal the session state, the live provider state, the avatar stream and the mic', async () => {
    const mic = fakeStream()
    const avatar = fakeStream()
    const { wrapper, session } = await mountLive({ stream: mic })
    const inputs = speakerTurn.options!

    expect(inputs.state).toBe((session as unknown as { state: unknown }).state)
    expect(inputs.micStream!.value).toBe(mic)
    expect(inputs.providerState!.value).toBe('ready')
    expect(inputs.avatarStream!.value).toBeNull()

    providers[0]!._emit('state', 'speaking')
    wrapper.findComponent(AvatarPlayerStub).vm.$emit('stream', avatar)
    await flushPromises()

    expect(inputs.providerState!.value).toBe('speaking')
    expect(inputs.avatarStream!.value).toBe(avatar)
  })

  it('counts the elapsed time only while live, and keeps it across a suspension', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    try {
      const { wrapper, session } = await mountLive({ attach: true })
      ;(session as unknown as { totalCompetencies: { value: number } }).totalCompetencies.value = 3
      await flushPromises()
      const duration = () => wrapper.get('[data-testid="call-panel-duration-value"]').text()
      const shown = (elapsed: string) =>
        `interview.call.duration_value|${JSON.stringify({ elapsed, total: '15:00' })}`
      expect(duration()).toBe(shown('00:00'))

      await vi.advanceTimersByTimeAsync(65_000)
      expect(duration()).toBe(shown('01:05'))

      await exitTheInterview()
      await vi.advanceTimersByTimeAsync(120_000)

      mockCandidateFetch.mockResolvedValueOnce(startResponse(FIRST + 1))
      await resumeButton(wrapper).trigger('click')
      await settle()
      providers[1]!._emit('state', 'ready')
      await settle()
      expect(session.state.value).toBe('live')
      expect(duration()).toBe(shown('01:05'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts the question counter again for every competency session, and ends the question when it expires', async () => {
    const { wrapper, session } = await mountLive({
      stubs: { InterviewTimer: InterviewTimerCounterStub },
    })
    const timer = () => wrapper.getComponent(InterviewTimerCounterStub)
    expect(timerLifecycle.mounted).toBe(1)
    expect(timer().props('seconds')).toBe(300)

    timer().vm.$emit('tick', 120)
    await flushPromises()
    expect(timer().props('seconds')).toBe(120)
    expect(timerLifecycle.mounted).toBe(1)

    session.advanceAttribution(NEXT)
    await flushPromises()
    expect(timerLifecycle.mounted).toBe(2)
    expect(timer().props('seconds')).toBe(300)

    const endQuestion = vi.spyOn(
      session as unknown as { endQuestion: (reason: string) => Promise<void> },
      'endQuestion'
    )
    timer().vm.$emit('expired')
    await flushPromises()
    expect(endQuestion).toHaveBeenCalledWith('timeout')
  })

  it('moves the toaster to the top left', async () => {
    const { wrapper } = await mountLive({
      stubs: {
        IntegrityToaster: defineComponent({
          props: { position: String },
          setup: (p) => () => h('i', { 'data-testid': 'toaster', 'data-position': p.position }),
        }),
      },
    })

    expect(wrapper.get('[data-testid="toaster"]').attributes('data-position')).toBe('top-left')
  })

  it('widens the canvas for the call, and only while the call is live', async () => {
    const { wrapper } = await mountLive()

    expect(wrapper.get('header').classes()).toContain('max-w-[96rem]')
    expect(wrapper.get('main').classes()).toContain('max-w-[96rem]')
  })

  it('mounts the proctoring overlay only while live and unmounts it on suspend', async () => {
    const { wrapper, session } = await mountLive({
      attach: true,
      stream: fakeStream(),
      stubs: { ProctorOverlay: ProctorOverlayStub },
    })
    expect(session.state.value).toBe('live')
    expect(overlayLifecycle.mounted).toBe(1)
    expect(wrapper.find('[data-testid="proctor-overlay"]').exists()).toBe(true)

    await exitTheInterview()

    expect(session.state.value).toBe('paused')
    expect(wrapper.find('[data-testid="proctor-overlay"]').exists()).toBe(false)
    expect(overlayLifecycle.unmounted).toBe(1)
    expect(overlayLifecycle.mounted).toBe(1)
  })

  it('does not mount the overlay, or widen the canvas, before the interview is live', async () => {
    const { wrapper, session } = await mountLive({
      stream: fakeStream(),
      ready: false,
      stubs: { ProctorOverlay: ProctorOverlayStub },
    })

    // Connecting: the provider is published, the interview is not live yet.
    expect(session.state.value).toBe('connecting')
    expect(wrapper.find('[data-slot="avatar-layer"]').exists()).toBe(true)
    expect(overlayLifecycle.mounted).toBe(0)
    expect(wrapper.get('header').classes()).not.toContain('max-w-[96rem]')
    expect(wrapper.find('[data-testid="call-panel"]').exists()).toBe(false)
  })
})

describe('InterviewSession — embedded (flag on)', () => {
  // `100dvh` and its kin make the page's height depend on the iframe's own height, and
  // the host sizes the iframe from the height the embed page reports: it never settles.
  const VIEWPORT_HEIGHT_UNIT = /\d(?:vh|dvh|svh|lvh)(?![a-z])/i

  it('draws the stage with no viewport-height unit when embedded', async () => {
    const { wrapper } = await mountLive({ stream: fakeStream(), props: { embedded: true } })

    expect(wrapper.find('[data-slot="call-layout"]').attributes('data-embedded')).toBe('true')
    expect(wrapper.find('[data-testid="call-panel"]').exists()).toBe(true)
    expect(wrapper.html()).not.toMatch(VIEWPORT_HEIGHT_UNIT)
  })

  it('caps the hosted stage by the viewport height, so the unit check above can fail', async () => {
    const { wrapper } = await mountLive({ stream: fakeStream() })

    expect(wrapper.find('[data-slot="call-layout"]').attributes('data-embedded')).toBe('false')
    expect(wrapper.html()).toMatch(VIEWPORT_HEIGHT_UNIT)
  })
})

describe('InterviewSession — the player layer is never re-parented (flag on, R1)', () => {
  it('keeps one layer node, and mounts and stops each player once, across connecting, live, paused, connecting, live', async () => {
    const { wrapper, session } = await mountLive({ attach: true })
    const node = layer(wrapper)
    expect(playerLifecycle).toEqual({ mounted: 1, unmounted: 0 })

    await exitTheInterview()
    expect(session.state.value).toBe('paused')
    expect(layer(wrapper)).toBe(node)
    expect(playerLifecycle).toEqual({ mounted: 1, unmounted: 1 })
    expect(providers[0]!._rawStop).toHaveBeenCalledTimes(1)

    mockCandidateFetch.mockResolvedValueOnce(startResponse(FIRST + 1))
    await resumeButton(wrapper).trigger('click')
    await settle()
    expect(session.state.value).toBe('connecting')
    expect(layer(wrapper)).toBe(node)
    expect(playerLifecycle).toEqual({ mounted: 2, unmounted: 1 })

    providers[1]!._emit('state', 'ready')
    await settle()
    expect(session.state.value).toBe('live')
    expect(layer(wrapper)).toBe(node)
    expect(layer(wrapper).parentElement).toBe(layout(wrapper))
    expect(playerLifecycle).toEqual({ mounted: 2, unmounted: 1 })
    expect(providers[0]!._rawStop).toHaveBeenCalledTimes(1)
    expect(providers[1]!._rawStop).not.toHaveBeenCalled()

    wrapper.unmount()
    await settle()
    expect(providers[1]!._rawStop).toHaveBeenCalledTimes(1)
    expect(providers[0]!._rawStop).toHaveBeenCalledTimes(1)
  })

  it('keeps the layer, and the surviving player instance, through a HeyGen handover', async () => {
    const { wrapper, session } = await mountLive({ provider: 'heygen' })
    const node = layer(wrapper)
    expect(playerLifecycle.mounted).toBe(1)

    await beginHandover(session)
    expect(wrapper.findAllComponents(AvatarPlayerStub)).toHaveLength(2)
    expect(layer(wrapper)).toBe(node)
    const incoming = wrapper.findAllComponents(AvatarPlayerStub)[1]!
    expect(incoming.props('overlay')).toBe(true)
    // The incoming overlaps the outgoing inside the one layer, exactly as without the flag.
    expect(incoming.element.closest('[data-slot="avatar-layer"]')).toBe(node)

    incoming.vm.$emit('painted')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await settle()

    expect(session.state.value).toBe('live')
    expect(layer(wrapper)).toBe(node)
    expect(wrapper.findAllComponents(AvatarPlayerStub)).toHaveLength(1)
    expect(wrapper.findAllComponents(AvatarPlayerStub)[0]!.vm).toBe(incoming.vm)
    expect(playerLifecycle).toEqual({ mounted: 2, unmounted: 1 })
    expect(providers[0]!._rawStop).toHaveBeenCalledTimes(1)
    expect(providers[1]!._rawStop).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="transition-panel"]').exists()).toBe(false)
  })
})
