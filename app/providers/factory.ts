/**
 * Provider factory.
 *
 * Selects the correct InterviewProvider implementation based on the `provider` field
 * returned by the POST /candidate/interview/start response.
 *
 * Mock injection point (W3 decision):
 *   When NUXT_PUBLIC_INTERVIEW_PROVIDER_MOCK === 'true', the factory returns the
 *   MockInterviewProvider from tests/e2e/fixtures/interview-provider.ts instead of
 *   a real SDK provider. This is the E2E test injection mechanism.
 *
 * SSR note: this factory is only called from useInterviewSession on the client side
 * (the interview page is ssr:false). The factory itself has no direct SDK imports
 * at module scope — those are lazy-loaded inside the provider constructors.
 */

import type { InterviewProvider, ProviderName } from '~/app/types/interview-provider'
import { HeyGenProvider } from '~/app/providers/heygen'
import { TavusProvider } from '~/app/providers/tavus'

/**
 * Create an InterviewProvider for the given provider name.
 *
 * @param name - Provider identifier from the /start response ('heygen' | 'tavus')
 * @param mock - When true, return the mock provider instead of a real SDK provider.
 *               Driven by useRuntimeConfig().public.interviewProviderMock === 'true'.
 * @returns An InterviewProvider instance ready to call .start() on.
 * @throws Error for unknown provider names (defensive runtime guard; TS prevents at compile time).
 */
export function createProvider(name: ProviderName, mock: boolean): InterviewProvider {
  if (mock) {
    // Lazy import of mock provider to avoid including it in the production bundle.
    // The mock is a lightweight in-memory implementation — no real SDK deps.
    // NOTE: In Vitest unit tests this import resolves synchronously from the test module.
    // In E2E (Playwright), NUXT_PUBLIC_INTERVIEW_PROVIDER_MOCK=true activates this path.
    const provider = createMockProvider()
    exposeMockProviderForE2E(provider)
    return provider
  }

  switch (name) {
    case 'heygen':
      return new HeyGenProvider()
    case 'tavus':
      return new TavusProvider()
    default: {
      // TypeScript narrows `name` to `never` here, but we add a runtime guard
      // for defensive safety in case the API returns an unexpected provider value.
      const exhaustive: never = name
      throw new Error(
        `[createProvider] Unknown provider: "${String(exhaustive)}". Expected 'heygen' or 'tavus'.`
      )
    }
  }
}

/**
 * Creates an inline mock provider for unit tests and E2E test injection.
 *
 * This is a lightweight implementation that does NOT import the E2E fixture module
 * at runtime — keeping the production bundle clean. The E2E fixture's
 * MockInterviewProvider class is used when wired through Playwright; this inline
 * mock is used in unit tests where the factory itself is under test.
 *
 * `start()`'s `mountEl` param is the REAL <video> element AvatarPlayer mounts
 * against. It is used ONLY to dispatch a synthetic `loadeddata` so
 * AvatarPlayer's D6 paint-detection fires deterministically under test — the
 * mock never attaches a real media stream. `holdPainted()`/`releasePainted()`
 * defer that dispatch so a test can drive the invisible-competency-handover
 * bound (10s) and crossfade paths deterministically instead of racing them.
 */
