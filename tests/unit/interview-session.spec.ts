/**
 * InterviewSession.vue, the candidate call screen
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
import { INTERVIEW_CLOSING_GRACE_MS } from '~/app/utils/interview-budget'
import { mount, flushPromises } from '@vue/test-utils'
import {
  computed,
  ref,
  defineComponent,
  h,
  markRaw,
  onBeforeUnmount,
  onMounted,
  onUnmounted,
} from 'vue'
import type { InterviewProvider } from '~/app/types/interview-provider'
import { useCandidateBranding } from '~/app/composables/useCandidateBranding'

vi.setConfig({ testTimeout: 30000 })

const {
  captured,
  guards,
  storedSession,
  exitRedirect,
  mockCandidateFetch,
  mockCreateProvider,
  mockUseExitRedirect,
  speakerTurn,
} = vi.hoisted(() => ({
  captured: {
    session: null as null | Record<string, unknown>,
    handover: null as null | { value: boolean },
    boundary: null as null | { value: boolean },
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
      const boundary = ref(false)
      const session = {
        ...real.useInterviewSession(...args),
        // The real definition: a boundary is a forced mute exactly like a handover.
        handoverInFlight: computed(() => handover.value || boundary.value),
        boundaryInFlight: boundary,
      }
      captured.handover = handover
      captured.boundary = boundary
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

/** Extra `question_context` fields the next /start answers with (`competency_ordinal`, `total_competencies`); reset before each test. */
let questionContextExtras: Record<string, unknown> = {}

function startResponse(sessionId: number, provider = 'tavus', interviewMaxSeconds = 1200) {
  return {
    session_id: sessionId,
    provider,
    provider_token: 'tok',
    conversation_url: null,
    audio_only: false,
    interview_max_seconds: interviewMaxSeconds,
    question_context: {
      competency_code: 'PRS',
      question_index: 0,
      end_phrase: 'Passiamo alla prossima domanda.',
      final_phrase: 'Grazie.',
      ...questionContextExtras,
    },
  }
}

/** Mounts and unmounts of the player stub: the R1 guarantee counts instances, not renders. */
const playerLifecycle = { mounted: 0, unmounted: 0 }

