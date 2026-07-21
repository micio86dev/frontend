/* eslint-disable no-unused-vars */
/**
 * Unit tests for HeyGenProvider (app/providers/heygen.ts)
 *
 * The SDK is injected as a mock factory — no real WebRTC/WebSocket connections.
 * Tests verify:
 *   - start() emits correct state transitions: connecting → ready → listening
 *   - avatar_talking_message events fire the 'transcript' event
 *   - matchesEndPhrase match on transcript → 'state' 'complete' emitted
 *   - Absent endPhrase → 'error' emitted before SDK init; state never reaches 'connecting'
 *   - Absent finalPhrase → same error path
 *   - stop() → 'state' 'stopped' emitted; SDK close() called
 *   - toggleMic() → SDK muteInputAudio called
 *   - SSR path: when sdkLoader throws (mimics SSR guard), provider emits 'error'
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HeyGenProvider } from '~/app/providers/heygen'

// ---- Mock SDK session factory ----
// This pattern replaces vi.mock + dynamic-import complexities.
// We inject a mock sdkLoader directly into the HeyGenProvider constructor.

interface MockSession {
  on: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  startVoiceChat: ReturnType<typeof vi.fn>
  muteInputAudio: ReturnType<typeof vi.fn>
  speak: ReturnType<typeof vi.fn>
  // Internal helper to simulate SDK emitting an event
  _emit: (eventName: string, data: unknown) => void
}

function createMockSession(): MockSession {
  const handlers = new Map<string, ((data: unknown) => void)[]>()

  const session: MockSession = {
    on: vi.fn((event: string, cb: (data: unknown) => void) => {
      const list = handlers.get(event) ?? []
      handlers.set(event, [...list, cb])
    }),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    startVoiceChat: vi.fn().mockResolvedValue(undefined),
    muteInputAudio: vi.fn().mockResolvedValue(undefined),
    speak: vi.fn().mockResolvedValue(undefined),
    _emit: (eventName: string, data: unknown) => {
      for (const cb of handlers.get(eventName) ?? []) {
        cb(data)
      }
    },
  }
  return session
}

const PHRASES = {
  endPhrase: 'Passiamo alla prossima domanda.',
  finalPhrase: 'Grazie per il tuo tempo.',
}

describe('HeyGenProvider', () => {
  let mockSession: MockSession
  let emittedStates: string[]
  let emittedTranscripts: unknown[]
  let emittedErrors: unknown[]

  beforeEach(() => {
    mockSession = createMockSession()
    emittedStates = []
    emittedTranscripts = []
    emittedErrors = []
  })

  function makeProvider() {
    const loader = vi.fn().mockResolvedValue(mockSession)
    const provider = new HeyGenProvider(loader)
    provider.on('state', (s) => emittedStates.push(s as string))
    provider.on('transcript', (t) => emittedTranscripts.push(t))
    provider.on('error', (e) => emittedErrors.push(e))
    return { provider, loader }
  }

  // ---- State transitions ----

  it('emits connecting → ready → listening on successful start()', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')

    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    expect(emittedStates).toEqual(expect.arrayContaining(['connecting', 'ready', 'listening']))
    // Verify order
    expect(emittedStates.indexOf('connecting')).toBeLessThan(emittedStates.indexOf('ready'))
    expect(emittedStates.indexOf('ready')).toBeLessThan(emittedStates.indexOf('listening'))
  })

  it('calls SDK connect and startVoiceChat on start()', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')

    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    expect(mockSession.connect).toHaveBeenCalledOnce()
    expect(mockSession.startVoiceChat).toHaveBeenCalledOnce()
  })

  // ---- Transcript events ----

  it('fires transcript event on avatar_talking_message SDK event', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    mockSession._emit('avatar_talking_message', {
      role: 'avatar',
      message: 'Buongiorno, iniziamo.',
    })

    expect(emittedTranscripts).toHaveLength(1)
    const entry = emittedTranscripts[0] as { role: string; text: string }
    expect(entry.role).toBe('avatar')
    expect(entry.text).toBe('Buongiorno, iniziamo.')
  })

  it('sets role to "user" when avatar_talking_message.role is "user"', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    mockSession._emit('avatar_talking_message', { role: 'user', message: 'Ciao.' })

    const entry = emittedTranscripts[0] as { role: string }
    expect(entry.role).toBe('user')
  })

  // ---- Completion detection ----

  it('emits state complete when avatar transcript matches endPhrase', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    mockSession._emit('avatar_talking_message', {
      role: 'avatar',
      message: PHRASES.endPhrase,
    })

    expect(emittedStates).toContain('complete')
  })

  it('emits state complete when avatar transcript matches finalPhrase', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    mockSession._emit('avatar_talking_message', {
      role: 'avatar',
      message: PHRASES.finalPhrase,
    })

    expect(emittedStates).toContain('complete')
  })

  it('does NOT emit complete for unrelated avatar transcript text', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    mockSession._emit('avatar_talking_message', {
      role: 'avatar',
      message: 'Parliamo della tua esperienza professionale.',
    })

    expect(emittedStates).not.toContain('complete')
  })

  it('does NOT emit complete for user transcript matching the phrase', async () => {
    // Completion detection only applies to avatar role transcripts
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    mockSession._emit('avatar_talking_message', {
      role: 'user',
      message: PHRASES.endPhrase,
    })

    expect(emittedStates).not.toContain('complete')
  })

  // ---- Absent-phrase guard (D4 CRITICAL) ----

  it('emits error immediately on start() when endPhrase is empty string', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')

    await provider.start(el, {
      dbSessionId: 1,
      endPhrase: '',
      finalPhrase: PHRASES.finalPhrase,
    })

    expect(emittedErrors).toHaveLength(1)
    const err = emittedErrors[0] as { code: string }
    expect(err.code).toBe('absent_phrase')
  })

  it('does NOT call SDK loader when endPhrase is empty', async () => {
    const { provider, loader } = makeProvider()
    const el = document.createElement('div')

    await provider.start(el, { dbSessionId: 1, endPhrase: '', finalPhrase: PHRASES.finalPhrase })

    expect(loader).not.toHaveBeenCalled()
    expect(emittedStates).not.toContain('connecting')
  })

  it('emits error immediately on start() when finalPhrase is empty string', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')

    await provider.start(el, {
      dbSessionId: 1,
      endPhrase: PHRASES.endPhrase,
      finalPhrase: '',
    })

    expect(emittedErrors).toHaveLength(1)
    expect(emittedStates).not.toContain('connecting')
  })

  // ---- stop() ----

  it('stop() emits state stopped and calls SDK close()', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    await provider.stop()

    expect(emittedStates).toContain('stopped')
    expect(mockSession.close).toHaveBeenCalledOnce()
  })

  it('stop() emits stopped even when called before start()', async () => {
    const { provider } = makeProvider()
    await provider.stop()
    expect(emittedStates).toContain('stopped')
    expect(mockSession.close).not.toHaveBeenCalled()
  })

  // ---- toggleMic() ----

  it('toggleMic() calls SDK muteInputAudio', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    await provider.toggleMic()

    expect(mockSession.muteInputAudio).toHaveBeenCalledOnce()
  })

  it('toggleMic() does nothing before start()', async () => {
    const { provider } = makeProvider()
    await provider.toggleMic()
    expect(mockSession.muteInputAudio).not.toHaveBeenCalled()
  })

  // ---- SSR guard ----

  it('emits error when sdkLoader throws (mimics SSR guard or SDK error)', async () => {
    const failingLoader = vi.fn().mockRejectedValue(new Error('SDK not available in SSR'))
    const provider = new HeyGenProvider(failingLoader)
    provider.on('state', (s) => emittedStates.push(s as string))
    provider.on('error', (e) => emittedErrors.push(e))

    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    // State should reach 'connecting' before sdkLoader is called, then error
    expect(emittedStates).toContain('connecting')
    expect(emittedErrors.length).toBeGreaterThan(0)
    const err = emittedErrors[0] as { code: string }
    expect(err.code).toBe('sdk_error')
  })
})