function createMockProvider(): InterviewProvider & {
  emitEndPhrase: () => void
  emitFinalPhrase: () => void
  emitToolCall: () => void
  holdPainted: () => void
  releasePainted: () => void
} {
  type CB = (payload: unknown) => void
  const listeners = new Map<string, CB[]>()
  let storedCfg: { endPhrase?: string; finalPhrase?: string } | null = null
  let held = false
  let pendingMountEl: HTMLElement | null = null

  function emit(evt: string, payload: unknown) {
    for (const cb of listeners.get(evt) ?? []) cb(payload)
  }

  function emitState(state: string) {
    emit('state', state)
  }

  function dispatchLoadedData() {
    if (pendingMountEl && typeof pendingMountEl.dispatchEvent === 'function') {
      pendingMountEl.dispatchEvent(new Event('loadeddata'))
    }
  }

  return {
    on(evt: string, cb: CB) {
      listeners.set(evt, [...(listeners.get(evt) ?? []), cb])
    },
    async start(
      mountEl: HTMLElement,
      cfg: { endPhrase: string; finalPhrase: string; dbSessionId: number }
    ) {
      storedCfg = { endPhrase: cfg.endPhrase, finalPhrase: cfg.finalPhrase }
      pendingMountEl = mountEl
      emitState('connecting')
      emitState('ready')
      emitState('listening')
      if (!held) dispatchLoadedData()
      return { providerSessionId: 'mock-session-id' }
    },
    async toggleMic() {},
    async setMicMuted(_muted: boolean) {},
    async stop() {
      emitState('stopped')
    },
    nudgeWrapUp() {},
    emitEndPhrase() {
      if (storedCfg?.endPhrase) {
        emit('transcript', { role: 'avatar', text: storedCfg.endPhrase, ts: Date.now() })
      }
      emitState('complete')
    },
    emitFinalPhrase() {
      if (storedCfg?.finalPhrase) {
        emit('transcript', { role: 'avatar', text: storedCfg.finalPhrase, ts: Date.now() })
      }
      emitState('complete')
    },
    emitToolCall() {
      emitState('complete')
    },
    /** Defers the synthetic `loadeddata` this mock would otherwise dispatch from `start()`. */
    holdPainted() {
      held = true
    },
    /** Releases a held paint and dispatches it immediately, if `start()` already ran. */
    releasePainted() {
      held = false
      dispatchLoadedData()
    },
  }
}

/**
 * C10 PR7 addition — E2E completion hook.
 *
 * `createMockProvider()`'s `emitEndPhrase`/`emitFinalPhrase`/`emitToolCall` methods
 * have no external handle once returned into `useInterviewSession`, so a Playwright
 * test running in the browser has no way to drive the state machine to `done`
 * (the only path is a provider `'complete'` state event). This exposes the SAME
 * instance `createProvider()` already returns on `window`, browser-only, and only
 * on the already-mock-gated path (`NUXT_PUBLIC_INTERVIEW_PROVIDER_MOCK === 'true'`,
 * itself never set outside test builds) — no new production code path, no change
 * to any existing mock behavior.
 *
 * invisible-competency-handover (F4): during a HeyGen handover TWO mock
 * instances exist at once (outgoing + incoming). `__mockInterviewProvider`
 * keeps pointing at the NEWEST one (backward-compatible with every existing
 * E2E spec that reads it), and `__mockInterviewProviders` is a growing
 * registry a handover-aware spec can index into (`[0]` = outgoing, `[1]` =
 * incoming) to drive each session independently.
 */
function exposeMockProviderForE2E(
  provider: InterviewProvider & {
    emitEndPhrase: () => void
    emitFinalPhrase: () => void
    holdPainted?: () => void
  }
): void {
  if (typeof window === 'undefined') return
  const win = window as unknown as Record<string, unknown>
  const registry = (win.__mockInterviewProviders as unknown[] | undefined) ?? []
  registry.push(provider)
  win.__mockInterviewProviders = registry
  win.__mockInterviewProvider = provider

  // invisible-competency-handover (D5 bound test support): a Playwright spec
  // sets `window.__mockInterviewAutoHoldPaint = true` BEFORE driving the
  // handover, so the incoming's paint is held from the instant its mock is
  // CREATED — not from whenever a test's own polling happens to notice the
  // registry grew, which races `AvatarPlayer.onMounted()` calling `start()`
  // (and dispatching the synthetic `loadeddata`) on the very same tick.
  if (win.__mockInterviewAutoHoldPaint === true) {
    provider.holdPainted?.()
  }
}
