/* eslint-disable no-unused-vars */
/**
 * Unit tests for TavusProvider (app/providers/tavus.ts)
 *
 * The Daily.co SDK is injected as a mock — no real WebRTC connections.
 * Tests verify:
 *   - start() emits connecting → ready state transitions
 *   - conversation.tool_call with name='end_interview' → emits 'state' 'complete'
 *   - conversation.tool_call with any other name → NO 'complete' emission
 *   - stop() → leaves room; emits 'stopped'
 *   - No endPhrase/finalPhrase validation (Tavus uses tool_call, not phrase matching)
 *   - SSR guard: sdkLoader throws → provider emits 'error'
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TavusProvider } from '~/app/providers/tavus'

// Mock Daily.co call frame shape
interface MockCallFrame {
  on: ReturnType<typeof vi.fn>
  join: ReturnType<typeof vi.fn>
  leave: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  _emit: (eventName: string, data: unknown) => void
}

function createMockCallFrame(): MockCallFrame {
  const handlers = new Map<string, ((data: unknown) => void)[]>()

  const frame: MockCallFrame = {
    on: vi.fn((event: string, cb: (data: unknown) => void) => {
      const list = handlers.get(event) ?? []
      handlers.set(event, [...list, cb])
    }),
    join: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    _emit: (eventName: string, data: unknown) => {
      for (const cb of handlers.get(eventName) ?? []) {
        cb(data)
      }
    },
  }
  return frame
}

const PHRASES = {
  endPhrase: 'Passiamo alla prossima domanda.',
  finalPhrase: 'Grazie per il tuo tempo.',
}

const CONVERSATION_URL = 'https://tavus.daily.co/fake-room-id'

describe('TavusProvider', () => {
  let mockFrame: MockCallFrame
  let emittedStates: string[]
  let emittedTranscripts: unknown[]
  let emittedErrors: unknown[]

  beforeEach(() => {
    mockFrame = createMockCallFrame()
    emittedStates = []
    emittedTranscripts = []
    emittedErrors = []
  })

  function makeProvider() {
    const loader = vi.fn().mockResolvedValue(mockFrame)
    const provider = new TavusProvider(loader)
    provider.on('state', (s) => emittedStates.push(s as string))
    provider.on('transcript', (t) => emittedTranscripts.push(t))
    provider.on('error', (e) => emittedErrors.push(e))
    return { provider, loader }
  }

  // ---- State transitions ----

  it('emits connecting → ready on successful start()', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')

    await provider.start(el, { dbSessionId: 1, conversationUrl: CONVERSATION_URL, ...PHRASES })

    expect(emittedStates).toContain('connecting')
    expect(emittedStates).toContain('ready')
    expect(emittedStates.indexOf('connecting')).toBeLessThan(emittedStates.indexOf('ready'))
  })

  it('calls SDK join with the conversationUrl from config', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')

    await provider.start(el, { dbSessionId: 1, conversationUrl: CONVERSATION_URL, ...PHRASES })

    expect(mockFrame.join).toHaveBeenCalledWith(expect.objectContaining({ url: CONVERSATION_URL }))
  })

  // ---- Completion detection: tool_call ----

  it('emits state complete on conversation.tool_call with name=end_interview', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, conversationUrl: CONVERSATION_URL, ...PHRASES })

    mockFrame._emit('app-message', {
      data: { type: 'conversation.tool_call', name: 'end_interview' },
    })

    expect(emittedStates).toContain('complete')
  })

  it('does NOT emit complete for tool_call with different name', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, conversationUrl: CONVERSATION_URL, ...PHRASES })

    mockFrame._emit('app-message', {
      data: { type: 'conversation.tool_call', name: 'other_tool' },
    })

    expect(emittedStates).not.toContain('complete')
  })

  it('does NOT emit complete for unrelated app-message events', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, conversationUrl: CONVERSATION_URL, ...PHRASES })

    mockFrame._emit('app-message', { data: { type: 'some_other_event' } })

    expect(emittedStates).not.toContain('complete')
  })

  // ---- No endPhrase/finalPhrase validation ----
  // Tavus uses tool_call, NOT phrase matching — phrases are accepted but not validated

  it('starts successfully even when endPhrase/finalPhrase are empty (Tavus ignores them)', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')

    await provider.start(el, {
      dbSessionId: 1,
      conversationUrl: CONVERSATION_URL,
      endPhrase: '',
      finalPhrase: '',
    })

    expect(emittedErrors).toHaveLength(0)
    expect(emittedStates).toContain('connecting')
    expect(emittedStates).toContain('ready')
  })

  // ---- stop() ----

  it('stop() calls SDK leave and emits state stopped', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, conversationUrl: CONVERSATION_URL, ...PHRASES })

    await provider.stop()

    expect(mockFrame.leave).toHaveBeenCalled()
    expect(emittedStates).toContain('stopped')
  })

  it('stop() emits stopped even when called before start()', async () => {
    const { provider } = makeProvider()
    await provider.stop()
    expect(emittedStates).toContain('stopped')
  })

  // ---- toggleMic() ----

  it('toggleMic() resolves without throwing (Daily handles mic toggle via setLocalAudio or similar)', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, conversationUrl: CONVERSATION_URL, ...PHRASES })

    await expect(provider.toggleMic()).resolves.not.toThrow()
  })

  // ---- SSR guard ----

  it('emits error when sdkLoader throws (mimics SSR guard or network error)', async () => {
    const failingLoader = vi.fn().mockRejectedValue(new Error('SDK not available'))
    const provider = new TavusProvider(failingLoader)
    provider.on('state', (s) => emittedStates.push(s as string))
    provider.on('error', (e) => emittedErrors.push(e))

    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, conversationUrl: CONVERSATION_URL, ...PHRASES })

    expect(emittedErrors.length).toBeGreaterThan(0)
    const err = emittedErrors[0] as { code: string }
    expect(err.code).toBe('sdk_error')
  })
})
