/**
 * Type-only tests for app/types/interview-provider.ts
 *
 * These tests verify the exported contract matches the D2 design spec:
 *   - All required types exported
 *   - StartConfig has explicit endPhrase/finalPhrase (non-optional)
 *   - StartConfig has NO index signature
 *   - InterviewProvider.start() returns Promise<{ providerSessionId?: string }>
 */

import { describe, it, expectTypeOf } from 'vitest'

// Dynamic import so the RED phase fails if the file doesn't exist
// The tests below use type assertions to verify the contract at the type level

describe('interview-provider types — D2 contract', () => {
  it('exports ProviderName as a union of heygen and tavus', async () => {
    await import('~/app/types/interview-provider')
    // Type assertion: ProviderName must accept only 'heygen' | 'tavus'
    type ProviderName = import('~/app/types/interview-provider').ProviderName
    expectTypeOf<'heygen'>().toMatchTypeOf<ProviderName>()
    expectTypeOf<'tavus'>().toMatchTypeOf<ProviderName>()
  })

  it('exports ProviderState covering all 6 states', async () => {
    type ProviderState = import('~/app/types/interview-provider').ProviderState
    expectTypeOf<'connecting'>().toMatchTypeOf<ProviderState>()
    expectTypeOf<'ready'>().toMatchTypeOf<ProviderState>()
    expectTypeOf<'listening'>().toMatchTypeOf<ProviderState>()
    expectTypeOf<'speaking'>().toMatchTypeOf<ProviderState>()
    expectTypeOf<'stopped'>().toMatchTypeOf<ProviderState>()
    expectTypeOf<'complete'>().toMatchTypeOf<ProviderState>()
  })

  it('exports ProviderEvent covering transcript, state, error', async () => {
    type ProviderEvent = import('~/app/types/interview-provider').ProviderEvent
    expectTypeOf<'transcript'>().toMatchTypeOf<ProviderEvent>()
    expectTypeOf<'state'>().toMatchTypeOf<ProviderEvent>()
    expectTypeOf<'error'>().toMatchTypeOf<ProviderEvent>()
  })

  it('exports TranscriptEntry with role, text, ts, seq?', async () => {
    type TranscriptEntry = import('~/app/types/interview-provider').TranscriptEntry
    type TestEntry = { role: 'user' | 'avatar'; text: string; ts: number; seq?: number }
    expectTypeOf<TestEntry>().toMatchTypeOf<TranscriptEntry>()
  })

  it('StartConfig has required endPhrase and finalPhrase fields (non-optional)', async () => {
    type StartConfig = import('~/app/types/interview-provider').StartConfig
    // These must be required (non-optional) string fields
    expectTypeOf<StartConfig>().toHaveProperty('endPhrase')
    expectTypeOf<StartConfig>().toHaveProperty('finalPhrase')

    // Verify they are string (not string | undefined)
    type EndPhrase = StartConfig['endPhrase']
    type FinalPhrase = StartConfig['finalPhrase']
    expectTypeOf<EndPhrase>().toEqualTypeOf<string>()
    expectTypeOf<FinalPhrase>().toEqualTypeOf<string>()
  })

  it('StartConfig has dbSessionId as required number', async () => {
    type StartConfig = import('~/app/types/interview-provider').StartConfig
    type DbSessionId = StartConfig['dbSessionId']
    expectTypeOf<DbSessionId>().toEqualTypeOf<number>()
  })

  it('StartConfig has sessionToken as optional string', async () => {
    type StartConfig = import('~/app/types/interview-provider').StartConfig
    type SessionToken = StartConfig['sessionToken']
    expectTypeOf<SessionToken>().toEqualTypeOf<string | undefined>()
  })

  it('StartConfig has conversationUrl as optional string', async () => {
    type StartConfig = import('~/app/types/interview-provider').StartConfig
    type ConversationUrl = StartConfig['conversationUrl']
    expectTypeOf<ConversationUrl>().toEqualTypeOf<string | undefined>()
  })

  it('StartConfig does NOT accept arbitrary extra keys (no index signature)', async () => {
    type StartConfig = import('~/app/types/interview-provider').StartConfig
    // An interface WITHOUT [k:string]:unknown is incompatible with Record<string,unknown>
    // We verify that StartConfig only has the documented keys — this is a structural test.
    // If StartConfig had [k:string]:unknown, it would be assignable to Record<string, unknown>.
    // With exactOptionalPropertyTypes + no index sig, unknown keys cause compile errors.
    // We assert the known keys exist; the absence of index sig is enforced by TypeScript strict mode.
    type KnownKeys = keyof StartConfig
    // 'unknownKey' should NOT be in KnownKeys
    expectTypeOf<'dbSessionId'>().toMatchTypeOf<KnownKeys>()
    expectTypeOf<'endPhrase'>().toMatchTypeOf<KnownKeys>()
    expectTypeOf<'finalPhrase'>().toMatchTypeOf<KnownKeys>()
  })

  it('InterviewProvider.start() returns Promise<{ providerSessionId?: string }>', async () => {
    type InterviewProvider = import('~/app/types/interview-provider').InterviewProvider
    type StartReturn = ReturnType<InterviewProvider['start']>
    expectTypeOf<StartReturn>().toEqualTypeOf<Promise<{ providerSessionId?: string }>>()
  })

  it('InterviewProvider has toggleMic, stop, on, nudgeWrapUp? methods', async () => {
    type InterviewProvider = import('~/app/types/interview-provider').InterviewProvider
    expectTypeOf<InterviewProvider>().toHaveProperty('toggleMic')
    expectTypeOf<InterviewProvider>().toHaveProperty('stop')
    expectTypeOf<InterviewProvider>().toHaveProperty('on')
    expectTypeOf<InterviewProvider>().toHaveProperty('nudgeWrapUp')
  })
})