/** When on, the stub says goodbye like the real `AvatarPlayer.client.vue`: `stream` with `null` as it unmounts. */
const realPlayer = { emitNullOnUnmount: false }

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
    onBeforeUnmount(() => {
      if (realPlayer.emitNullOnUnmount) emit('stream', null)
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
  props: {
    stream: { type: Object, required: true },
    sessionId: { type: Number, default: null },
    silent: { type: Boolean, default: false },
  },
  setup(props) {
    onMounted(() => {
      overlayLifecycle.mounted += 1
    })
    onUnmounted(() => {
      overlayLifecycle.unmounted += 1
    })
    return () => h('div', { 'data-testid': 'proctor-overlay', 'data-silent': String(props.silent) })
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
    name: { type: String, default: undefined },
  },
  setup: (props) => () =>
    h('div', {
      'data-testid': 'call-self-view',
      'data-name': props.name ?? '',
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

const mounted: Array<{ unmount: () => void }> = []

async function mountLive({
  attach = false,
  stream = null,
  stubs = {},
  provider = 'tavus',
  ready = true,
  begin = true,
  props = {},
}: {
  attach?: boolean
  /** False stops at the consent screen: no player exists yet. */
  begin?: boolean
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

  if (!begin) return { wrapper, session }
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

/** What the candidate reads: the question text of the captions overlay (without the speaker prefix). */
const caption = (wrapper: Awaited<ReturnType<typeof mountLive>>['wrapper']) => {
  const question = wrapper.find('[data-testid="call-question-text"]')
  return question.exists() ? question.text() : ''
}

const hint = (wrapper: Awaited<ReturnType<typeof mountLive>>['wrapper']) =>
  wrapper.find('[data-testid="call-question-hint"]')

beforeEach(() => {
  vi.clearAllMocks()
  questionContextExtras = {}
  playerLifecycle.mounted = 0
  playerLifecycle.unmounted = 0
  realPlayer.emitNullOnUnmount = false
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
    vi.fn(() => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}|${JSON.stringify(params)}` : key,
      locale: ref('it'),
    }))
  )
  vi.stubGlobal(
    'useRuntimeConfig',
    vi.fn(() => ({
      public: {
        apiBase: 'https://api.test',
        interviewProviderMock: 'false',
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

describe('InterviewSession — the written question', () => {
  it('shows the network notice only while transcript lines wait for the connection', async () => {
    const { wrapper, session } = await mountLive()
    expect(wrapper.find('[data-testid="network-pending-notice"]').exists()).toBe(false)

    session.pendingUtterances.value = 2
    await flushPromises()

    const notice = wrapper.find('[data-testid="network-pending-notice"]')
    expect(notice.exists()).toBe(true)
    expect(notice.attributes('role')).toBe('status')

    session.pendingUtterances.value = 0
    await flushPromises()
    expect(wrapper.find('[data-testid="network-pending-notice"]').exists()).toBe(false)
  })

  it('renders the question as the captions overlay', async () => {
    const { wrapper } = await mountLive()
    providers[0]!._emit('transcript', { role: 'avatar', text: 'First question', ts: 1 })
    await flushPromises()

    expect(wrapper.get('[data-testid="call-question"]').text()).toContain('First question')
    expect(caption(wrapper)).toBe('First question')
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

describe('InterviewSession — focus at a competency boundary', () => {
  const band = () => document.querySelector<HTMLElement>('[data-testid="call-question"]')!

  it('does not move focus to the band for the first session of the interview', async () => {
    await mountLive({ attach: true })

    expect(document.activeElement).not.toBe(band())
  })

  it('treats the first id as the start, not a boundary, even with the band already mounted', async () => {
    // The band mounts when the stage goes live, after the real first id: forcing a
    // fresh first id here is the only way to prove the guard rather than the timing.
    const { session } = await mountLive({ attach: true })
    const id = (session as unknown as { sessionId: { value: number | null } }).sessionId
    id.value = null
    await flushPromises()

    id.value = FIRST
    await flushPromises()

    expect(document.activeElement).not.toBe(band())
  })

  it('moves focus to the band once when the next competency starts a new session', async () => {
    const { session } = await mountLive({ attach: true })
    const focus = vi.spyOn(band(), 'focus')

    session.advanceAttribution(NEXT)
    await flushPromises()

    expect(document.activeElement).toBe(band())
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('does not move focus on a caption update, even after a boundary', async () => {
    const { session } = await mountLive({ attach: true })
    session.advanceAttribution(NEXT)
    await flushPromises()
    ;(document.activeElement as HTMLElement).blur()

    providers[0]!._emit('transcript', { role: 'avatar', text: 'A follow-up', ts: 2 })
    await flushPromises()

    expect(document.activeElement).not.toBe(band())
  })

  it('does not steal focus from an open dialog at a boundary', async () => {
    const { session } = await mountLive({ attach: true })
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-state', 'open')
    const confirm = document.createElement('button')
    dialog.appendChild(confirm)
    document.body.appendChild(dialog)
    confirm.focus()

    session.advanceAttribution(NEXT)
    await flushPromises()

    expect(document.activeElement).toBe(confirm)
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

describe('InterviewSession — Exit', () => {
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

type Mounted = Awaited<ReturnType<typeof mountLive>>['wrapper']

// ---------------------------------------------------------------------------
// live-interview-call-chrome C1a — the live header, the outline and the microphone.
// ---------------------------------------------------------------------------

const OUTLINE_PATH = '/candidate/interview/outline'

const outlineOf = (over: Record<string, unknown> = {}) => ({
  assessment_type: 'standard',
  role_name: 'Responsabile Vendite',
  avatar_name: 'Giulia',
  candidate_name: 'Marta',
  primary_total_all: 6,
  competencies: [{ name: 'Problem solving', ordinal: 1, status: 'current', primary_total: 3 }],
  ...over,
})

/** Answers the outline GET with `value` (or rejects with it); everything else resolves undefined. */
function serveOutline(value: unknown) {
  mockCandidateFetch.mockImplementation(async (path: string) => {
    if (path !== OUTLINE_PATH) return undefined
    if (value instanceof Error) throw value
    return value
  })
}

const outlineCalls = () =>
  mockCandidateFetch.mock.calls.filter((c: unknown[]) => c[0] === OUTLINE_PATH)
const endCalls = () =>
  mockCandidateFetch.mock.calls.filter((c: unknown[]) => c[0] === '/candidate/interview/end')

const headerOf = (wrapper: Mounted) => wrapper.get('[data-testid="call-header"]')
const headerCaptions = (wrapper: Mounted) => wrapper.get('[data-testid="call-header-captions"]')
const headerMic = (wrapper: Mounted) => wrapper.get('[data-testid="call-header-mic"]')

describe('InterviewSession — the live header', () => {
  beforeEach(() => {
    localStorage.clear()
    serveOutline(outlineOf())
  })

  it('renders the header while live, with the three controls, and not before', async () => {
    const before = await mountLive({ begin: false })
    expect(before.wrapper.find('[data-testid="call-header"]').exists()).toBe(false)

    const { wrapper } = await mountLive({ attach: true })
    const labels = headerOf(wrapper)
      .findAll('button')
      .map((b) => b.attributes('data-testid'))

    expect(labels).toEqual(['call-header-captions', 'call-header-mic', 'call-exit'])
  })

  it('draws the logo without the plate while live and with it on the consent screen', async () => {
    useCandidateBranding().prime({
      primary_color: '#771aaf',
      logo_url: 'https://cdn.test/acme.png',
      name: null,
    })
    const consent = await mountLive({ begin: false })
    const plated = consent.wrapper.get('[data-testid="brand-canvas-logo"]').element.parentElement
    expect(plated?.className).toContain('bg-card')

    const { wrapper } = await mountLive()
    expect(wrapper.get('[data-testid="brand-canvas-logo"]').element.parentElement?.tagName).toBe(
      'HEADER'
    )
  })

  it('titles a standard assessment with the role name from the outline', async () => {
    const { wrapper } = await mountLive()
    await flushPromises()

    expect(wrapper.get('[data-testid="call-header-title"]').text()).toBe(
      'interview.call.header.title_with_subject|{"subject":"Responsabile Vendite"}'
    )
  })

  it('titles a potential assessment with its type', async () => {
    serveOutline(outlineOf({ assessment_type: 'potential', role_name: null }))
    const { wrapper } = await mountLive()
    await flushPromises()

    expect(wrapper.get('[data-testid="call-header-title"]').text()).toBe(
      'interview.call.header.title_with_subject|{"subject":"interview.call.header.potential"}'
    )
  })

  it.each([
    ['a null role name', outlineOf({ role_name: null })],
    ['a blank role name', outlineOf({ role_name: '   ' })],
    ['a failed outline', new Error('network')],
    ['an empty answer', undefined],
  ])('shows the bare title and no error for %s', async (_label, served) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    serveOutline(served)
    const { wrapper } = await mountLive()
    await flushPromises()

    const title = wrapper.get('[data-testid="call-header-title"]').text()
    expect(title).toBe('interview.call.header.title')
    expect(title).not.toMatch(/·|null|undefined/)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('fetches the outline once on live, again on a session change, never per utterance', async () => {
    const { wrapper, session } = await mountLive()
    await flushPromises()
    expect(outlineCalls()).toHaveLength(1)

    providers[0]!._emit('transcript', { role: 'avatar', text: 'Una domanda', ts: 1 })
    providers[0]!._emit('transcript', { role: 'candidate', text: 'Una risposta', ts: 2 })
    await flushPromises()
    expect(outlineCalls()).toHaveLength(1)

    session.advanceAttribution(NEXT)
    await flushPromises()
    expect(outlineCalls()).toHaveLength(2)
    expect(wrapper.find('[data-testid="call-header"]').exists()).toBe(true)
  })

  it('does not fetch the outline again when the same session resumes live', async () => {
    const { session } = await mountLive()
    await flushPromises()

    session.state.value = 'paused'
    await flushPromises()
    session.state.value = 'live'
    await flushPromises()

    expect(outlineCalls()).toHaveLength(1)
  })

  it('toggles captions through the stored preference, never calling /end', async () => {
    const { wrapper } = await mountLive()
    expect(headerCaptions(wrapper).attributes('aria-pressed')).toBe('true')

    await headerCaptions(wrapper).trigger('click')
    await flushPromises()
    expect(headerCaptions(wrapper).attributes('aria-pressed')).toBe('false')
    expect(localStorage.getItem('beai:interview:captions')).toBe('false')

    await headerCaptions(wrapper).trigger('click')
    await flushPromises()
    expect(headerCaptions(wrapper).attributes('aria-pressed')).toBe('true')
    expect(endCalls()).toHaveLength(0)
  })

  it('mutes and unmutes the provider from the microphone control, never calling /end', async () => {
    const { wrapper } = await mountLive()
    expect(headerMic(wrapper).attributes('aria-pressed')).toBe('true')

    await headerMic(wrapper).trigger('click')
    await flushPromises()
    expect(providers[0]!.setMicMuted).toHaveBeenLastCalledWith(true)
    expect(headerMic(wrapper).attributes('aria-pressed')).toBe('false')

    await headerMic(wrapper).trigger('click')
    await flushPromises()
    expect(providers[0]!.setMicMuted).toHaveBeenLastCalledWith(false)
    expect(headerMic(wrapper).attributes('aria-pressed')).toBe('true')
    expect(endCalls()).toHaveLength(0)
  })

  it.each([
    ['a competency boundary', () => captured.boundary!],
    ['a handover', () => captured.handover!],
  ])(
    'disables the microphone and shows it muted during %s, then restores the choice',
    async (_l, flag) => {
      const { wrapper } = await mountLive()
      const toggle = flag()

      toggle.value = true
      await flushPromises()
      expect(headerMic(wrapper).attributes('aria-disabled')).toBe('true')
      expect(headerMic(wrapper).attributes('aria-pressed')).toBe('false')
      expect(headerMic(wrapper).find('[data-icon]').attributes('data-icon')).toBe('mic-off')

      await headerMic(wrapper).trigger('click')
      expect(providers[0]!.setMicMuted).not.toHaveBeenCalled()

      toggle.value = false
      await flushPromises()
      expect(headerMic(wrapper).attributes('aria-disabled')).toBeUndefined()
      expect(headerMic(wrapper).attributes('aria-pressed')).toBe('true')
    }
  )

  it.each([
    ['a competency boundary', () => captured.boundary!],
    ['a handover', () => captured.handover!],
  ])("keeps a candidate's own mute through %s", async (_l, flag) => {
    const { wrapper } = await mountLive()
    await headerMic(wrapper).trigger('click')
    await flushPromises()
    expect(headerMic(wrapper).attributes('aria-pressed')).toBe('false')

    const toggle = flag()
    toggle.value = true
    await flushPromises()
    toggle.value = false
    await flushPromises()

    expect(headerMic(wrapper).attributes('aria-pressed')).toBe('false')
    expect(headerMic(wrapper).attributes('aria-disabled')).toBeUndefined()
  })

  it('mounts the same header when embedded', async () => {
    const { wrapper } = await mountLive({ props: { embedded: true } })

    expect(wrapper.find('[data-testid="call-header"]').exists()).toBe(true)
  })
})

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

describe('InterviewSession — the tile names and the candidate ring', () => {
  const ownTile = (wrapper: Mounted) => wrapper.get('[data-testid="call-self-view"]')
  const interviewerChip = (wrapper: Mounted) =>
    layer(wrapper).querySelector('[data-slot="call-tile-name"]')!

  beforeEach(() => {
    localStorage.clear()
    serveOutline(outlineOf())
  })

  it("names the own tile from the outline's candidate name", async () => {
    const { wrapper } = await mountLive({ stream: fakeStream() })
    await flushPromises()

    expect(ownTile(wrapper).attributes('data-name')).toBe('Marta')
  })

  it.each([
    ['a blank name', outlineOf({ candidate_name: '   ' })],
    ['no name', outlineOf({ candidate_name: null })],
    ['a failed outline', new Error('network')],
  ])('leaves the own tile to its generic label with %s', async (_l, served) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    serveOutline(served)
    const { wrapper } = await mountLive({ stream: fakeStream() })
    await flushPromises()

    expect(ownTile(wrapper).attributes('data-name')).toBe('')
  })

  it('falls back to "You" on the real own tile when the name is missing', async () => {
    serveOutline(outlineOf({ candidate_name: null }))
    const { wrapper } = await mountLive({ stream: fakeStream(), stubs: { CallSelfView: false } })
    await flushPromises()

    expect(
      wrapper.get('[data-slot="call-stage-self"] [data-slot="call-tile-name"]').text()
    ).toContain('interview.call.you')
  })

  it.each([
    ['the persona name', outlineOf({ avatar_name: 'Giulia' }), 'Giulia'],
    [
      'the generic label without one',
      outlineOf({ avatar_name: null }),
      'interview.call.interviewer_name',
    ],
    [
      'the generic label for a blank one',
      outlineOf({ avatar_name: '  ' }),
      'interview.call.interviewer_name',
    ],
  ])('names the interviewer chip with %s', async (_l, served, expected) => {
    serveOutline(served)
    const { wrapper } = await mountLive()
    await flushPromises()

    expect(interviewerChip(wrapper).textContent).toContain(expected)
  })

  it('lights the own ring only while the candidate speaks AND the microphone is open', async () => {
    const { wrapper } = await mountLive({ stream: fakeStream() })
    speakerTurn.speaker!.value = 'candidate'
    await flushPromises()
    expect(ownTile(wrapper).attributes('data-speaking')).toBe('true')

    await headerMic(wrapper).trigger('click')
    await flushPromises()
    expect(ownTile(wrapper).attributes('data-speaking')).toBe('false')

    await headerMic(wrapper).trigger('click')
    await flushPromises()
    expect(ownTile(wrapper).attributes('data-speaking')).toBe('true')

    speakerTurn.speaker!.value = 'avatar'
    await flushPromises()
    expect(ownTile(wrapper).attributes('data-speaking')).toBe('false')
  })
})

describe('InterviewSession — the captions overlay', () => {
  const region = (wrapper: Mounted) => wrapper.get('[data-testid="call-question"]')
  const speaker = (wrapper: Mounted) => wrapper.find('[data-testid="call-question-speaker"]')

  async function say(text: string) {
    providers[0]!._emit('transcript', { role: 'avatar', text, ts: Date.now() })
    await flushPromises()
  }

  beforeEach(() => {
    localStorage.clear()
    serveOutline(outlineOf())
  })

  it('is rendered once, inside the avatar layer after the interviewer tile, and nowhere else', async () => {
    const { wrapper } = await mountLive()
    await say('A question')

    const overlays = wrapper.findAll('[data-testid="call-question"]')
    expect(overlays).toHaveLength(1)
    expect(layer(wrapper).contains(overlays[0]!.element)).toBe(true)
    const tile = layer(wrapper).querySelector('[data-slot="call-tile"]')!
    expect(
      tile.compareDocumentPosition(overlays[0]!.element) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(wrapper.findAll('[aria-live="polite"][aria-atomic="true"]')).toHaveLength(1)
  })

  it('is not mounted before the interview is live', async () => {
    const { wrapper } = await mountLive({ ready: false })

    expect(wrapper.find('[data-testid="call-question"]').exists()).toBe(false)
  })

  it('prefixes the caption with the persona name from the outline', async () => {
    const { wrapper } = await mountLive()
    await say('A question')

    expect(speaker(wrapper).text()).toBe('Giulia:')
  })

  it.each([
    ['no persona name', outlineOf({ avatar_name: null })],
    ['a failed outline', new Error('network')],
  ])('falls back to the generic interviewer name with %s', async (_l, served) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    serveOutline(served)
    const { wrapper } = await mountLive()
    await say('A question')

    expect(speaker(wrapper).text()).toBe('interview.call.interviewer_name:')
  })

  it('keeps the hint, with no prefix, before the first question', async () => {
    const { wrapper } = await mountLive()

    expect(hint(wrapper).exists()).toBe(true)
    expect(speaker(wrapper).exists()).toBe(false)
  })

  it('hides every visible word when captions are turned off, keeping the live region written to', async () => {
    const { wrapper } = await mountLive()
    await say('First question')

    await headerCaptions(wrapper).trigger('click')
    await flushPromises()

    expect(region(wrapper).classes()).toContain('sr-only')
    expect(region(wrapper).attributes('tabindex')).toBeUndefined()
    expect(region(wrapper).text()).toContain('First question')

    await say('A follow-up')
    expect(region(wrapper).classes()).toContain('sr-only')
    expect(caption(wrapper)).toBe('A follow-up')
    expect(wrapper.findAll('[aria-live="polite"][aria-atomic="true"]')).toHaveLength(1)
  })

  it('shows the latest question at once when captions are turned back on', async () => {
    const { wrapper } = await mountLive()
    await headerCaptions(wrapper).trigger('click')
    await say('Said while off')

    await headerCaptions(wrapper).trigger('click')
    await flushPromises()

    expect(region(wrapper).classes()).not.toContain('sr-only')
    expect(caption(wrapper)).toBe('Said while off')
  })

  it('restores an off preference on a fresh load', async () => {
    localStorage.setItem('beai:interview:captions', 'false')
    const { wrapper } = await mountLive()
    await say('A question')

    expect(region(wrapper).classes()).toContain('sr-only')
    expect(headerCaptions(wrapper).attributes('aria-pressed')).toBe('false')
  })

  it('does not move focus at a competency boundary while captions are off', async () => {
    const { wrapper, session } = await mountLive({ attach: true })
    await headerCaptions(wrapper).trigger('click')
    await flushPromises()

    session.advanceAttribution(NEXT)
    await flushPromises()

    expect(document.activeElement).not.toBe(region(wrapper).element)
  })
})

describe('InterviewSession — the stage', () => {
  it('renders the stage parts, with the captions overlay inside the player layer', async () => {
    const { wrapper } = await mountLive({ stream: fakeStream() })

    expect(layer(wrapper).contains(wrapper.get('[data-testid="call-question"]').element)).toBe(true)
    const parts = {
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

  it('puts the help link in the panel and the timer in the panel only; Exit is in the header', async () => {
    const { wrapper } = await mountLive({
      attach: true,
      stubs: { InterviewTimer: InterviewTimerCounterStub },
    })

    const panel = wrapper.get('[data-testid="call-panel"]').element
    expect(panel.querySelector('[data-testid="call-exit"]')).toBeNull()
    expect(panel.querySelector('[data-testid="call-help-link"]')).not.toBeNull()
    expect(
      wrapper.get('[data-testid="call-header"]').element.querySelector('[data-testid="call-exit"]')
    ).not.toBeNull()
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
      'interview.call.path.progress'
    )

    store.endedCompetencies.value = 1
    store.totalCompetencies.value = 3
    await flushPromises()

    const panel = wrapper.get('[data-testid="call-panel"]')
    expect(panel.get('[data-testid="call-panel-progress-text"]').text()).toBe(
      `interview.call.path.progress|${JSON.stringify({ n: 2, total: 3 })}`
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

  it('keeps the interviewer ring lit across a boundary even when the avatar is silent', async () => {
    const { wrapper } = await mountLive({ stream: fakeStream() })
    const tile = () => wrapper.get('[data-slot="avatar-layer"] [data-slot="call-tile"]')
    const own = () => wrapper.get('[data-testid="call-self-view"]')

    captured.boundary!.value = true
    await flushPromises()
    expect(tile().attributes('data-speaking')).toBe('true')
    expect(own().attributes('data-speaking')).toBe('false')

    captured.boundary!.value = false
    await flushPromises()
    expect(tile().attributes('data-speaking')).toBe('false')
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
        `interview.call.duration.value|${JSON.stringify({ elapsed, total: '20:00' })}`
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

  it('counts ONE total clock from the template limit across competencies, and spends the budget and closes after the grace period when it expires', async () => {
    const { wrapper, session } = await mountLive({
      stubs: { InterviewTimer: InterviewTimerCounterStub },
    })
    const timer = () => wrapper.getComponent(InterviewTimerCounterStub)
    expect(timerLifecycle.mounted).toBe(1)
    expect(timer().props('seconds')).toBe(1200)

    timer().vm.$emit('tick', 120)
    await flushPromises()
    expect(timer().props('seconds')).toBe(120)
    expect(timerLifecycle.mounted).toBe(1)

    session.advanceAttribution(NEXT)
    await flushPromises()
    expect(timerLifecycle.mounted).toBe(2)
    // The template limit is the whole interview: the next competency continues the same clock.
    expect(timer().props('seconds')).toBe(120)

    const endQuestion = vi.spyOn(
      session as unknown as { endQuestion: (reason: string) => Promise<void> },
      'endQuestion'
    )
    vi.useFakeTimers()
    try {
      timer().vm.$emit('expired')
      await flushPromises()
      // The whole interview is spent: the question finishes on its closing phrase, so it is not cut here.
      expect(session.interviewBudgetSpent.value).toBe(true)
      expect(endQuestion).not.toHaveBeenCalled()
      vi.advanceTimersByTime(INTERVIEW_CLOSING_GRACE_MS)
      expect(endQuestion).toHaveBeenCalledWith('timeout')
    } finally {
      vi.useRealTimers()
    }
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

  it('keeps the integrity toasts on for an ordinary interview', async () => {
    const { wrapper } = await mountLive({
      attach: true,
      stream: fakeStream(),
      stubs: { ProctorOverlay: ProctorOverlayStub },
    })

    expect(wrapper.get('[data-testid="proctor-overlay"]').attributes('data-silent')).toBe('false')
  })

  it('silences the integrity toasts for a reusable-link interview (live demos)', async () => {
    storedSession.read.mockReturnValue({ exp: EXP, entry: 'reusable' })
    const { wrapper } = await mountLive({
      attach: true,
      stream: fakeStream(),
      stubs: { ProctorOverlay: ProctorOverlayStub },
    })

    expect(wrapper.get('[data-testid="proctor-overlay"]').attributes('data-silent')).toBe('true')
  })

  it('hides the tab-hidden warning on the paused panel for a reusable-link interview', async () => {
    storedSession.read.mockReturnValue({ exp: EXP, entry: 'reusable' })
    const { wrapper } = await mountLive({ attach: true })

    guards.tab!.onHiddenTimeout()
    await settle()

    expect(wrapper.get('#paused-heading').exists()).toBe(true)
    expect(wrapper.find('[data-testid="tab-hidden-warning"]').exists()).toBe(false)
  })

  it('keeps the network notices on a reusable-link interview (functional, not integrity)', async () => {
    storedSession.read.mockReturnValue({ exp: EXP, entry: 'reusable' })
    const { wrapper } = await mountLive({ attach: true })

    guards.network!.onOffline()
    await settle()

    expect(wrapper.find('[data-testid="network-reconnecting-notice"]').exists()).toBe(true)
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

describe('InterviewSession — embedded', () => {
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

describe('InterviewSession — the player layer is never re-parented (R1)', () => {
  it('hides the empty layer from assistive technology until a player exists, on the same node', async () => {
    const { wrapper, session } = await mountLive({ begin: false })
    const node = layer(wrapper)
    expect(node.getAttribute('aria-hidden')).toBe('true')

    session.acceptConsent()
    mockCandidateFetch.mockResolvedValueOnce(startResponse(FIRST))
    session.confirmDevices()
    await flushPromises()

    expect(wrapper.findAllComponents(AvatarPlayerStub)).toHaveLength(1)
    expect(layer(wrapper)).toBe(node)
    expect(node.hasAttribute('aria-hidden')).toBe(false)
  })

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
    // The incoming overlaps the outgoing inside the one layer.
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

  it('forgets the retired player state and stream when it unmounts the way the real player does', async () => {
    realPlayer.emitNullOnUnmount = true
    const { wrapper, session } = await mountLive({ provider: 'heygen' })
    const maps = wrapper.vm as unknown as {
      playerStates: Map<number, string>
      playerStreams: Map<number, MediaStream>
    }
    wrapper.findComponent(AvatarPlayerStub).vm.$emit('stream', fakeStream())
    await beginHandover(session)
    expect(maps.playerStates.size).toBe(1)
    expect(maps.playerStreams.size).toBe(1)

    const incoming = wrapper.findAllComponents(AvatarPlayerStub)[1]!
    incoming.vm.$emit('painted')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await settle()

    expect(playerLifecycle.unmounted).toBe(1)
    expect(maps.playerStates.size).toBe(0)
    expect(maps.playerStreams.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// live-interview-call-chrome C2a.1 — the panel's named path, fed by the outline.
// ---------------------------------------------------------------------------

const THREE_COMPETENCIES = [
  { name: 'Pensiero strategico', ordinal: 1, status: 'done', primary_total: 3 },
  { name: 'Orientamento al risultato', ordinal: 2, status: 'current', primary_total: 3 },
  { name: 'Collaborazione', ordinal: 3, status: 'upcoming', primary_total: 2 },
]

describe('InterviewSession — the panel path (Percorso)', () => {
  beforeEach(() => {
    localStorage.clear()
    serveOutline(outlineOf({ competencies: THREE_COMPETENCIES }))
  })

  const itemsOf = (wrapper: Mounted) => wrapper.findAll('[data-testid="call-storyboard-item"]')

  it('lists the outline competencies by name, in order, in the panel', async () => {
    const { wrapper } = await mountLive()
    await flushPromises()

    expect(
      itemsOf(wrapper).map((row) => row.get('[data-testid="call-storyboard-name"]').text())
    ).toEqual(['Pensiero strategico', 'Orientamento al risultato', 'Collaborazione'])
    expect(wrapper.get('[data-testid="call-panel"]').find('ol').exists()).toBe(true)
    expect(wrapper.get('[aria-current="step"]').text()).toContain('Orientamento al risultato')
  })

  it('hands the latest primary_index to the current item, and clears it with the session', async () => {
    let primaryIndex = 2
    mockCandidateFetch.mockImplementation(async (path: string) => {
      if (path === OUTLINE_PATH) return outlineOf({ competencies: THREE_COMPETENCIES })
      if (path === '/candidate/interview/utterance') return { primary_index: primaryIndex }
      return undefined
    })
    const { wrapper, session } = await mountLive()
    await flushPromises()
    const line = () => wrapper.get('[aria-current="step"] [data-testid="call-storyboard-line"]')
    expect(line().text()).toBe('interview.call.storyboard.current')

    providers[0]!._emit('transcript', { role: 'avatar', text: 'Una domanda', ts: 1 })
    await flushPromises()
    expect(line().text()).toBe(
      `interview.call.storyboard.current_counted|${JSON.stringify({ k: 2, n: 3 })}`
    )

    primaryIndex = 3
    providers[0]!._emit('transcript', { role: 'avatar', text: "Un'altra", ts: 2 })
    await flushPromises()
    expect(line().text()).toBe(
      `interview.call.storyboard.current_counted|${JSON.stringify({ k: 3, n: 3 })}`
    )

    session.advanceAttribution(NEXT)
    await flushPromises()
    expect(line().text()).toBe('interview.call.storyboard.current')
  })

  it.each([
    ['a null name', null],
    ['a blank name', '   '],
  ])('gives %s the generic "Competenza {ordinal}", never a code', async (_label, name) => {
    serveOutline(
      outlineOf({
        competencies: [
          { name: 'Prima', ordinal: 1, status: 'done', primary_total: 1 },
          { name, ordinal: 2, status: 'current', primary_total: 1 },
        ],
      })
    )
    const { wrapper } = await mountLive()
    await flushPromises()

    expect(itemsOf(wrapper)[1]!.get('[data-testid="call-storyboard-name"]').text()).toBe(
      `interview.call.storyboard.unnamed|${JSON.stringify({ ordinal: 2 })}`
    )
  })

  it('renders no competency code anywhere on the live screen, even one the outline or store carries', async () => {
    serveOutline(
      outlineOf({
        competencies: THREE_COMPETENCIES.map((c) => ({
          ...c,
          code: 'COL',
          competency_code: 'COL',
        })),
      })
    )
    const { wrapper } = await mountLive({ attach: true })
    await flushPromises()

    // The start response carried `PRS`; the outline entries carry `COL`.
    expect(wrapper.html()).not.toMatch(/COL|PRS/)
    expect(document.body.textContent).not.toMatch(/COL|PRS/)
  })

  it('omits the storyboard when the outline fails, and the rest of the panel still renders', async () => {
    serveOutline(new Error('network'))
    const { wrapper, session } = await mountLive()
    ;(session as unknown as { totalCompetencies: { value: number } }).totalCompetencies.value = 5
    await flushPromises()

    expect(wrapper.find('[data-testid="call-storyboard"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="call-panel-progress-text"]').text()).toContain('"total":5')
    expect(wrapper.find('[data-testid="call-panel-duration-value"]').exists()).toBe(true)
  })

  describe('"Competenza n di N" numerator', () => {
    const progressText = (wrapper: Mounted) =>
      wrapper.get('[data-testid="call-panel-progress-text"]').text()
    const reads = (n: number, total: number) =>
      `interview.call.path.progress|${JSON.stringify({ n, total })}`

    it('counts from the /end tally when there is one', async () => {
      questionContextExtras = { total_competencies: 5, competency_ordinal: 4 }
      const { wrapper, session } = await mountLive()
      ;(
        session as unknown as { endedCompetencies: { value: number | null } }
      ).endedCompetencies.value = 1
      await flushPromises()

      expect(progressText(wrapper)).toBe(reads(2, 5))
    })

    it('falls back to the /start ordinal before any /end, so a resumed run does not read 1', async () => {
      questionContextExtras = { total_competencies: 5, competency_ordinal: 3 }
      const { wrapper } = await mountLive()
      await flushPromises()

      expect(progressText(wrapper)).toBe(reads(3, 5))
    })

    it('reads "1 of N" on the first competency, from the /start total', async () => {
      questionContextExtras = { total_competencies: 5, competency_ordinal: 1 }
      const { wrapper } = await mountLive()
      await flushPromises()

      expect(progressText(wrapper)).toBe(reads(1, 5))
    })

    it('shows no sentence while the /start response named neither total nor ordinal', async () => {
      const { wrapper } = await mountLive()
      await flushPromises()

      expect(wrapper.find('[data-testid="call-panel-progress-text"]').exists()).toBe(false)
    })
  })
})
