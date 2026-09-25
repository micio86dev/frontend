/**
 * InterviewSession.vue — pause-reason notices and the tab/network guard wiring
 * (public-api SPEC §4.4). A network-guard reconnect must never auto-resume a
 * pause the candidate (or the tab guard) started.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, shallowRef, computed, nextTick, defineComponent, h } from 'vue'
import type { SessionPlayer, SessionState } from '~/app/composables/useInterviewSession'
import type { InterviewProvider, StartConfig } from '~/app/types/interview-provider'
import type { UseNetworkGuardOptions } from '~/app/composables/useNetworkGuard'

vi.setConfig({ testTimeout: 30000 })

const { mockUseInterviewSession, mockUseExitRedirect, guards } = vi.hoisted(() => ({
  mockUseInterviewSession: vi.fn(),
  mockUseExitRedirect: vi.fn(),
  guards: {
    network: null as unknown,
    tab: null as unknown,
  },
}))

vi.mock('~/composables/useInterviewSession', () => ({
  useInterviewSession: mockUseInterviewSession,
}))
vi.mock('~/composables/useExitRedirect', () => ({ useExitRedirect: mockUseExitRedirect }))
vi.mock('~/composables/useNetworkGuard', () => ({
  useNetworkGuard: (options: unknown) => {
    guards.network = options
    return { start: vi.fn(), stop: vi.fn() }
  },
}))
vi.mock('~/composables/useTabVisibilityGuard', () => ({
  useTabVisibilityGuard: (options: unknown) => {
    guards.tab = options
    return { start: vi.fn(), stop: vi.fn() }
  },
}))

function makeSession(state: SessionState, withProvider = false) {
  const activeProvider = shallowRef<InterviewProvider | null>(
    withProvider
      ? ({ on: vi.fn(), start: vi.fn(), stop: vi.fn(), toggleMic: vi.fn() } as never)
      : null
  )
  const activeConfig = shallowRef<StartConfig | null>(
    withProvider ? { dbSessionId: 42, sessionToken: 'tok', endPhrase: 'a', finalPhrase: 'b' } : null
  )
  const players = computed<SessionPlayer[]>(() =>
    activeProvider.value && activeConfig.value
      ? [
          {
            key: 42,
            provider: activeProvider.value,
            config: activeConfig.value,
            role: 'live',
            muted: false,
          },
        ]
      : []
  )
  return {
    state: ref<SessionState>(state),
    retryAttemptCount: ref(0),
    currentCompetencyIndex: ref(0),
    terminalReason: ref(null),
    sessionId: ref<number | null>(42),
    endedCompetencies: ref<number | null>(null),
    totalCompetencies: ref<number | null>(null),
    activeProvider,
    activeConfig,
    players,
    incomingSession: shallowRef(null),
    handoverInFlight: computed(() => false),
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

async function mountSession(session: ReturnType<typeof makeSession>) {
  mockUseInterviewSession.mockReturnValue(session)
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
        AvatarPlayer: true,
        DeviceCheck: true,
        ProctorOverlay: true,
        InterviewTimer: true,
        InterviewCaption: true,
        InterviewProgressBar: true,
      },
    },
  })
  await nextTick()
  return wrapper
}

const network = () => guards.network as UseNetworkGuardOptions
const tab = () => guards.tab as { onHiddenTimeout: () => void }

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
  vi.stubGlobal(
    'useI18n',
    vi.fn(() => ({ t: (key: string) => key, locale: ref('it') }))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('InterviewSession.vue — tab visibility guard', () => {
  it('pauses a live session and shows the tab-hidden notice', async () => {
    const session = makeSession('live')
    const wrapper = await mountSession(session)

    tab().onHiddenTimeout()
    expect(session.pause).toHaveBeenCalledTimes(1)

    session.state.value = 'paused'
    await nextTick()
    expect(wrapper.find('[data-testid="tab-hidden-warning"]').exists()).toBe(true)
  })

  it('does not pause a session that is not live', async () => {
    const session = makeSession('paused')
    await mountSession(session)

    tab().onHiddenTimeout()

    expect(session.pause).not.toHaveBeenCalled()
  })
})

describe('InterviewSession.vue — network guard', () => {
  it('shows the reconnecting notice after a network pause, then the failed notice on onFailed', async () => {
    const session = makeSession('live')
    const wrapper = await mountSession(session)

    network().onOffline?.()
    expect(session.pause).toHaveBeenCalledTimes(1)
    session.state.value = 'paused'
    await nextTick()
    expect(wrapper.find('[data-testid="network-reconnecting-notice"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="network-failed-warning"]').exists()).toBe(false)

    network().onFailed()
    await nextTick()
    expect(wrapper.find('[data-testid="network-failed-warning"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="network-reconnecting-notice"]').exists()).toBe(false)
  })

  it('auto-resumes on reconnect when the network guard itself paused the session', async () => {
    const session = makeSession('live')
    await mountSession(session)

    network().onOffline?.()
    session.state.value = 'paused'
    network().onReconnected()

    expect(session.resume).toHaveBeenCalledTimes(1)
  })

  it('never auto-resumes a pause the candidate started manually', async () => {
    const session = makeSession('live', true)
    const wrapper = await mountSession(session)

    const pauseButton = wrapper
      .findAll('button')
      .find((b) => b.text().includes('interview.live.pause'))
    expect(pauseButton).toBeDefined()
    await pauseButton!.trigger('click')
    expect(session.pause).toHaveBeenCalledTimes(1)
    session.state.value = 'paused'

    network().onReconnected()

    expect(session.resume).not.toHaveBeenCalled()
  })

  it('never auto-resumes after the guard gave up (onFailed) — Resume stays manual', async () => {
    const session = makeSession('live')
    await mountSession(session)

    network().onOffline?.()
    session.state.value = 'paused'
    network().onFailed()
    network().onReconnected()

    expect(session.resume).not.toHaveBeenCalled()
  })

  it('does not pause when offline fires outside the live state', async () => {
    const session = makeSession('paused')
    await mountSession(session)

    network().onOffline?.()

    expect(session.pause).not.toHaveBeenCalled()
  })
})
