/**
 * app/pages/interview/session.vue — the container's wiring, not its styling.
 *
 * Moved verbatim from `[token].vue` (candidate-session-auth D-A / Task 2.1):
 * `[token].vue` is now the token-consuming entry route (see
 * interview-entry.spec.ts); this file is the token-free interview UI the
 * candidate actually sits on.
 *
 * Two defects this file exists to keep dead:
 *  1. The live interview screen could NEVER render. `activeProvider` / `activeConfig`
 *     were page-local refs initialised to null and assigned nowhere, so the
 *     `v-if="activeProvider && activeConfig"` gate around AvatarPlayer was permanently
 *     false and the avatar never mounted.
 *  2. The 5-minute question timer and the Skip button both routed into a local
 *     `callEnd()` whose entire body was `void reason` — two visible affordances that
 *     did nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, shallowRef, computed, nextTick, defineComponent, h } from 'vue'
import type { InterviewProvider, StartConfig } from '~/app/types/interview-provider'
import type {
  SessionState,
  SessionPlayer,
  ProviderSession,
} from '~/app/composables/useInterviewSession'

// ---------------------------------------------------------------------------
// Hoisted composable mocks
// ---------------------------------------------------------------------------

const { mockUseInterviewSession, mockUseExitRedirect } = vi.hoisted(() => ({
  mockUseInterviewSession: vi.fn(),
  mockUseExitRedirect: vi.fn(),
}))

vi.mock('~/composables/useInterviewSession', () => ({
  useInterviewSession: mockUseInterviewSession,
}))

vi.mock('~/composables/useExitRedirect', () => ({
  useExitRedirect: mockUseExitRedirect,
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProvider(): InterviewProvider {
  return {
    on: vi.fn(),
    start: vi.fn(async () => ({})),
    stop: vi.fn(async () => undefined),
    toggleMic: vi.fn(async () => undefined),
  }
}

const CONFIG: StartConfig = {
  dbSessionId: 42,
  sessionToken: 'tok',
  endPhrase: 'Passiamo alla prossima domanda.',
  finalPhrase: 'Grazie per il tuo tempo.',
}

/**
 * invisible-competency-handover (Task 4.3) — `makeSession()` gains
 * `players`/`incomingSession` so every page test routes through the same
 * fixture shape the real composable exposes.
 *
 * `players` is a COMPUTED mirroring the real composable's own derivation
 * (D1/D6): live from `activeProvider`/`activeConfig`, plus an optional
 * hidden `incoming` entry. This is deliberate — every EXISTING test in this
 * file that mutates `activeProvider.value`/`activeConfig.value` directly
 * (to simulate "no provider yet") keeps working unmodified, because
 * `players` reactively reflects those same refs rather than needing its own
 * parallel updates.
 */
function makeSession(
  overrides: {
    state?: SessionState
    provider?: InterviewProvider | null
    incoming?: { dbSessionId: number; provider: InterviewProvider; config: StartConfig } | null
  } = {}
) {
  const provider = overrides.provider === undefined ? makeProvider() : overrides.provider
  const activeProvider = shallowRef<InterviewProvider | null>(provider)
  const activeConfig = shallowRef<StartConfig | null>(provider ? CONFIG : null)
  const incomingSession = shallowRef<ProviderSession | null>(
    overrides.incoming
      ? ({ ...overrides.incoming, providerName: 'heygen' } as ProviderSession)
      : null
  )

  const players = computed<SessionPlayer[]>(() => {
    const list: SessionPlayer[] = []
    if (activeProvider.value && activeConfig.value) {
      list.push({
        key: activeConfig.value.dbSessionId,
        provider: activeProvider.value,
        config: activeConfig.value,
        role: 'live',
        muted: false,
      })
    }
    if (incomingSession.value) {
      list.push({
        key: incomingSession.value.dbSessionId,
        provider: incomingSession.value.provider,
        config: incomingSession.value.config,
        role: 'incoming',
        muted: true,
      })
    }
    return list
  })

  return {
    state: ref<SessionState>(overrides.state ?? 'live'),
    retryAttemptCount: ref(0),
    currentCompetencyIndex: ref(0),
    terminalReason: ref(null),
    sessionId: ref<number | null>(42),
    endedCompetencies: ref<number | null>(null),
    totalCompetencies: ref<number | null>(null),
    activeProvider,
    activeConfig,
    players,
    incomingSession,
    handoverInFlight: computed(() => incomingSession.value !== null),
    acceptConsent: vi.fn(),
    confirmDevices: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    retry: vi.fn(),
    nextCompetency: vi.fn(),
    endQuestion: vi.fn(async () => undefined),
    teardown: vi.fn(async () => undefined),
    notifyPainted: vi.fn(),
  }
}

