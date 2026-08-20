/**
 * Unit tests for HeyGenProvider (app/providers/heygen.ts)
 *
 * The SDK is injected as a mock factory — no real WebRTC/WebSocket connections.
 *
 * Real SDK API (LiveAvatarSession from @heygen/liveavatar-web-sdk@0.0.18):
 *   - Constructor: new LiveAvatarSession(sessionAccessToken: string, config?: SessionConfig)
 *   - Session events (SessionEvent string values):
 *       "session.state_changed"  — SessionState transitions
 *       "session.stream_ready"   — media tracks ready; attach() belongs HERE
 *       "session.disconnected"   — carries a SessionDisconnectReason
 *   - Agent events (AgentEventsEnum string values):
 *       "avatar.transcription" — avatar speech with payload { text: string }
 *       "user.transcription"   — candidate speech with payload { text: string }
 *       "user.speak_started" / "avatar.speak_started" / "avatar.speak_ended"
 *   - Methods: start(), stop(), attach(el), interrupt(), message(text)
 *   - Microphone: session.voiceChat.mute() / unmute(); the local mic track is
 *     published by the SDK's configureSession() ONLY when the constructor
 *     received a truthy `voiceChat` config.
 *
 * Tests verify:
 *   - start() passes a CONVERSATIONAL, unmuted voiceChat config to the SDK
 *   - attach() is deferred to "session.stream_ready", not called eagerly
 *   - barge-in: "user.speak_started" while the avatar speaks → interrupt()
 *   - completion is deferred to "avatar.speak_ended" when the avatar is mid-sentence
 *   - "session.disconnected" for a non-client reason → 'error'
 *   - "avatar.transcription" SDK event fires the 'transcript' event with role 'avatar'
 *   - "user.transcription" SDK event fires the 'transcript' event with role 'user'
 *   - matchesEndPhrase match on avatar transcript → 'state' 'complete' emitted
 *   - Absent endPhrase → 'error' emitted before SDK init; state never reaches 'connecting'
 *   - Absent finalPhrase → same error path
 *   - stop() → 'state' 'stopped' emitted; SDK stop() called
 *   - toggleMic() → voiceChat.mute() / unmute() called
 *   - SSR path: when sdkLoader throws (mimics SSR guard), provider emits 'error'
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HeyGenProvider } from '~/app/providers/heygen'

// ---- Mock SDK session factory ----
// This pattern replaces vi.mock + dynamic-import complexities.
// We inject a mock sdkLoader directly into the HeyGenProvider constructor.
// The mock matches the REAL LiveAvatarSession API shape.

interface MockVoiceChat {
  mute: ReturnType<typeof vi.fn>
  unmute: ReturnType<typeof vi.fn>
  isMuted: boolean
}

interface MockSession {
  on: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  attach: ReturnType<typeof vi.fn>
  interrupt: ReturnType<typeof vi.fn>
  message: ReturnType<typeof vi.fn>
  voiceChat: MockVoiceChat
  // Internal helper to simulate SDK emitting an event
  _emit: (eventName: string, data: unknown) => void
}

function createMockSession(): MockSession {
  const handlers = new Map<string, ((data: unknown) => void)[]>()

  const voiceChat: MockVoiceChat = {
    isMuted: false,
    mute: vi.fn(async () => {
      voiceChat.isMuted = true
    }),
    unmute: vi.fn(async () => {
      voiceChat.isMuted = false
    }),
  }

  const session: MockSession = {
    on: vi.fn((event: string, cb: (data: unknown) => void) => {
      const list = handlers.get(event) ?? []
      handlers.set(event, [...list, cb])
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    attach: vi.fn(),
    interrupt: vi.fn(),
    message: vi.fn().mockReturnValue(''),
    voiceChat,
    _emit: (eventName: string, data: unknown) => {
      for (const cb of handlers.get(eventName) ?? []) {
        cb(data)
      }
    },
  }
  return session
}

/** A <video> the provider is allowed to attach to (attach() requires HTMLMediaElement). */
function makeMountEl(): HTMLVideoElement {
  const el = document.createElement('video')
  // jsdom has no media pipeline; play() is called on stream-ready and must not reject loudly.
  el.play = vi.fn().mockResolvedValue(undefined)
  return el
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
    // `loader` is called as (token, sessionConfig) — the second argument is what
    // decides whether the SDK ever publishes the candidate's microphone.
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

  it('calls SDK start() on start()', async () => {
    const { provider } = makeProvider()

    await provider.start(makeMountEl(), { dbSessionId: 1, ...PHRASES })

    expect(mockSession.start).toHaveBeenCalledOnce()
  })

  // ---- Microphone publication (the defect that made the avatar deaf) ----

  it('constructs the SDK session with a CONVERSATIONAL, unmuted voiceChat config', async () => {
    // The SDK's configureSession() publishes the local microphone track ONLY when
    // `config.voiceChat` is truthy. Constructing the session with no config at all
    // means the candidate's audio never leaves the browser: they speak, and the
    // avatar hears nothing. CONVERSATIONAL selects hands-free VAD turn-taking
    // rather than push-to-talk.
    const { provider, loader } = makeProvider()

    await provider.start(makeMountEl(), { dbSessionId: 1, ...PHRASES })

    expect(loader).toHaveBeenCalledOnce()
    const sessionConfig = loader.mock.calls[0]![1] as {
      voiceChat?: { mode?: string; defaultMuted?: boolean }
    }
    expect(sessionConfig?.voiceChat).toBeDefined()
    expect(sessionConfig.voiceChat!.mode).toBe('CONVERSATIONAL')
    expect(sessionConfig.voiceChat!.defaultMuted).toBe(false)
  })

  it('forwards the candidate-selected microphone deviceId to the SDK when supplied', async () => {
    // The candidate picks a microphone in the device-check step. Without threading
    // that choice through, the SDK silently opens the OS default device instead.
    const { provider, loader } = makeProvider()

    await provider.start(makeMountEl(), { dbSessionId: 1, ...PHRASES, audioDeviceId: 'mic-42' })

    const sessionConfig = loader.mock.calls[0]![1] as { voiceChat?: { deviceId?: string } }
    expect(sessionConfig.voiceChat!.deviceId).toBe('mic-42')
  })

  // ---- Stream attach timing ----

  it('attaches the media element on "session.stream_ready", not eagerly after start()', async () => {
    // attach() binds the avatar's video+audio tracks to the element. Calling it the
    // instant start() resolves races the tracks actually existing; the SDK signals
    // readiness with its own event.
    const { provider } = makeProvider()
    const el = makeMountEl()

    await provider.start(el, { dbSessionId: 1, ...PHRASES })
    expect(mockSession.attach).not.toHaveBeenCalled()

    mockSession._emit('session.stream_ready', undefined)

    expect(mockSession.attach).toHaveBeenCalledWith(el)
  })

  // ---- Turn-taking / barge-in ----

  it('interrupts the avatar when the candidate starts speaking over it', async () => {
    const { provider } = makeProvider()
    await provider.start(makeMountEl(), { dbSessionId: 1, ...PHRASES })

    mockSession._emit('avatar.speak_started', undefined)
    mockSession._emit('user.speak_started', undefined)

    expect(mockSession.interrupt).toHaveBeenCalledOnce()
    expect(emittedStates).toContain('listening')
  })

  it('does NOT interrupt when the candidate speaks while the avatar is silent', async () => {
    const { provider } = makeProvider()
    await provider.start(makeMountEl(), { dbSessionId: 1, ...PHRASES })

    mockSession._emit('user.speak_started', undefined)

    expect(mockSession.interrupt).not.toHaveBeenCalled()
  })

  it('emits state speaking on "avatar.speak_started"', async () => {
    const { provider } = makeProvider()
    await provider.start(makeMountEl(), { dbSessionId: 1, ...PHRASES })

    mockSession._emit('avatar.speak_started', undefined)

    expect(emittedStates).toContain('speaking')
  })

  // ---- Deferred completion ----

  it('defers complete to "avatar.speak_ended" when the end phrase arrives mid-sentence', async () => {
    // Transcription lands while the avatar is still talking. Ending the question
    // there cuts the closing sentence off in the candidate's ear.
    const { provider } = makeProvider()
    await provider.start(makeMountEl(), { dbSessionId: 1, ...PHRASES })

    mockSession._emit('avatar.speak_started', undefined)
    mockSession._emit('avatar.transcription', { text: PHRASES.endPhrase })

    expect(emittedStates).not.toContain('complete')

    mockSession._emit('avatar.speak_ended', undefined)

    expect(emittedStates).toContain('complete')
  })

  // ---- Disconnection ----

  it('emits error when the session disconnects for a non-client reason', async () => {
    const { provider } = makeProvider()
    await provider.start(makeMountEl(), { dbSessionId: 1, ...PHRASES })

    mockSession._emit('session.disconnected', 'SERVER_INITIATED')

    expect(emittedErrors.length).toBeGreaterThan(0)
    const err = emittedErrors[0] as { code: string }
    expect(err.code).toBe('disconnected')
  })

  it('emits stopped — not error — when the disconnect was client-initiated', async () => {
    const { provider } = makeProvider()
    await provider.start(makeMountEl(), { dbSessionId: 1, ...PHRASES })

    mockSession._emit('session.disconnected', 'CLIENT_INITIATED')

    expect(emittedErrors).toHaveLength(0)
    expect(emittedStates).toContain('stopped')
  })

  // ---- Transcript events ----

  it('fires transcript event with role "avatar" on "avatar.transcription" SDK event', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    mockSession._emit('avatar.transcription', { text: 'Buongiorno, iniziamo.' })

    expect(emittedTranscripts).toHaveLength(1)
    const entry = emittedTranscripts[0] as { role: string; text: string }
    expect(entry.role).toBe('avatar')
    expect(entry.text).toBe('Buongiorno, iniziamo.')
  })

  it('fires transcript event with role "user" on "user.transcription" SDK event', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    mockSession._emit('user.transcription', { text: 'Ciao.' })

    const entry = emittedTranscripts[0] as { role: string; text: string }
    expect(entry.role).toBe('user')
    expect(entry.text).toBe('Ciao.')
  })

  // ---- Completion detection ----

  it('emits state complete when avatar transcript matches endPhrase', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    mockSession._emit('avatar.transcription', { text: PHRASES.endPhrase })

    expect(emittedStates).toContain('complete')
  })

  it('emits state complete when avatar transcript matches finalPhrase', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    mockSession._emit('avatar.transcription', { text: PHRASES.finalPhrase })

    expect(emittedStates).toContain('complete')
  })

  it('does NOT emit complete for unrelated avatar transcript text', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    mockSession._emit('avatar.transcription', {
      text: 'Parliamo della tua esperienza professionale.',
    })

    expect(emittedStates).not.toContain('complete')
  })

  it('does NOT emit complete for user transcript matching the phrase', async () => {
    // Completion detection only applies to avatar.transcription events
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    mockSession._emit('user.transcription', { text: PHRASES.endPhrase })

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

  it('stop() emits state stopped and calls SDK stop()', async () => {
    const { provider } = makeProvider()
    const el = document.createElement('div')
    await provider.start(el, { dbSessionId: 1, ...PHRASES })

    await provider.stop()

    expect(emittedStates).toContain('stopped')
    expect(mockSession.stop).toHaveBeenCalledOnce()
  })

  it('stop() emits stopped even when called before start()', async () => {
    const { provider } = makeProvider()
    await provider.stop()
    expect(emittedStates).toContain('stopped')
    expect(mockSession.stop).not.toHaveBeenCalled()
  })

  // ---- toggleMic() ----

  // startListening()/stopListening() only publish an AVATAR_START_LISTENING command
  // event on the agent socket — they do NOT open or close the microphone. The mic
  // lives on session.voiceChat, and asking the wrong object left the local track
  // untouched no matter how many times the candidate pressed mute.

  it('toggleMic() mutes through voiceChat on the first toggle', async () => {
    const { provider } = makeProvider()
    await provider.start(makeMountEl(), { dbSessionId: 1, ...PHRASES })

    await provider.toggleMic()

    expect(mockSession.voiceChat.mute).toHaveBeenCalledOnce()
    expect(mockSession.voiceChat.isMuted).toBe(true)
  })

  it('toggleMic() unmutes through voiceChat on the second toggle', async () => {
    const { provider } = makeProvider()
    await provider.start(makeMountEl(), { dbSessionId: 1, ...PHRASES })

    await provider.toggleMic() // mute
    await provider.toggleMic() // unmute

    expect(mockSession.voiceChat.unmute).toHaveBeenCalledOnce()
    expect(mockSession.voiceChat.isMuted).toBe(false)
  })

  it('toggleMic() reads the live SDK mute state rather than a local mirror', async () => {
    // A provider-local `micMuted` boolean drifts the moment anything else mutes the
    // track (SDK-side mute, device loss), and the button then does the opposite of
    // what its label says.
    const { provider } = makeProvider()
    await provider.start(makeMountEl(), { dbSessionId: 1, ...PHRASES })

    mockSession.voiceChat.isMuted = true // muted out-of-band
    await provider.toggleMic()

    expect(mockSession.voiceChat.unmute).toHaveBeenCalledOnce()
    expect(mockSession.voiceChat.mute).not.toHaveBeenCalled()
  })

  it('toggleMic() does nothing before start()', async () => {
    const { provider } = makeProvider()
    await provider.toggleMic()
    expect(mockSession.voiceChat.mute).not.toHaveBeenCalled()
    expect(mockSession.voiceChat.unmute).not.toHaveBeenCalled()
  })

  // ---- nudgeWrapUp ----

  it('nudgeWrapUp(message) sends the CALLER-supplied text via session.message()', async () => {
    // The text is avatar speech, so it must come from i18n in the project language.
    // The provider has no i18n access and must never author or hardcode it.
    const { provider } = makeProvider()
    await provider.start(document.createElement('div'), { dbSessionId: 1, ...PHRASES })

    provider.nudgeWrapUp('Per favore, concludi la tua risposta.')

    expect(mockSession.message).toHaveBeenCalledWith('Per favore, concludi la tua risposta.')
  })

  it('nudgeWrapUp never sends an empty message', async () => {
    // `session.message('')` inside a swallowing try/catch did nothing at all while
    // reading as a working wrap-up nudge.
    const { provider } = makeProvider()
    await provider.start(document.createElement('div'), { dbSessionId: 1, ...PHRASES })

    provider.nudgeWrapUp('')

    expect(mockSession.message).not.toHaveBeenCalled()
  })

  it('nudgeWrapUp never sends a whitespace-only message', async () => {
    const { provider } = makeProvider()
    await provider.start(document.createElement('div'), { dbSessionId: 1, ...PHRASES })

    provider.nudgeWrapUp('   ')

    expect(mockSession.message).not.toHaveBeenCalled()
  })

  it('nudgeWrapUp does nothing before start()', () => {
    const { provider } = makeProvider()

    expect(() => provider.nudgeWrapUp('wrap up')).not.toThrow()
    expect(mockSession.message).not.toHaveBeenCalled()
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
