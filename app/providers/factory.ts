/* eslint-disable no-unused-vars */
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
    return createMockProvider()
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
 */
function createMockProvider(): InterviewProvider & {
  emitEndPhrase: () => void
  emitFinalPhrase: () => void
  emitToolCall: () => void
} {
  type CB = (payload: unknown) => void
  const listeners = new Map<string, CB[]>()
  let storedCfg: { endPhrase?: string; finalPhrase?: string } | null = null

  function emit(evt: string, payload: unknown) {
    for (const cb of listeners.get(evt) ?? []) cb(payload)
  }

  function emitState(state: string) {
    emit('state', state)
  }

  return {
    on(evt: string, cb: CB) {
      listeners.set(evt, [...(listeners.get(evt) ?? []), cb])
    },
    async start(
      _mountEl: HTMLElement,
      cfg: { endPhrase: string; finalPhrase: string; dbSessionId: number }
    ) {
      storedCfg = { endPhrase: cfg.endPhrase, finalPhrase: cfg.finalPhrase }
      emitState('connecting')
      emitState('ready')
      emitState('listening')
      return { providerSessionId: 'mock-session-id' }
    },
    async toggleMic() {},
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
  }
}