// Stub for the components Nuxt auto-imports (unresolvable in Vitest) and for the
// browser-only children whose real implementations need WebRTC / MediaPipe.
const AvatarPlayerStub = defineComponent({
  name: 'AvatarPlayer',
  props: {
    provider: { type: Object, required: true },
    config: { type: Object, required: true },
    muted: { type: Boolean, default: false },
    overlay: { type: Boolean, default: false },
  },
  emits: ['painted', 'state', 'transcript', 'error'],
  setup: (props) => () =>
    h('div', {
      'data-testid': 'avatar-player',
      'data-muted': String(props.muted),
      'data-overlay': String(props.overlay),
    }),
})

const InterviewTimerStub = defineComponent({
  name: 'InterviewTimer',
  props: { seconds: { type: Number, required: true } },
  emits: ['expired'],
  setup:
    (_props, { emit }) =>
    () =>
      h('button', { 'data-testid': 'fire-expired', onClick: () => emit('expired') }),
})

function globalConfig() {
  return {
    mocks: { $t: (key: string) => key },
    stubs: {
      ClientOnly: defineComponent({
        name: 'ClientOnly',
        setup:
          (_p, { slots }) =>
          () =>
            h('div', slots.default?.()),
      }),
      AvatarPlayer: AvatarPlayerStub,
      DeviceCheck: true,
      ProctorOverlay: true,
      InterviewTimer: InterviewTimerStub,
      InterviewCaption: true,
      InterviewProgressBar: true,
    },
  }
}

