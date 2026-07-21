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

import { describe, it, expect } from 'vitest'
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

  // ---- Unknown provider defensive guard ----

  it('throws a descriptive error for unknown provider name', () => {
    // TypeScript prevents this at compile time; runtime guard for defensive safety
    expect(() => {
      createProvider('unknown' as 'heygen', false)
    }).toThrow(/unknown provider/i)
  })
})
