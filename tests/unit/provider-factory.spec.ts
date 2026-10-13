/**
 * Unit tests for createProvider factory (app/providers/factory.ts)
 *
 * Tests verify:
 *   - createProvider('heygen', false) returns a HeyGenProvider instance
 *   - createProvider('tavus', false) returns a TavusProvider instance
 *   - createProvider('heygen', true) returns mock provider (NUXT_PUBLIC_INTERVIEW_PROVIDER_MOCK)
 *   - createProvider('tavus', true) returns mock provider
 *   - Unknown provider name → throws with descriptive error
 *   - Mock provider implements InterviewProvider interface
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildAdvancePayload, createBoundaryTicket } from '~/app/utils/advance-interaction'
import { createProvider } from '~/app/providers/factory'
import { HeyGenProvider } from '~/app/providers/heygen'
import { TavusProvider } from '~/app/providers/tavus'
import type { InterviewProvider } from '~/app/types/interview-provider'

describe('createProvider factory', () => {
  // ---- Real provider selection ----

  it('returns a HeyGenProvider instance when name is heygen and mock is false', () => {
    const provider = createProvider('heygen', false)
    expect(provider).toBeInstanceOf(HeyGenProvider)
  })

  it('returns a TavusProvider instance when name is tavus and mock is false', () => {
    const provider = createProvider('tavus', false)
    expect(provider).toBeInstanceOf(TavusProvider)
  })

  // ---- Mock provider (NUXT_PUBLIC_INTERVIEW_PROVIDER_MOCK injection point) ----

  it('returns a mock InterviewProvider when mock is true (heygen)', () => {
    const provider = createProvider('heygen', true)
    // Mock must implement the InterviewProvider interface
    expect(typeof provider.start).toBe('function')
    expect(typeof provider.stop).toBe('function')
    expect(typeof provider.on).toBe('function')
    expect(typeof provider.toggleMic).toBe('function')
  })

  it('returns a mock InterviewProvider when mock is true (tavus)', () => {
    const provider = createProvider('tavus', true)
    expect(typeof provider.start).toBe('function')
    expect(typeof provider.stop).toBe('function')
    expect(typeof provider.on).toBe('function')
    expect(typeof provider.toggleMic).toBe('function')
  })

  it('mock provider is the same type for heygen and tavus (single mock impl)', () => {
    const mockHeyGen = createProvider('heygen', true)
    const mockTavus = createProvider('tavus', true)
    // Both return the same mock implementation type
    expect(mockHeyGen.constructor.name).toBe(mockTavus.constructor.name)
  })

  it('mock provider has emitEndPhrase helper method for E2E tests', () => {
    const provider = createProvider('heygen', true) as InterviewProvider & {
      emitEndPhrase?: () => void
    }
    expect(typeof provider.emitEndPhrase).toBe('function')
  })

  it('mock provider has emitFinalPhrase helper method for E2E tests', () => {
    const provider = createProvider('heygen', true) as InterviewProvider & {
      emitFinalPhrase?: () => void
    }
    expect(typeof provider.emitFinalPhrase).toBe('function')
  })

  // ---- Mock provider behavior ----

  it('mock provider emitEndPhrase() emits complete state', async () => {
    const provider = createProvider('heygen', true) as InterviewProvider & {
      emitEndPhrase: () => void
    }
    const states: string[] = []
    provider.on('state', (s) => states.push(s as string))

    const el = document.createElement('div')
    await provider.start(el, {
      dbSessionId: 1,
      endPhrase: 'End phrase.',
      finalPhrase: 'Final phrase.',
    })

    provider.emitEndPhrase()
    expect(states).toContain('complete')
  })

  it('mock provider emitFinalPhrase() emits complete state', async () => {
    const provider = createProvider('heygen', true) as InterviewProvider & {
      emitFinalPhrase: () => void
    }
    const states: string[] = []
    provider.on('state', (s) => states.push(s as string))

    const el = document.createElement('div')
    await provider.start(el, {
      dbSessionId: 1,
      endPhrase: 'End phrase.',
      finalPhrase: 'Final phrase.',
    })

    provider.emitFinalPhrase()
    expect(states).toContain('complete')
  })

  it('mock provider emitToolCall() emits complete state', async () => {
    const provider = createProvider('tavus', true) as InterviewProvider & {
      emitToolCall: () => void
    }
    const states: string[] = []
    provider.on('state', (s) => states.push(s as string))

    provider.emitToolCall()
    expect(states).toContain('complete')
  })

  it('mock provider emitSpeaking() and emitListening() emit those states', () => {
    const provider = createProvider('heygen', true) as InterviewProvider & {
      emitSpeaking: () => void
      emitListening: () => void
    }
    const states: string[] = []
    provider.on('state', (s) => states.push(s as string))

    provider.emitSpeaking()
    provider.emitListening()

    expect(states).toEqual(['speaking', 'listening'])
  })

  it('mock provider emitTranscript() emits an entry with the given role, avatar by default', () => {
    const provider = createProvider('heygen', true) as InterviewProvider & {
      emitTranscript: (text: string, role?: 'user' | 'avatar') => void
    }
    const entries: Array<{ role: string; text: string }> = []
    provider.on('transcript', (e) => entries.push(e as { role: string; text: string }))

    provider.emitTranscript('What drove that decision?')
    provider.emitTranscript('I asked the team.', 'user')

    expect(entries.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'avatar', text: 'What drove that decision?' },
      { role: 'user', text: 'I asked the team.' },
    ])
  })

  it('mock provider stop() emits stopped state', async () => {
    const provider = createProvider('heygen', true)
    const states: string[] = []
    provider.on('state', (s) => states.push(s as string))

    await provider.stop()
    expect(states).toContain('stopped')
  })

  // ---- Mock provider: steering recorder and paint hold (E2E support) ----

  describe('mock provider E2E hooks', () => {
    type Mock = InterviewProvider & {
      sendBoundary: (t: ReturnType<typeof createBoundaryTicket>) => Promise<{ ok: boolean }>
      holdPainted: () => void
      releasePainted: () => void
    }
    const win = window as unknown as Record<string, unknown>
    const startCfg = { endPhrase: 'e', finalPhrase: 'f', dbSessionId: 1 }

    beforeEach(() => {
      delete win.__mockSteeringLog
      delete win.__mockInterviewProviders
      delete win.__mockInterviewProvider
      delete win.__mockInterviewAutoHoldPaint
    })

    it('sendBoundary() acknowledges and appends the append-context + respond pair, in order, across calls', async () => {
      const provider = createProvider('tavus', true) as Mock
      const ticket = createBoundaryTicket('conv-1', 'PRS')

      await expect(provider.sendBoundary(ticket)).resolves.toEqual({ ok: true })
      await provider.sendBoundary(ticket)

      const log = win.__mockSteeringLog as unknown[]
      expect(log).toHaveLength(4)
      expect(log.slice(0, 2)).toEqual([...buildAdvancePayload(ticket)])
      expect((log[1] as { event_type: string }).event_type).toBe('conversation.respond')
    })

    it('dispatches loadeddata on the mount element when started, unless the paint is held', async () => {
      const provider = createProvider('heygen', true) as Mock
      const video = document.createElement('video')
      const painted = vi.fn()
      video.addEventListener('loadeddata', painted)

      provider.holdPainted()
      await provider.start(video, startCfg)
      expect(painted).not.toHaveBeenCalled()

      provider.releasePainted()
      expect(painted).toHaveBeenCalledTimes(1)
    })

    it('a provider that was never held paints during start()', async () => {
      const provider = createProvider('heygen', true)
      const video = document.createElement('video')
      const painted = vi.fn()
      video.addEventListener('loadeddata', painted)

      await provider.start(video, startCfg)
      expect(painted).toHaveBeenCalledTimes(1)
    })

    it('releasePainted() before start() has nothing to paint and does not throw', () => {
      const provider = createProvider('heygen', true) as Mock
      expect(() => provider.releasePainted()).not.toThrow()
    })

    it('holds the paint from creation when the E2E auto-hold flag is set', async () => {
      win.__mockInterviewAutoHoldPaint = true
      const provider = createProvider('heygen', true)
      const video = document.createElement('video')
      const painted = vi.fn()
      video.addEventListener('loadeddata', painted)

      await provider.start(video, startCfg)
      expect(painted).not.toHaveBeenCalled()
    })

    it('registers every mock in order while the latest stays on __mockInterviewProvider', () => {
      const first = createProvider('heygen', true)
      const second = createProvider('heygen', true)

      expect(win.__mockInterviewProviders).toEqual([first, second])
      expect(win.__mockInterviewProvider).toBe(second)
    })
  })

  // ---- Unknown provider defensive guard ----

  it('throws a descriptive error for unknown provider name', () => {
    // TypeScript prevents this at compile time; runtime guard for defensive safety
    expect(() => {
      createProvider('unknown' as 'heygen', false)
    }).toThrow(/unknown provider/i)
  })
})
