/* eslint-disable no-empty-pattern, no-unused-vars */
import { test as base } from '@playwright/test'
import type {
  InterviewProvider,
  ProviderEvent,
  ProviderState,
  StartConfig,
} from '../../../app/types/interview-provider'

/**
 * Mock InterviewProvider for E2E tests.
 *
 * Replaces the C1 structural scaffold with a full InterviewProvider-compatible
 * implementation that emits events deterministically without opening real
 * WebSocket/WebRTC connections.
 *
 * Wired into createProvider() via NUXT_PUBLIC_INTERVIEW_PROVIDER_MOCK=true (W3 decision).
 *
 * Helper methods for Playwright tests:
 *   emitEndPhrase()   — simulates avatar speaking the end_phrase (HeyGen completion)
 *   emitFinalPhrase() — simulates avatar speaking the final_phrase (HeyGen last-question)
 *   emitToolCall()    — simulates Tavus end_interview tool_call completion
 *   emitTranscript()  — emits an arbitrary transcript entry
 *   emitError()       — simulates provider error (absent phrase, SDK failure)
 */
export class MockInterviewProvider implements InterviewProvider {
  private readonly listeners = new Map<ProviderEvent, Array<(payload: unknown) => void>>()
  private cfg: StartConfig | null = null

  on(evt: ProviderEvent, cb: (payload: unknown) => void): void {
    const existing = this.listeners.get(evt) ?? []
    this.listeners.set(evt, [...existing, cb])
  }

  private emit(evt: ProviderEvent, payload: unknown): void {
    for (const cb of this.listeners.get(evt) ?? []) {
      cb(payload)
    }
  }

  private emitState(state: ProviderState): void {
    this.emit('state', state)
  }

  async start(_mountEl: HTMLElement, cfg: StartConfig): Promise<{ providerSessionId?: string }> {
    this.cfg = cfg
    // Emit connecting → ready → listening (mirrors HeyGen real behavior)
    this.emitState('connecting')
    this.emitState('ready')
    this.emitState('listening')
    return { providerSessionId: 'mock-session-id' }
  }

  async toggleMic(): Promise<void> {
    // No-op mock
  }

  async stop(): Promise<void> {
    this.emitState('stopped')
  }

  nudgeWrapUp(): void {
    // No-op mock
  }

  // ---- E2E Helper Methods ----

  /**
   * Simulate avatar speaking the end_phrase (inter-question completion signal).
   * Emits a transcript entry then transitions provider state to 'complete'.
   */
  emitEndPhrase(): void {
    if (!this.cfg?.endPhrase) return
    this.emit('transcript', {
      role: 'avatar' as const,
      text: this.cfg.endPhrase,
      ts: Date.now(),
    })
    this.emitState('complete')
  }

  /**
   * Simulate avatar speaking the final_phrase (last-question completion signal).
   */
  emitFinalPhrase(): void {
    if (!this.cfg?.finalPhrase) return
    this.emit('transcript', {
      role: 'avatar' as const,
      text: this.cfg.finalPhrase,
      ts: Date.now(),
    })
    this.emitState('complete')
  }

  /**
   * Simulate Tavus end_interview tool_call completion signal.
   */
  emitToolCall(): void {
    this.emitState('complete')
  }

  /**
   * Emit a transcript entry for testing transcript rendering.
   */
  emitTranscript(text: string, role: 'user' | 'avatar' = 'avatar'): void {
    this.emit('transcript', { role, text, ts: Date.now() })
  }

  /**
   * Simulate a provider error (absent phrase, SDK failure, etc.)
   */
  emitError(code: string, message: string): void {
    this.emit('error', { code, message })
  }
}

// ---- Playwright fixture ----

interface FakeInterviewProvider {
  /** Full MockInterviewProvider interface */
  provider: MockInterviewProvider
  /** C1 backward-compat: returns a pre-recorded session token. */
  getSessionToken(): Promise<string>
  /** C1 backward-compat: simulates the provider emitting a question event. */
  emitQuestion(text: string): void
}

interface InterviewFixtures {
  fakeProvider: FakeInterviewProvider
}

export const test = base.extend<InterviewFixtures>({
  fakeProvider: async ({}, use) => {
    const mock = new MockInterviewProvider()
    const fixture: FakeInterviewProvider = {
      provider: mock,
      async getSessionToken() {
        return 'fake-session-token-mock'
      },
      emitQuestion(text: string) {
        mock.emitTranscript(text, 'avatar')
      },
    }
    await use(fixture)
  },
})

export { expect } from '@playwright/test'
