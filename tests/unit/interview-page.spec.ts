/**
 * app/pages/interview/[token].vue — the container's wiring, not its styling.
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
import { ref, shallowRef, nextTick, defineComponent, h } from 'vue'
import type { InterviewProvider, StartConfig } from '~/app/types/interview-provider'
import type { SessionState } from '~/app/composables/useInterviewSession'

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

function makeSession(
  overrides: { state?: SessionState; provider?: InterviewProvider | null } = {}
) {
  const provider = overrides.provider === undefined ? makeProvider() : overrides.provider
  return {
    state: ref<SessionState>(overrides.state ?? 'live'),
    retryAttemptCount: ref(0),
    currentCompetencyIndex: ref(0),
    terminalReason: ref(null),
    sessionId: ref<number | null>(42),
    activeProvider: shallowRef<InterviewProvider | null>(provider),
    activeConfig: shallowRef<StartConfig | null>(provider ? CONFIG : null),
    acceptConsent: vi.fn(),
    confirmDevices: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    retry: vi.fn(),
    nextCompetency: vi.fn(),
    endQuestion: vi.fn(async () => undefined),
    teardown: vi.fn(async () => undefined),
  }
}

// Stub for the components Nuxt auto-imports (unresolvable in Vitest) and for the
// browser-only children whose real implementations need WebRTC / MediaPipe.
const AvatarPlayerStub = defineComponent({
  name: 'AvatarPlayer',
  props: { provider: { type: Object, required: true }, config: { type: Object, required: true } },
  setup: () => () => h('div', { 'data-testid': 'avatar-player' }),
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
  const { default: Page } = await import('~/app/pages/interview/[token].vue')
  const wrapper = mount(Page, { global: globalConfig() })
  await nextTick()
  return wrapper
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockUseExitRedirect.mockReturnValue({
    exitRedirectUrl: ref<string | null>(null),
    fetchSession: vi.fn(async () => undefined),
    redirect: vi.fn(() => false),
  })
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useHead', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('interview/[token].vue — live render path', () => {
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

describe('interview/[token].vue — timer expiry and skip', () => {
  it("timer expiry dispatches endQuestion('timeout')", async () => {
    const session = makeSession({ state: 'live' })
    const wrapper = await mountPage(session)

    await wrapper.find('[data-testid="fire-expired"]').trigger('click')

    expect(session.endQuestion).toHaveBeenCalledWith('timeout')
  })

  it("the skip button dispatches endQuestion('skipped')", async () => {
    const session = makeSession({ state: 'live' })
    const wrapper = await mountPage(session)

    const skipButton = wrapper
      .findAll('button')
      .find((b) => b.text().includes('interview.live.skip'))
    expect(skipButton).toBeDefined()

    await skipButton!.trigger('click')

    expect(session.endQuestion).toHaveBeenCalledWith('skipped')
  })

  it('the pause button still routes to session.pause()', async () => {
    const session = makeSession({ state: 'live' })
    const wrapper = await mountPage(session)

    const pauseButton = wrapper
      .findAll('button')
      .find((b) => b.text().includes('interview.live.pause'))

    await pauseButton!.trigger('click')

    expect(session.pause).toHaveBeenCalled()
  })
})
