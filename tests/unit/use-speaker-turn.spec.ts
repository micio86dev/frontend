/**
 * useSpeakerTurn — who is speaking, from the provider's state plus audio level.
 *
 * One case per rule of design D4 (candidate-interview-call-ui). Time is faked
 * and so is the analyser: a level reader is injected, so each test says "the
 * avatar's audio is at 0.1 from now on" instead of building an audio graph.
 *
 * The signal is sampled on a fixed tick, so the assertions leave a tick of
 * slack on either side of every duration and never sit exactly on a boundary.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope, ref, shallowRef } from 'vue'
import {
  useSpeakerTurn,
  createAnalyserLevelReader,
  AVATAR_AUDIO_GATE,
  AVATAR_HOLD_MS,
  CANDIDATE_HOLD_MS,
  CANDIDATE_SUPPRESS_AFTER_AVATAR_MS,
  SPEAKER_SAMPLE_INTERVAL_MS,
  type LevelReader,
} from '~/app/composables/useSpeakerTurn'
import { MIC_SPEAK_THRESHOLD } from '~/app/composables/useDeviceCheck'
import type { SessionState } from '~/app/composables/useInterviewSession'
import type { ProviderState } from '~/app/types/interview-provider'

const AVATAR = { id: 'avatar' } as unknown as MediaStream
const MIC = { id: 'mic' } as unknown as MediaStream

const LOUD_AVATAR = AVATAR_AUDIO_GATE + 0.05
const LOUD_MIC = MIC_SPEAK_THRESHOLD + 0.05

const NON_LIVE_STATES: SessionState[] = [
  'idle',
  'device_check',
  'connecting',
  'end_of_question',
  'paused',
  'done',
  'error',
  'terminal',
]

function harness() {
  const levels = new Map<MediaStream, number>()
  const disposed = vi.fn()
  const createLevelReader = vi.fn((stream: MediaStream): LevelReader => ({
    read: () => levels.get(stream) ?? 0,
    dispose: disposed,
  }))

  const state = ref<SessionState>('live')
  const providerState = ref<ProviderState | null>(null)
  // shallowRef: a deep ref would hand the composable a reactive PROXY of the
  // stream, which is not the object the levels are keyed on.
  const avatarStream = shallowRef<MediaStream | null>(AVATAR)
  const micStream = shallowRef<MediaStream | null>(MIC)

  const scope = effectScope()
  const result = scope.run(() =>
    useSpeakerTurn({ state, providerState, avatarStream, micStream, createLevelReader })
  )!

  return {
    speaker: result.speaker,
    state,
    providerState,
    avatarStream,
    micStream,
    scope,
    createLevelReader,
    disposed,
    setAvatar: (level: number) => levels.set(AVATAR, level),
    setMic: (level: number) => levels.set(MIC, level),
    advance: (ms: number) => vi.advanceTimersByTime(ms),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('rule 1 — the avatar', () => {
  it('is none until something speaks', () => {
    const h = harness()
    h.advance(1000)

    expect(h.speaker.value).toBe('none')
  })

  it('lights on the provider `speaking` state alone, immediately, with no audio at all', () => {
    const h = harness()

    h.providerState.value = 'speaking'

    // No timer advanced: the provider event is the immediate path.
    expect(h.speaker.value).toBe('avatar')
  })

  it('lights on avatar audio held above the gate, with no provider event (the provider that never says speaking)', () => {
    const h = harness()
    h.setAvatar(LOUD_AVATAR)

    h.advance(SPEAKER_SAMPLE_INTERVAL_MS) // above the gate, but for less than 120 ms
    expect(h.speaker.value).toBe('none')

    h.advance(240)
    expect(h.speaker.value).toBe('avatar')
  })

  it('does not light on a blip shorter than 120 ms', () => {
    const h = harness()

    h.setAvatar(LOUD_AVATAR)
    h.advance(SPEAKER_SAMPLE_INTERVAL_MS)
    h.setAvatar(0)
    h.advance(1000)

    expect(h.speaker.value).toBe('none')
  })

  it('does not light on audio at or below the gate', () => {
    const h = harness()
    h.setAvatar(AVATAR_AUDIO_GATE)

    h.advance(2000)

    expect(h.speaker.value).toBe('none')
  })

  it('holds 600 ms after the audio stops, so a pause between words does not flicker', () => {
    const h = harness()
    h.setAvatar(LOUD_AVATAR)
    h.advance(500)
    expect(h.speaker.value).toBe('avatar')

    h.setAvatar(0)
    h.advance(AVATAR_HOLD_MS - 200) // well inside the hold
    expect(h.speaker.value).toBe('avatar')

    h.advance(AVATAR_HOLD_MS) // well past it
    expect(h.speaker.value).toBe('none')
  })

  it('holds 600 ms after the provider leaves `speaking`, then clears', () => {
    const h = harness()
    h.providerState.value = 'speaking'
    h.advance(500)

    h.providerState.value = 'ready'
    h.advance(AVATAR_HOLD_MS - 200)
    expect(h.speaker.value).toBe('avatar')

    h.advance(AVATAR_HOLD_MS)
    expect(h.speaker.value).toBe('none')
  })
})

describe('rule 2 — the candidate', () => {
  it('lights when the mic stays above MIC_SPEAK_THRESHOLD for 200 ms', () => {
    const h = harness()
    h.setMic(LOUD_MIC)

    h.advance(SPEAKER_SAMPLE_INTERVAL_MS) // above the threshold, but for less than 200 ms
    expect(h.speaker.value).toBe('none')

    h.advance(300)
    expect(h.speaker.value).toBe('candidate')
  })

  it('is gated at the shared threshold: a level AT it does not light', () => {
    const h = harness()
    h.setMic(MIC_SPEAK_THRESHOLD)

    h.advance(2000)

    expect(h.speaker.value).toBe('none')
  })

  it('does not light on a blip shorter than 200 ms', () => {
    const h = harness()

    h.setMic(LOUD_MIC)
    h.advance(SPEAKER_SAMPLE_INTERVAL_MS * 2)
    h.setMic(0)
    h.advance(2000)

    expect(h.speaker.value).toBe('none')
  })

  it('holds 800 ms after the level drops, then clears', () => {
    const h = harness()
    h.setMic(LOUD_MIC)
    h.advance(500)
    expect(h.speaker.value).toBe('candidate')

    h.setMic(0)
    h.advance(CANDIDATE_HOLD_MS - 200) // well inside the hold
    expect(h.speaker.value).toBe('candidate')

    h.advance(CANDIDATE_HOLD_MS) // well past it
    expect(h.speaker.value).toBe('none')
  })
})

describe('rule 2 — suppression while the avatar speaks and for 500 ms after', () => {
  it('never lights the candidate while the avatar is active, even with a loud mic (speaker echo)', () => {
    const h = harness()
    h.providerState.value = 'speaking'
    h.setMic(LOUD_MIC)

    h.advance(3000)

    expect(h.speaker.value).toBe('avatar')
  })

  it('keeps the candidate dark through the avatar hold and the 500 ms tail, then lights it', () => {
    const h = harness()
    h.providerState.value = 'speaking'
    h.setMic(LOUD_MIC) // the echo: the mic hears the avatar through the speakers
    h.advance(2000)

    h.providerState.value = 'ready'
    // Still loud. The avatar's own hold runs out first, and the tail follows it.
    h.advance(AVATAR_HOLD_MS + 100)
    expect(h.speaker.value).toBe('none')

    h.advance(CANDIDATE_SUPPRESS_AFTER_AVATAR_MS - 200)
    expect(h.speaker.value).toBe('none')

    // Past hold + tail + the 200 ms onset the loud mic now needs.
    h.advance(CANDIDATE_SUPPRESS_AFTER_AVATAR_MS + 300)
    expect(h.speaker.value).toBe('candidate')
  })

  it('starts the 200 ms onset after the tail, not during it', () => {
    const h = harness()
    h.providerState.value = 'speaking'
    h.setMic(LOUD_MIC)
    h.advance(1000)
    h.providerState.value = 'ready'
    h.advance(AVATAR_HOLD_MS + CANDIDATE_SUPPRESS_AFTER_AVATAR_MS - 200) // just before the tail ends

    // Had the onset been accumulating through the suppression, the next tick
    // after the tail would light the candidate straight away.
    h.advance(SPEAKER_SAMPLE_INTERVAL_MS * 3 + 100)
    expect(h.speaker.value).toBe('none')
  })

  it('drops a lit candidate the moment the avatar takes the turn', () => {
    const h = harness()
    h.setMic(LOUD_MIC)
    h.advance(500)
    expect(h.speaker.value).toBe('candidate')

    h.providerState.value = 'speaking'

    expect(h.speaker.value).toBe('avatar')
  })
})

describe('rule 3 — none outside `live`', () => {
  it.each(NON_LIVE_STATES)('is none in `%s`, whoever is speaking', (nonLive) => {
    const h = harness()
    h.state.value = nonLive
    h.providerState.value = 'speaking'
    h.setAvatar(LOUD_AVATAR)
    h.setMic(LOUD_MIC)

    h.advance(2000)

    expect(h.speaker.value).toBe('none')
  })

  it('goes none at once when the session leaves `live`, and restarts clean on return', () => {
    const h = harness()
    h.providerState.value = 'speaking'
    h.advance(500)
    expect(h.speaker.value).toBe('avatar')

    h.state.value = 'paused'
    expect(h.speaker.value).toBe('none')

    // Back to live with the provider no longer speaking: no stale hold survives the pause.
    h.providerState.value = 'ready'
    h.state.value = 'live'
    expect(h.speaker.value).toBe('none')
  })

  it('runs no timer and holds no analyser while the session is not `live`', () => {
    const h = harness()
    expect(vi.getTimerCount()).toBe(1)
    expect(h.createLevelReader).toHaveBeenCalledTimes(2)

    h.state.value = 'paused'

    expect(vi.getTimerCount()).toBe(0)
    expect(h.disposed).toHaveBeenCalledTimes(2)

    h.state.value = 'live'
    expect(vi.getTimerCount()).toBe(1)
    expect(h.createLevelReader).toHaveBeenCalledTimes(4)
  })

  it('never starts while the session is not `live` in the first place', () => {
    const state = ref<SessionState>('connecting')
    const createLevelReader = vi.fn()
    const scope = effectScope()
    scope.run(() =>
      useSpeakerTurn({
        state,
        providerState: ref<ProviderState | null>(null),
        avatarStream: shallowRef<MediaStream | null>(AVATAR),
        micStream: shallowRef<MediaStream | null>(MIC),
        createLevelReader,
      })
    )

    expect(vi.getTimerCount()).toBe(0)
    expect(createLevelReader).not.toHaveBeenCalled()
  })
})

describe('rule 4 — `speaking -> ready` does not end the turn while the audio gate is active', () => {
  it('keeps the avatar lit through the provider going `ready` while its audio is still above the gate', () => {
    const h = harness()
    h.providerState.value = 'speaking'
    h.setAvatar(LOUD_AVATAR)
    h.advance(1000)

    h.providerState.value = 'ready'
    expect(h.speaker.value).toBe('avatar') // not even for an instant

    // And never dips afterwards: the audio, not the hold, is what carries it.
    for (let tick = 0; tick < (AVATAR_HOLD_MS * 3) / SPEAKER_SAMPLE_INTERVAL_MS; tick += 1) {
      h.advance(SPEAKER_SAMPLE_INTERVAL_MS)
      expect(h.speaker.value).toBe('avatar')
    }
  })

  it('ends it once the audio stops too', () => {
    const h = harness()
    h.providerState.value = 'speaking'
    h.setAvatar(LOUD_AVATAR)
    h.advance(1000)
    h.providerState.value = 'ready'
    h.advance(1000)

    h.setAvatar(0)
    h.advance(AVATAR_HOLD_MS * 2)

    expect(h.speaker.value).toBe('none')
  })
})

describe('streams and lifecycle', () => {
  it('survives a missing analyser (no AudioContext): that input never fires, nothing throws', () => {
    const state = ref<SessionState>('live')
    const scope = effectScope()
    const { speaker } = scope.run(() =>
      useSpeakerTurn({
        state,
        providerState: ref<ProviderState | null>(null),
        avatarStream: shallowRef<MediaStream | null>(AVATAR),
        micStream: shallowRef<MediaStream | null>(MIC),
        createLevelReader: () => null,
      })
    )!

    vi.advanceTimersByTime(2000)

    expect(speaker.value).toBe('none')
  })

  it('builds the analysers when the streams arrive after the session is already live', () => {
    const h = harness()
    h.avatarStream.value = null
    h.micStream.value = null
    h.createLevelReader.mockClear()

    h.setAvatar(LOUD_AVATAR)
    h.advance(1000)
    expect(h.speaker.value).toBe('none') // nothing to listen to yet

    h.avatarStream.value = AVATAR
    h.advance(500)

    expect(h.createLevelReader).toHaveBeenCalledWith(AVATAR)
    expect(h.speaker.value).toBe('avatar')
  })

  it('stops the timer and disposes both analysers when its scope is stopped', () => {
    const h = harness()

    h.scope.stop()

    expect(vi.getTimerCount()).toBe(0)
    expect(h.disposed).toHaveBeenCalledTimes(2)
  })
})

describe('createAnalyserLevelReader — the default analyser', () => {
  function stubAudio(fill: number) {
    const sourceDisconnect = vi.fn()
    const analyserDisconnect = vi.fn()
    const close = vi.fn().mockResolvedValue(undefined)
    const connect = vi.fn()
    const AudioContextStub = vi.fn(() => ({
      resume: vi.fn().mockResolvedValue(undefined),
      close,
      createMediaStreamSource: vi.fn(() => ({ connect, disconnect: sourceDisconnect })),
      createAnalyser: vi.fn(() => ({
        fftSize: 0,
        frequencyBinCount: 512,
        disconnect: analyserDisconnect,
        getByteTimeDomainData: vi.fn((array: Uint8Array) => array.fill(fill)),
      })),
    }))
    vi.stubGlobal('AudioContext', AudioContextStub)

    return { close, connect, sourceDisconnect, analyserDisconnect }
  }

  it('reads the RMS of the time-domain samples on a 0..1 scale', () => {
    stubAudio(128 + 64) // +0.5 of full scale on every sample

    const reader = createAnalyserLevelReader(AVATAR)

    expect(reader).not.toBeNull()
    expect(reader!.read()).toBeCloseTo(0.5, 5)
  })

  it('reads silence as zero', () => {
    stubAudio(128)

    expect(createAnalyserLevelReader(AVATAR)!.read()).toBe(0)
  })

  it('taps the stream for analysis only, and closes the graph on dispose', () => {
    const { close, sourceDisconnect, analyserDisconnect, connect } = stubAudio(128)

    const reader = createAnalyserLevelReader(AVATAR)!

    // Connected to the analyser and to nothing else: routing it to a destination
    // would play the avatar a second time.
    expect(connect).toHaveBeenCalledTimes(1)

    reader.dispose()

    expect(sourceDisconnect).toHaveBeenCalled()
    expect(analyserDisconnect).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('is null when the platform has no AudioContext', () => {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', undefined)

    expect(createAnalyserLevelReader(AVATAR)).toBeNull()
  })

  it('is null when building the graph throws', () => {
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => {
        throw new Error('NotSupportedError')
      })
    )

    expect(createAnalyserLevelReader(AVATAR)).toBeNull()
  })
})