async function mountPage(session: ReturnType<typeof makeSession>) {
  mockUseInterviewSession.mockReturnValue(session)
  const { default: Page } = await import('~/app/pages/interview/session.vue')
  const wrapper = mount(Page, { global: globalConfig() })
  // `flushPromises`, not a single `nextTick`. This file already documents (at
  // its declaration below) that one tick is not enough to observe an async
  // watcher body; mount is the same shape — the page has async work on mount,
  // and whether one tick happened to be enough depended on how the microtask
  // queue fell. It usually was, which is the worst version of that: the
  // AvatarPlayer assertion failed roughly one run in four, always alone,
  // always passing on a re-run.
  //
  // Declared below and used here on purpose — function declarations hoist, and
  // moving it up would separate it from the comment that explains it.
  await flushPromises()
  return wrapper
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
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
  // Re-stubbed here because this spec's afterEach calls unstubAllGlobals(),
  // which wipes the shared setup.ts stub. The page reads useI18n() to localize
  // its document title (WCAG 2.4.2).
  vi.stubGlobal(
    'useI18n',
    vi.fn(() => ({ t: (key: string) => key, locale: ref('it') }))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// Flush the microtask queue — the state/errorRedirectUrl watcher body is
// async (`await session.teardown()` before `redirectToError()`), so a single
// nextTick() is not enough to observe its effects.
async function flushPromises() {
  for (let i = 0; i < 5; i++) {
    await nextTick()
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('interview/session.vue — live render path', () => {
  it('mounts AvatarPlayer when the session publishes a provider and config', async () => {
    const wrapper = await mountPage(makeSession({ state: 'live' }))

    expect(wrapper.find('[data-testid="avatar-player"]').exists()).toBe(true)
  })

  it('hands AvatarPlayer the provider and config from the session, not page-local nulls', async () => {
    const session = makeSession({ state: 'live' })
    const wrapper = await mountPage(session)

    const player = wrapper.findComponent(AvatarPlayerStub)
    expect(player.props('provider')).toBe(session.activeProvider.value)
    expect(player.props('config')).toBe(session.activeConfig.value)
  })

  it('mounts AvatarPlayer already during `connecting` — the provider cannot reach `ready` otherwise', async () => {
    // provider.start() is what makes the provider emit 'ready', and only 'ready'
    // moves the session to `live`. Gating the player on `live` was a deadlock.
    const wrapper = await mountPage(makeSession({ state: 'connecting' }))

    expect(wrapper.find('[data-testid="avatar-player"]').exists()).toBe(true)
  })

  it('shows the connecting skeleton while `connecting` with no provider published yet', async () => {
    const wrapper = await mountPage(makeSession({ state: 'connecting', provider: null }))

    expect(wrapper.find('[data-testid="avatar-player"]').exists()).toBe(false)
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true)
  })

  it('does not render the live controls while still `connecting`', async () => {
    const wrapper = await mountPage(makeSession({ state: 'connecting' }))

    expect(wrapper.findComponent(InterviewTimerStub).exists()).toBe(false)
  })

  it('renders the live controls once `live`', async () => {
    const wrapper = await mountPage(makeSession({ state: 'live' }))

    expect(wrapper.findComponent(InterviewTimerStub).exists()).toBe(true)
  })
})

describe('interview/session.vue — timer expiry and skip', () => {
  it("timer expiry dispatches endQuestion('timeout')", async () => {
    const session = makeSession({ state: 'live' })
    const wrapper = await mountPage(session)

    await wrapper.find('[data-testid="fire-expired"]').trigger('click')

    expect(session.endQuestion).toHaveBeenCalledWith('timeout')
  })

  // REMOVED: the Skip control is gone. A candidate must not be able to skip a
  // competency, so the 5-minute timer is the only client-side early end. Its
  // replacement is "renders NO skip control".

  it('the pause button still routes to session.pause()', async () => {
    const session = makeSession({ state: 'live' })
    const wrapper = await mountPage(session)

    const pauseButton = wrapper
      .findAll('button')
      .find((b) => b.text().includes('interview.live.pause'))

    await pauseButton!.trigger('click')

    expect(session.pause).toHaveBeenCalled()
  })

  // invisible-competency-handover D2 (Task 3.9 / 1.7) — DISABLED, never
  // hidden, while a handover is in flight. Hiding it is itself a visible
  // break; an enabled-but-inert button is the defect the live pause was
  // fixed for.
  it('disables (never hides) the Pause control while a HeyGen handover is in flight', async () => {
    const incomingProvider = makeProvider()
    const session = makeSession({
      state: 'live',
      incoming: { dbSessionId: 99, provider: incomingProvider, config: CONFIG },
    })
    const wrapper = await mountPage(session)

    const pauseButton = wrapper
      .findAll('button')
      .find((b) => b.text().includes('interview.live.pause'))

    expect(pauseButton).toBeDefined()
    expect(pauseButton!.attributes('disabled')).toBeDefined()
  })

  it('the Pause control is enabled again once no handover is in flight', async () => {
    const session = makeSession({ state: 'live' })
    const wrapper = await mountPage(session)

    const pauseButton = wrapper
      .findAll('button')
      .find((b) => b.text().includes('interview.live.pause'))

    expect(pauseButton!.attributes('disabled')).toBeUndefined()
  })

  // Pausing a LIVE question keeps the provider session up (tearing it down would
  // restart the question from its opening line), so `avatarMounted` stays true —
  // and the standalone `paused` section is ordered AFTER the avatar section in the
  // v-if chain, so it never renders. Without a resume control inside the avatar
  // branch the candidate pauses into a dead end with no way back.

  it('offers a resume control while paused with the provider still mounted', async () => {
    const session = makeSession({ state: 'paused' })
    const wrapper = await mountPage(session)

    const resumeButton = wrapper
      .findAll('button')
      .find((b) => b.text().includes('interview.paused.resume'))

    expect(resumeButton).toBeDefined()

    await resumeButton!.trigger('click')
    expect(session.resume).toHaveBeenCalled()
  })

  it('hides the live controls while paused', async () => {
    // Skip/pause/timer must not stay operable on a paused question.
    const session = makeSession({ state: 'paused' })
    const wrapper = await mountPage(session)

    const labels = wrapper.findAll('button').map((b) => b.text())
    expect(labels.some((l) => l.includes('interview.live.pause'))).toBe(false)
  })

  // Pausing unmounts the `v-if="live"` block and with it InterviewTimer, whose
  // `remaining` is component-local. Resuming mounts a fresh instance. Unless the
  // page owns the remaining time, every pause hands the candidate a full new
  // 5 minutes — unlimited time per question for anyone who notices.

  it('does NOT restart the countdown when a paused question resumes', async () => {
    const session = makeSession({ state: 'live' })
    const wrapper = await mountPage(session)

    const timerBefore = wrapper.findComponent({ name: 'InterviewTimer' })
    expect(timerBefore.exists()).toBe(true)
    const fullLimit = timerBefore.props('seconds') as number

    // The timer reports progress as it ticks; the page must retain it.
    timerBefore.vm.$emit('tick', fullLimit - 137)
    await nextTick()

    session.state.value = 'paused'
    await nextTick()
    expect(wrapper.findComponent({ name: 'InterviewTimer' }).exists()).toBe(false)

    session.state.value = 'live'
    await nextTick()

    const timerAfter = wrapper.findComponent({ name: 'InterviewTimer' })
    expect(timerAfter.exists()).toBe(true)
    expect(timerAfter.props('seconds')).toBe(fullLimit - 137)
  })

  it('restarts the countdown at the full limit for a new competency', async () => {
    // Resuming a pause must preserve the clock; starting the NEXT question must not.
    const session = makeSession({ state: 'live' })
    const wrapper = await mountPage(session)

    const timer = wrapper.findComponent({ name: 'InterviewTimer' })
    const fullLimit = timer.props('seconds') as number
    timer.vm.$emit('tick', 42)
    await nextTick()

    // A new competency issues a new DB session id.
    session.sessionId.value = 99
    await nextTick()

    expect(wrapper.findComponent({ name: 'InterviewTimer' }).props('seconds')).toBe(fullLimit)
  })

  // D12 — the inter-competency gap.
  //
  // With the interstitial gone, `confirmDevices()` tears the provider down and
  // rebuilds it while the candidate watches. A bare skeleton there reads as the
  // avatar vanishing mid-conversation. The FIRST connect keeps the skeleton: it
  // follows a device check the candidate just interacted with, which is a
  // different expectation entirely.

  // ---------------------------------------------------------------------------
  // invisible-competency-handover (D6/D7) — strictly stronger replacement.
  //
  // The OLD assertion here ("connecting + no provider ⇒ panel") was correct
  // for EVERY continue on `main`, because every continue used to tear the
  // provider down first. It is no longer correct for a HeyGen continue,
  // which now keeps the outgoing mounted and never reaches `connecting` at
  // all (D2). Deleting it outright would silently drop coverage of the
  // panel's role; the replacement below is a strictly stronger PAIR —
  // absence under the new healthy-handover condition, AND presence on both
  // of its two remaining real triggers (the D5 bound-exceeded fallback and
  // an unaffected Tavus continue) — never absence alone.
  // ---------------------------------------------------------------------------

  it('is ABSENT while a HeyGen handover is healthy — the outgoing stays live, a hidden incoming connects behind it', async () => {
    const incomingProvider = makeProvider()
    const session = makeSession({
      state: 'live',
      incoming: { dbSessionId: 99, provider: incomingProvider, config: CONFIG },
    })
    const wrapper = await mountPage(session)

    session.endedCompetencies.value = 1
    session.totalCompetencies.value = 3
    await nextTick()

    expect(wrapper.find('[data-testid="transition-panel"]').exists()).toBe(false)
    // Positive signal (never absence alone): BOTH sessions are genuinely
    // mounted at once, as distinct AvatarPlayer instances (D6).
    const players = wrapper.findAllComponents(AvatarPlayerStub)
    expect(players).toHaveLength(2)
    // Regression: `overlay` is the ONLY thing that decides absolute-vs-normal-flow
    // positioning now (AvatarPlayer owns the ternary internally). Wiring this from
    // `p.role` incorrectly — or dropping it back to a `class="absolute inset-0"`
    // fallthrough that collides with the component's own `relative` — leaves the
    // incoming player in normal flow, clipped by the wrapper's `overflow-hidden`.
    expect(players[0]?.props('overlay')).toBe(false) // live
    expect(players[1]?.props('overlay')).toBe(true) // incoming
  })

  it('is PRESENT on the D5 bound-exceeded fallback — no live player, only a hidden incoming survives', async () => {
    const incomingProvider = makeProvider()
    const session = makeSession({
      state: 'connecting',
      provider: null,
      incoming: { dbSessionId: 99, provider: incomingProvider, config: CONFIG },
    })
    session.endedCompetencies.value = 1
    session.totalCompetencies.value = 3
    const wrapper = await mountPage(session)

    expect(wrapper.find('[data-testid="transition-panel"]').exists()).toBe(true)
    // Positive signal: the hidden incoming is STILL mounted underneath the
    // panel — D5's "stays in its slot, promoted when it eventually paints" —
    // never torn down just because the panel became visible.
    expect(wrapper.findAllComponents(AvatarPlayerStub)).toHaveLength(1)
  })

  it('is PRESENT on a Tavus continue — unaffected by this change, not a bare skeleton', async () => {
    const session = makeSession({ state: 'live' })
    const wrapper = await mountPage(session)

    // A competency has run: the provider was published at least once.
    session.endedCompetencies.value = 1
    session.totalCompetencies.value = 3
    session.activeProvider.value = null
    session.activeConfig.value = null
    session.state.value = 'connecting'
    await nextTick()

    expect(wrapper.find('[data-testid="transition-panel"]').exists()).toBe(true)
  })

  it('keeps the plain skeleton on the FIRST connect', async () => {
    const session = makeSession({ state: 'connecting', provider: null })
    const wrapper = await mountPage(session)

    expect(wrapper.find('[data-testid="transition-panel"]').exists()).toBe(false)
  })

  it('the transition panel carries no control — it must never become a second interstitial', async () => {
    const session = makeSession({ state: 'live' })
    const wrapper = await mountPage(session)

    session.endedCompetencies.value = 2
    session.totalCompetencies.value = 5
    session.activeProvider.value = null
    session.activeConfig.value = null
    session.state.value = 'connecting'
    await nextTick()

    const panel = wrapper.find('[data-testid="transition-panel"]')
    expect(panel.exists()).toBe(true)
    expect(panel.findAll('button')).toHaveLength(0)
    expect(panel.attributes('aria-live')).toBe('polite')
    expect(panel.attributes('aria-busy')).toBe('true')
  })

  it('renders NO skip control — a competency must not be skippable', async () => {
    const session = makeSession({ state: 'live' })
    const wrapper = await mountPage(session)

    const labels = wrapper.findAll('button').map((b) => b.text())
    expect(labels.some((l) => l.includes('interview.live.skip'))).toBe(false)
  })

  it('renders progress from the server counts, never from a local list', async () => {
    // The page used to hold `const competencies: string[] = []` and compare an
    // index against its length. The server sends the numbers now.
    const session = makeSession({ state: 'end_of_question', provider: null })
    session.endedCompetencies.value = 2
    session.totalCompetencies.value = 6
    const wrapper = await mountPage(session)

    expect(wrapper.text()).toContain('2')
    expect(wrapper.text()).toContain('6')
  })

  it('the scheduled-pause screen carries no secondary Pause control', async () => {
    // end_of_question IS the pause screen now. A Pause button on a pause screen
    // is meaningless, and it was the only trigger for the removed edge.
    const session = makeSession({ state: 'end_of_question', provider: null })
    const wrapper = await mountPage(session)

    const labels = wrapper.findAll('button').map((b) => b.text())
    expect(labels.some((l) => l.includes('interview.live.pause'))).toBe(false)
    expect(labels.some((l) => l.includes('interview.end_of_question.pause'))).toBe(false)
  })

  it('renders NO standalone paused screen — paused always implies a mounted avatar', async () => {
    // `live` is the only entry to `paused` now, so the provider is always still
    // published and the in-avatar panel is the only reachable resume control.
    // This assertion is what makes deleting the standalone section safe: without
    // it, removing dead markup could silently produce a blank screen with no way
    // back — exactly the dead end v0.6.3 had to repair.
    const session = makeSession({ state: 'paused', provider: null })
    const wrapper = await mountPage(session)

    const resume = wrapper
      .findAll('button')
      .find((b) => b.text().includes('interview.paused.resume'))

    expect(resume).toBeUndefined()
  })

  it('tears down and redirects to the configured error page when state becomes `error`', async () => {
    const redirectToError = vi.fn(() => true)
    mockUseExitRedirect.mockReturnValue({
      exitRedirectUrl: ref<string | null>(null),
      errorRedirectUrl: ref<string | null>('https://hr.acme.test/assessment/failed'),
      sessionFetchFailed: ref<'unauthenticated' | 'unavailable' | null>(null),
      fetchSession: vi.fn(async () => undefined),
      redirect: vi.fn(() => false),
      redirectToError,
    })

    const session = makeSession({ state: 'live' })
    await mountPage(session)

    session.state.value = 'error'
    await flushPromises()

    expect(session.teardown).toHaveBeenCalled()
    expect(redirectToError).toHaveBeenCalled()
  })

  it('tears down and redirects to the configured error page when state becomes `terminal`', async () => {
    const redirectToError = vi.fn(() => true)
    mockUseExitRedirect.mockReturnValue({
      exitRedirectUrl: ref<string | null>(null),
      errorRedirectUrl: ref<string | null>('https://hr.acme.test/assessment/failed'),
      sessionFetchFailed: ref<'unauthenticated' | 'unavailable' | null>(null),
      fetchSession: vi.fn(async () => undefined),
      redirect: vi.fn(() => false),
      redirectToError,
    })

    const session = makeSession({ state: 'live' })
    await mountPage(session)

    session.state.value = 'terminal'
    await flushPromises()

    expect(session.teardown).toHaveBeenCalled()
    expect(redirectToError).toHaveBeenCalled()
  })

  it('does NOT call redirectToError when no error_redirect_url is configured — inline screen stays', async () => {
    const redirectToError = vi.fn(() => false)
    mockUseExitRedirect.mockReturnValue({
      exitRedirectUrl: ref<string | null>(null),
      errorRedirectUrl: ref<string | null>(null),
      sessionFetchFailed: ref<'unauthenticated' | 'unavailable' | null>(null),
      fetchSession: vi.fn(async () => undefined),
      redirect: vi.fn(() => false),
      redirectToError,
    })

    const session = makeSession({ state: 'live' })
    await mountPage(session)

    session.state.value = 'error'
    await flushPromises()

    expect(redirectToError).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Expired-session variant (Task 3.4 RED — D-D)
//
// "Surfaced, not just logged: when the machine reaches terminal/error with
// sessionFetchFailed === 'unauthenticated' and no URL, the terminal renders
// the expired-session variant instead of no-opping."
// ---------------------------------------------------------------------------

describe('interview/session.vue — expired-session variant (D-D)', () => {
  it('state=terminal + sessionFetchFailed="unauthenticated" + no error_redirect_url → renders the session_expired copy', async () => {
    mockUseExitRedirect.mockReturnValue({
      exitRedirectUrl: ref<string | null>(null),
      errorRedirectUrl: ref<string | null>(null),
      sessionFetchFailed: ref<'unauthenticated' | 'unavailable' | null>('unauthenticated'),
      fetchSession: vi.fn(async () => undefined),
      redirect: vi.fn(() => false),
      redirectToError: vi.fn(() => false),
    })

    const session = makeSession({ state: 'terminal', provider: null })
    const wrapper = await mountPage(session)
    await flushPromises()

    expect(wrapper.text()).toContain('interview.terminal.session_expired.title')
  })

  it('state=error + sessionFetchFailed="unauthenticated" + no error_redirect_url → renders the session_expired copy, not the retry screen', async () => {
    mockUseExitRedirect.mockReturnValue({
      exitRedirectUrl: ref<string | null>(null),
      errorRedirectUrl: ref<string | null>(null),
      sessionFetchFailed: ref<'unauthenticated' | 'unavailable' | null>('unauthenticated'),
      fetchSession: vi.fn(async () => undefined),
      redirect: vi.fn(() => false),
      redirectToError: vi.fn(() => false),
    })

    const session = makeSession({ state: 'error', provider: null })
    const wrapper = await mountPage(session)
    await flushPromises()

    expect(wrapper.text()).toContain('interview.terminal.session_expired.title')
    expect(wrapper.find('[data-testid="retry-button"]').exists()).toBe(false)
  })

  it('state=terminal + sessionFetchFailed="unauthenticated" BUT error_redirect_url IS configured → redirects instead of rendering inline (existing mechanism wins)', async () => {
    const redirectToError = vi.fn(() => true)
    mockUseExitRedirect.mockReturnValue({
      exitRedirectUrl: ref<string | null>(null),
      errorRedirectUrl: ref<string | null>('https://hr.acme.test/assessment/failed'),
      sessionFetchFailed: ref<'unauthenticated' | 'unavailable' | null>('unauthenticated'),
      fetchSession: vi.fn(async () => undefined),
      redirect: vi.fn(() => false),
      redirectToError,
    })

    // Start 'live' then transition to 'terminal' — the watch fires on CHANGE,
    // matching the existing redirect tests' pattern (mounting already-terminal
    // never triggers a `watch()` without `immediate: true`).
    const session = makeSession({ state: 'live' })
    await mountPage(session)
    session.state.value = 'terminal'
    await flushPromises()

    expect(redirectToError).toHaveBeenCalled()
  })

  it('state=terminal + sessionFetchFailed="unavailable" (not unauthenticated) → does NOT render the expired-session variant', async () => {
    mockUseExitRedirect.mockReturnValue({
      exitRedirectUrl: ref<string | null>(null),
      errorRedirectUrl: ref<string | null>(null),
      sessionFetchFailed: ref<'unauthenticated' | 'unavailable' | null>('unavailable'),
      fetchSession: vi.fn(async () => undefined),
      redirect: vi.fn(() => false),
      redirectToError: vi.fn(() => false),
    })

    const session = makeSession({ state: 'terminal', provider: null })
    const wrapper = await mountPage(session)
    await flushPromises()

    expect(wrapper.text()).not.toContain('interview.terminal.session_expired.title')
  })

  it('the session machine\'s OWN terminalReason="session_expired" (Task 2.7) also renders the session_expired copy', async () => {
    mockUseExitRedirect.mockReturnValue({
      exitRedirectUrl: ref<string | null>(null),
      errorRedirectUrl: ref<string | null>(null),
      sessionFetchFailed: ref<'unauthenticated' | 'unavailable' | null>(null),
      fetchSession: vi.fn(async () => undefined),
      redirect: vi.fn(() => false),
      redirectToError: vi.fn(() => false),
    })

    const session = makeSession({ state: 'terminal', provider: null })
    session.terminalReason.value = 'session_expired' as never
    const wrapper = await mountPage(session)
    await flushPromises()

    expect(wrapper.text()).toContain('interview.terminal.session_expired.title')
  })
})
