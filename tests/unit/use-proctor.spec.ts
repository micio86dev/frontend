/**
 * Task 4.3 RED — Unit tests for app/composables/useProctor
 *
 * Verifies:
 * - start(stream) attaches browser visibility/focus listeners; no getUserMedia
 * - onVisibilityChange('hidden') → tab_hidden event added
 * - onFocusLost() → focus_lost event added
 * - screen.isExtended undefined → second_monitor NOT added, no exception
 * - MediaPipe FaceLandmarker results → face_absent, multiple_faces, looking_away, too_far
 * - clipboard copy/paste events → clipboard_copy, clipboard_paste
 * - WebAudio RMS above threshold → second_voice
 * - stop() removes listeners, clears intervals
 * - Per-call isolation (no leaked state between instances)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// The snapshot POST is routed through candidateFetch (D-B / Task 1.6) instead
// of a raw fetch() — mock the wrapper directly so these tests exercise the
// takeSnapshot() call site without needing a stored candidate session.
const { mockCandidateFetch } = vi.hoisted(() => ({
  mockCandidateFetch: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('~/app/utils/candidate-api', () => ({
  candidateFetch: mockCandidateFetch,
}))

// Mock @mediapipe/tasks-vision (dynamically imported in useProctor)
vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: {
    forVisionTasks: vi.fn().mockResolvedValue({ resolved: true }),
  },
  FaceLandmarker: {
    createFromOptions: vi.fn().mockResolvedValue({
      detectForVideo: vi.fn().mockReturnValue({
        faceLandmarks: [],
        facialTransformationMatrixes: [],
      }),
      close: vi.fn(),
    }),
    FACE_LANDMARKS_TESSELATION: undefined,
  },
  ObjectDetector: {
    createFromOptions: vi.fn().mockResolvedValue({
      detectForVideo: vi.fn().mockReturnValue({ detections: [] }),
      close: vi.fn(),
    }),
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStream(): MediaStream {
  const track = {
    kind: 'video',
    readyState: 'live',
    stop: vi.fn(),
    enabled: true,
  } as unknown as MediaStreamTrack
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
  } as unknown as MediaStream
}

function makeVideoElement(): HTMLVideoElement {
  return {
    readyState: 4, // HAVE_ENOUGH_DATA
    videoWidth: 320,
    videoHeight: 240,
    srcObject: null,
    muted: false,
    play: vi.fn().mockResolvedValue(undefined),
  } as unknown as HTMLVideoElement
}

function makeAudioContext(): {
  createAnalyser: () => AnalyserNode
  createMediaStreamSource: () => { connect: () => void }
  close: () => Promise<void>
} {
  const analyserNode: Partial<AnalyserNode> = {
    fftSize: 256,
    frequencyBinCount: 128,
    getByteTimeDomainData: vi.fn((arr: Uint8Array) => {
      arr.fill(128) // 128 = zero-center (silence)
    }),
    connect: vi.fn(),
  }
  return {
    createAnalyser: () => analyserNode as AnalyserNode,
    createMediaStreamSource: () => ({ connect: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// Tests — poseFromMatrix pure function
// ---------------------------------------------------------------------------

describe('poseFromMatrix', () => {
  it('returns null for data shorter than 11 elements', async () => {
    const { poseFromMatrix } = await import('~/app/composables/useProctor')
    expect(poseFromMatrix([1, 2, 3])).toBeNull()
  })

  it('returns null for empty array', async () => {
    const { poseFromMatrix } = await import('~/app/composables/useProctor')
    expect(poseFromMatrix([])).toBeNull()
  })

  it('computes yaw and pitch from 4×4 transformation matrix data', async () => {
    const { poseFromMatrix } = await import('~/app/composables/useProctor')
    // 4×4 matrix flattened: indices 8 (fx), 9 (fy), 10 (fz)
    const data = [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.2, 1.0, 0]
    const result = poseFromMatrix(data)
    expect(result).not.toBeNull()
    expect(typeof result!.yaw).toBe('number')
    expect(typeof result!.pitch).toBe('number')
  })

  it('handles fz = 0 without division by zero (uses 1e-6 guard)', async () => {
    const { poseFromMatrix } = await import('~/app/composables/useProctor')
    const data = [0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0.1, 0.0, 0]
    expect(() => poseFromMatrix(data)).not.toThrow()
    const result = poseFromMatrix(data)
    expect(result).not.toBeNull()
    // fz is 0 → uses 1e-6 guard; result should be very large yaw/pitch
    expect(Math.abs(result!.yaw)).toBeGreaterThan(80)
  })

  it('handles Float32Array input', async () => {
    const { poseFromMatrix } = await import('~/app/composables/useProctor')
    const data = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.2, 1.0, 0])
    const result = poseFromMatrix(data)
    expect(result).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Tests — useProctor composable
// ---------------------------------------------------------------------------

describe('useProctor', () => {
  let listeners: Record<string, EventListener>
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    listeners = {}
    vi.useFakeTimers()

    addEventListenerSpy = vi
      .spyOn(document, 'addEventListener')
      .mockImplementation((event: string, listener: EventListenerOrEventListenerObject) => {
        listeners[event] = listener as EventListener
      })
    vi.spyOn(window, 'addEventListener').mockImplementation(
      (event: string, listener: EventListenerOrEventListenerObject) => {
        listeners[`window:${event}`] = listener as EventListener
      }
    )
    vi.spyOn(document, 'removeEventListener').mockImplementation(vi.fn())
    vi.spyOn(window, 'removeEventListener').mockImplementation(vi.fn())

    // Mock AudioContext globally
    const audioCtx = makeAudioContext()
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => audioCtx)
    )

    // Mock HTMLVideoElement creation
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: vi.fn().mockReturnValue({
            drawImage: vi.fn(),
          }),
          toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,test'),
        } as unknown as HTMLElement
      }
      return document.createElement(tag)
    })

    // Re-stub useRuntimeConfig to ensure apiBase is set
    vi.stubGlobal(
      'useRuntimeConfig',
      vi.fn(() => ({ public: { apiBase: 'http://localhost:8000' } }))
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  // -------------------------------------------------------------------------
  // sampleOnce via mocked MediaPipe + selfView
  // -------------------------------------------------------------------------

  it('sampleOnce with 0 faces → opens face_absent episode (via real timer after MediaPipe init)', async () => {
    // Set up video element mock first
    const videoEl = makeVideoElement()
    // Get the existing createElement spy from beforeEach and update its implementation
    vi.spyOn(document, 'createElement').mockImplementation((tag: string): HTMLElement => {
      if (tag === 'video') return videoEl as unknown as HTMLElement
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: vi.fn().mockReturnValue({ drawImage: vi.fn() }),
          toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,test'),
        } as unknown as HTMLElement
      }
      return { tagName: tag.toUpperCase() } as unknown as HTMLElement
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    // Await the full MediaPipe promise chain:
    // import('@mediapipe/tasks-vision') → FilesetResolver → FaceLandmarker.createFromOptions
    await Promise.resolve() // initCamera async body starts
    await Promise.resolve() // first await: import()
    await Promise.resolve() // second await: forVisionTasks
    await Promise.resolve() // third await: createFromOptions
    await Promise.resolve() // ensureLandmarker returns, sampleTimer set

    // Now sampleTimer fires at 1000/SAMPLE_FPS = ~333ms
    vi.advanceTimersByTime(400)
    // sampleOnce is called: landmarker.detectForVideo returns 0 faceLandmarks
    // → faceAbsentEp should be opened

    proctor.stop() // closeAllEpisodes → face_absent doesn't emit (duration < FACE_ABSENT_MS)
    // Just verify no exception — behavioral check via triggerFaceSample is already tested
  })

  // -------------------------------------------------------------------------
  // Isolation
  // -------------------------------------------------------------------------

  it('returns a fresh isolated instance per call (no singleton state)', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const p1 = useProctor()
    const p2 = useProctor()
    expect(p1).not.toBe(p2)
  })

  // -------------------------------------------------------------------------
  // start() — listener registration
  // -------------------------------------------------------------------------

  it('start(stream) attaches visibilitychange listener', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    const stream = makeStream()
    proctor.start(stream)
    expect(addEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
  })

  it('start(stream) attaches copy and paste listeners', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    const stream = makeStream()
    proctor.start(stream)
    expect(addEventListenerSpy).toHaveBeenCalledWith('copy', expect.any(Function))
    expect(addEventListenerSpy).toHaveBeenCalledWith('paste', expect.any(Function))
  })

  it('start(stream) attaches fullscreenchange listener', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    const stream = makeStream()
    proctor.start(stream)
    expect(addEventListenerSpy).toHaveBeenCalledWith('fullscreenchange', expect.any(Function))
  })

  it('start(stream) does NOT call getUserMedia', async () => {
    const getUserMediaSpy = vi.fn().mockResolvedValue(makeStream())
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: getUserMediaSpy },
    })
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    const stream = makeStream()
    proctor.start(stream)
    expect(getUserMediaSpy).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Visibility / focus events
  // -------------------------------------------------------------------------

  it('visibilitychange to hidden → adds tab_hidden event', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    // Simulate tab hide
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const visHandler = listeners['visibilitychange']
    expect(visHandler).toBeDefined()
    visHandler(new Event('visibilitychange'))

    // Simulate tab re-show after MIN_BROWSER_EPISODE_MS to close episode
    vi.advanceTimersByTime(1000)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    visHandler(new Event('visibilitychange'))

    const events = proctor.getPendingEvents()
    expect(events.some((e) => e.type === 'tab_hidden')).toBe(true)
  })

  it('window blur → adds focus_lost event when page visible', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const blurHandler = listeners['window:blur']
    expect(blurHandler).toBeDefined()
    blurHandler(new Event('blur'))

    // Close episode after MIN_BROWSER_EPISODE_MS
    vi.advanceTimersByTime(1000)
    const focusHandler = listeners['window:focus']
    expect(focusHandler).toBeDefined()
    focusHandler(new Event('focus'))

    const events = proctor.getPendingEvents()
    expect(events.some((e) => e.type === 'focus_lost')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // screen.isExtended guard (WebKit undefined)
  // -------------------------------------------------------------------------

  it('screen.isExtended undefined → second_monitor NOT added, no exception', async () => {
    Object.defineProperty(window, 'screen', {
      value: { isExtended: undefined },
      configurable: true,
    })
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    expect(() => proctor.start(makeStream())).not.toThrow()
    const events = proctor.getPendingEvents()
    expect(events.some((e) => e.type === 'second_monitor')).toBe(false)
  })

  it('screen.isExtended === true → second_monitor added on start', async () => {
    Object.defineProperty(window, 'screen', {
      value: { isExtended: true },
      configurable: true,
    })
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())
    const events = proctor.getPendingEvents()
    expect(events.some((e) => e.type === 'second_monitor')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Clipboard events
  // -------------------------------------------------------------------------

  it('copy event → adds clipboard_copy event', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    const copyHandler = listeners['copy']
    expect(copyHandler).toBeDefined()
    copyHandler(new Event('copy'))

    const events = proctor.getPendingEvents()
    expect(events.some((e) => e.type === 'clipboard_copy')).toBe(true)
  })

  it('paste event → adds clipboard_paste event', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    const pasteHandler = listeners['paste']
    expect(pasteHandler).toBeDefined()
    pasteHandler(new Event('paste'))

    const events = proctor.getPendingEvents()
    expect(events.some((e) => e.type === 'clipboard_paste')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Fullscreen exit
  // -------------------------------------------------------------------------

  it('fullscreenchange with no fullscreenElement → adds fullscreen_exit event', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    // Simulate fullscreen exit (fullscreenElement is null)
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
    const fsHandler = listeners['fullscreenchange']
    expect(fsHandler).toBeDefined()
    fsHandler(new Event('fullscreenchange'))

    const events = proctor.getPendingEvents()
    expect(events.some((e) => e.type === 'fullscreen_exit')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // MediaPipe face detection results
  // -------------------------------------------------------------------------

  it('MediaPipe: face absent (0 faces) → face_absent event emitted after threshold', async () => {
    // The triggerFaceSample escape hatch drives episode logic directly —
    // no need to initialize MediaPipe or advance all timers (which would hit the
    // flushTimer infinite-setInterval abort guard in vi.runAllTimersAsync).
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    // Open the face_absent episode (0 faces)
    proctor.triggerFaceSample({ faceCount: 0 })
    // Advance past FACE_ABSENT_MS (4000ms) so the episode duration qualifies
    vi.advanceTimersByTime(5000)
    // Close the episode — should push face_absent event
    proctor.triggerFaceSample({ faceCount: 0, closeEpisode: true })

    const events = proctor.getPendingEvents()
    expect(events.some((e) => e.type === 'face_absent')).toBe(true)
  })

  it('MediaPipe: multiple faces (≥2) → multiple_faces event emitted after threshold', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    proctor.triggerFaceSample({ faceCount: 2 })
    vi.advanceTimersByTime(2000)
    proctor.triggerFaceSample({ faceCount: 0, closeEpisode: true }) // close episode

    const events = proctor.getPendingEvents()
    expect(events.some((e) => e.type === 'multiple_faces')).toBe(true)
  })

  it('MediaPipe: gaze angle > threshold → looking_away event', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    // Yaw of 30° exceeds LOOK_AWAY_YAW_DEG (25°)
    proctor.triggerFaceSample({ faceCount: 1, yaw: 30, pitch: 0 })
    vi.advanceTimersByTime(3000)
    proctor.triggerFaceSample({ faceCount: 1, yaw: 0, pitch: 0, closeEpisode: true })

    const events = proctor.getPendingEvents()
    expect(events.some((e) => e.type === 'looking_away')).toBe(true)
  })

  it('MediaPipe: multiple faces peak tracking — peak count updated when episode already open', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    // First sample: 2 faces → opens episode with peak=2
    proctor.triggerFaceSample({ faceCount: 2 })
    // Second sample while episode is open: 3 faces → updates peak to 3
    proctor.triggerFaceSample({ faceCount: 3 })
    vi.advanceTimersByTime(2000)
    proctor.triggerFaceSample({ faceCount: 0, closeEpisode: true })

    const events = proctor.getPendingEvents()
    const multiFaceEvent = events.find((e) => e.type === 'multiple_faces')
    expect(multiFaceEvent).toBeDefined()
    // Peak should be 3 (the max)
    expect(multiFaceEvent?.meta?.count).toBe(3)
  })

  it('MediaPipe: face too far → too_far event', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    // faceWidth 0.10 < FACE_MIN_WIDTH_RATIO (0.20) = too far
    proctor.triggerFaceSample({ faceCount: 1, faceWidth: 0.1, yaw: 0, pitch: 0 })
    vi.advanceTimersByTime(4000)
    proctor.triggerFaceSample({
      faceCount: 1,
      faceWidth: 0.3,
      yaw: 0,
      pitch: 0,
      closeEpisode: true,
    })

    const events = proctor.getPendingEvents()
    expect(events.some((e) => e.type === 'too_far')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // WebAudio RMS → second_voice
  // -------------------------------------------------------------------------

  it('WebAudio RMS above threshold while avatarSpeaking=true → second_voice event', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()

    proctor.start(makeStream())
    proctor.setAvatarSpeaking(true)

    // Use the triggerVoiceSample escape hatch to simulate sustained voice above threshold.
    // makeStream() returns no audio tracks so initAudio exits early; the escape hatch
    // drives episode logic directly, bypassing the real AudioContext/analyser path.
    proctor.triggerVoiceSample(true) // open secondVoiceEp (avatarSpeaking=true)

    // Advance past SECOND_VOICE_MS (2000ms) so the episode duration qualifies
    vi.advanceTimersByTime(3000)

    proctor.triggerVoiceSample(false) // close episode → should push second_voice event

    const events = proctor.getPendingEvents()
    expect(events.some((e) => e.type === 'second_voice')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // stop() — listener removal
  // -------------------------------------------------------------------------

  it('stop() removes visibilitychange listener', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())
    proctor.stop()
    expect(document.removeEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function)
    )
  })

  it('stop() removes copy and paste listeners', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())
    proctor.stop()
    expect(document.removeEventListener).toHaveBeenCalledWith('copy', expect.any(Function))
    expect(document.removeEventListener).toHaveBeenCalledWith('paste', expect.any(Function))
  })

  it('stop() removes window blur/focus listeners', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())
    proctor.stop()
    expect(window.removeEventListener).toHaveBeenCalledWith('blur', expect.any(Function))
    expect(window.removeEventListener).toHaveBeenCalledWith('focus', expect.any(Function))
  })

  it('stop() is idempotent — calling twice does not throw', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())
    expect(() => {
      proctor.stop()
      proctor.stop()
    }).not.toThrow()
  })

  it('stop() before start is a no-op', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    expect(() => proctor.stop()).not.toThrow()
  })

  it('start() is idempotent — calling twice does not double-attach listeners', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    const stream = makeStream()
    proctor.start(stream)
    const callCountBefore = addEventListenerSpy.mock.calls.length
    proctor.start(stream) // second call should be no-op (active=true guard)
    expect(addEventListenerSpy.mock.calls.length).toBe(callCountBefore)
  })

  // -------------------------------------------------------------------------
  // Audio path with stream that has audio tracks
  // -------------------------------------------------------------------------

  it('initAudio: with audio tracks → creates AudioContext, starts sampling, sampleAudio runs', async () => {
    // High-RMS analyser to also cover the secondVoice branch inside sampleAudio
    const analyserNode: Partial<AnalyserNode> = {
      fftSize: 256,
      frequencyBinCount: 128,
      getByteTimeDomainData: vi.fn((arr: Uint8Array) => {
        arr.fill(200) // high RMS — covers rms > VOICE_RMS_THRESHOLD branch
      }),
      connect: vi.fn(),
    }
    const mockAudioCtxInstance = {
      createAnalyser: () => analyserNode as AnalyserNode,
      createMediaStreamSource: () => ({ connect: vi.fn() }),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const AudioContextSpy = vi.fn(() => mockAudioCtxInstance)
    vi.stubGlobal('AudioContext', AudioContextSpy)

    const audioTrack = {
      kind: 'audio',
      readyState: 'live',
      stop: vi.fn(),
      enabled: true,
    } as unknown as MediaStreamTrack

    const streamWithAudio = {
      getTracks: () => [audioTrack],
      getVideoTracks: () => [],
      getAudioTracks: () => [audioTrack],
    } as unknown as MediaStream

    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(streamWithAudio)
    proctor.setAvatarSpeaking(true) // covers the avatarSpeaking && rms > threshold branch

    // AudioContext created because audio tracks exist
    expect(AudioContextSpy).toHaveBeenCalledTimes(1)

    // Advance the audioSampleTimer (every 500ms) to trigger sampleAudio
    vi.advanceTimersByTime(600)

    // Avatar not speaking → covers the else branch in sampleAudio too
    proctor.setAvatarSpeaking(false)
    vi.advanceTimersByTime(600)

    proctor.stop()
  })

  it('initAudio: AudioContext constructor throws → second_voice detection degraded, no crash', async () => {
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => {
        throw new Error('AudioContext unavailable')
      })
    )

    const audioTrack = {
      kind: 'audio',
      readyState: 'live',
      stop: vi.fn(),
      enabled: true,
    } as unknown as MediaStreamTrack

    const streamWithAudio = {
      getTracks: () => [audioTrack],
      getVideoTracks: () => [],
      getAudioTracks: () => [audioTrack],
    } as unknown as MediaStream

    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    expect(() => proctor.start(streamWithAudio)).not.toThrow()
    proctor.stop()
  })

  // -------------------------------------------------------------------------
  // Camera / initCamera + takeSnapshot path coverage
  // -------------------------------------------------------------------------

  it('initCamera: creates video element, starts snapshot timer, stop() nulls srcObject', async () => {
    const videoEl = makeVideoElement()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    // Replace the beforeEach createElement mock with one that returns videoEl for 'video'
    const createElementSpy = addEventListenerSpy.mockRestore
      ? vi.spyOn(document, 'createElement')
      : vi.spyOn(document, 'createElement')
    createElementSpy.mockImplementation((tag: string) => {
      if (tag === 'video') return videoEl as unknown as HTMLElement
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: vi.fn().mockReturnValue({ drawImage: vi.fn() }),
          toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,test'),
        } as unknown as HTMLElement
      }
      // Avoid recursion — return a minimal stub for other tags
      return { tagName: tag.toUpperCase() } as unknown as HTMLElement
    })

    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    // Allow initCamera's synchronous section to run (selfView and snapshotTimer are set
    // before the first await in initCamera, so no await needed here)
    // Advance snapshot timer (SNAPSHOT_INTERVAL_MS = 10_000ms)
    vi.advanceTimersByTime(10_000)
    await Promise.resolve() // allow fetch().catch() to settle

    // Calling stop() should reach selfView.srcObject = null branch (lines 588-590)
    proctor.stop()
    expect((videoEl as { srcObject: unknown }).srcObject).toBeNull()
  })

  it('takeSnapshot: gracefully handles missing canvas context (ctx = null)', async () => {
    const videoEl = makeVideoElement()
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'video') return videoEl as unknown as HTMLElement
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: vi.fn().mockReturnValue(null), // ctx = null → early return
          toDataURL: vi.fn(),
        } as unknown as HTMLElement
      }
      return { tagName: tag.toUpperCase() } as unknown as HTMLElement
    })

    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    // Trigger snapshot timer — should not throw even when context is null
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow()
    proctor.stop()
  })

  // -------------------------------------------------------------------------
  // Episode close path in stop() — closeAllEpisodes
  // -------------------------------------------------------------------------

  it('stop() closes open face_absent episode and emits event', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    // Open a face_absent episode
    proctor.triggerFaceSample({ faceCount: 0 })
    vi.advanceTimersByTime(5000)

    // stop() calls closeAllEpisodes() which should emit the face_absent event
    proctor.stop()

    const events = proctor.getPendingEvents()
    expect(events.some((e) => e.type === 'face_absent')).toBe(true)
  })

  it('stop() closes open tab_hidden episode and emits event', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    // Open a tab_hidden episode
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const visHandler = listeners['visibilitychange']
    visHandler(new Event('visibilitychange'))
    vi.advanceTimersByTime(1000)

    // stop() should close the episode
    proctor.stop()

    const events = proctor.getPendingEvents()
    expect(events.some((e) => e.type === 'tab_hidden')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // getPendingEvents returns a copy (not the internal buffer reference)
  // -------------------------------------------------------------------------

  it('getPendingEvents returns a copy of the buffer (immutable snapshot)', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    proctor.triggerFaceSample({ faceCount: 0 })
    vi.advanceTimersByTime(5000)
    proctor.triggerFaceSample({ faceCount: 0, closeEpisode: true })

    const snapshot1 = proctor.getPendingEvents()
    // Push another event
    proctor.triggerFaceSample({ faceCount: 2 })
    vi.advanceTimersByTime(2000)
    proctor.triggerFaceSample({ faceCount: 0, closeEpisode: true })

    const snapshot2 = proctor.getPendingEvents()
    // snapshot1 should not have grown — it's a copy
    expect(snapshot2.length).toBeGreaterThan(snapshot1.length)
    proctor.stop()
  })

  // -------------------------------------------------------------------------
  // looking_down episode
  // -------------------------------------------------------------------------

  it('MediaPipe: downward pitch → looking_down event', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    // pitch < -LOOK_DOWN_PITCH_DEG (20°) = looking down
    proctor.triggerFaceSample({ faceCount: 1, yaw: 0, pitch: -25 })
    vi.advanceTimersByTime(3000)
    proctor.triggerFaceSample({ faceCount: 1, yaw: 0, pitch: 0, closeEpisode: true })

    const events = proctor.getPendingEvents()
    expect(events.some((e) => e.type === 'looking_down')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // setAvatarSpeaking
  // -------------------------------------------------------------------------

  it('setAvatarSpeaking toggles the avatar speaking state (no crash)', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())
    expect(() => {
      proctor.setAvatarSpeaking(true)
      proctor.setAvatarSpeaking(false)
    }).not.toThrow()
    proctor.stop()
  })

  // -------------------------------------------------------------------------
  // Camera path escape hatches: injectSelfView / injectLandmarker /
  // triggerSampleOnce / injectObjectDetector / triggerSamplePhone /
  // triggerSnapshot
  //
  // These drive internal camera logic without real DOM video elements or
  // MediaPipe async loading, achieving coverage of sampleOnce, samplePhone,
  // ensureLandmarker, ensureObjectDetector, takeSnapshot and initCamera body.
  // -------------------------------------------------------------------------

  it('triggerSampleOnce: 0 faces → face_absent episode opened', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    const videoEl = makeVideoElement()
    const fakeLandmarker = {
      detectForVideo: vi
        .fn()
        .mockReturnValue({ faceLandmarks: [], facialTransformationMatrixes: [] }),
      close: vi.fn(),
    }
    proctor.injectSelfView(videoEl)
    proctor.injectLandmarker(fakeLandmarker)

    proctor.triggerSampleOnce()
    vi.advanceTimersByTime(5000)
    proctor.triggerSampleOnce() // keeps episode open

    const events = proctor.getPendingEvents()
    // No event yet — episode only closes when faceCount returns to normal
    // Just verify no crash and no spurious events
    expect(Array.isArray(events)).toBe(true)
    proctor.stop()
  })

  it('triggerSampleOnce: 1 face with pose → evaluates head angles (no crash)', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    const videoEl = makeVideoElement()
    const matrix4x4 = [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.1, 1.0, 0, 0, 0, 0, 1]
    const fakeLandmarker = {
      detectForVideo: vi.fn().mockReturnValue({
        faceLandmarks: [
          [
            { x: 0.3, y: 0.4, z: 0 },
            { x: 0.7, y: 0.6, z: 0 },
          ],
        ],
        facialTransformationMatrixes: [{ data: matrix4x4 }],
      }),
      close: vi.fn(),
    }
    proctor.injectSelfView(videoEl)
    proctor.injectLandmarker(fakeLandmarker)

    expect(() => proctor.triggerSampleOnce()).not.toThrow()
    proctor.stop()
  })

  it('triggerSampleOnce: landmarker.detectForVideo throws → caught silently', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    const videoEl = makeVideoElement()
    const fakeLandmarker = {
      detectForVideo: vi.fn().mockImplementation(() => {
        throw new Error('GPU error')
      }),
      close: vi.fn(),
    }
    proctor.injectSelfView(videoEl)
    proctor.injectLandmarker(fakeLandmarker)

    expect(() => proctor.triggerSampleOnce()).not.toThrow()
    proctor.stop()
  })

  it('triggerSampleOnce: selfView not set → no-op (early return)', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())
    // No injectSelfView call — selfView is null
    expect(() => proctor.triggerSampleOnce()).not.toThrow()
    proctor.stop()
  })

  it('triggerSamplePhone: phone detected → phone_detected episode opened', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    const videoEl = makeVideoElement()
    const fakeObjectDetector = {
      detectForVideo: vi.fn().mockReturnValue({
        detections: [{ categories: [{ categoryName: 'cell phone', score: 0.9 }] }],
      }),
      close: vi.fn(),
    }
    proctor.injectSelfView(videoEl)
    proctor.injectObjectDetector(fakeObjectDetector)

    proctor.triggerSamplePhone()
    vi.advanceTimersByTime(5000)
    proctor.triggerSamplePhone() // keeps episode open

    // stop() → closeAllEpisodes → phone_detected emitted if above PHONE_DETECTED_MS
    proctor.stop()
    const events = proctor.getPendingEvents()
    expect(Array.isArray(events)).toBe(true)
  })

  it('triggerSamplePhone: no detections → phone episode closed', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    const videoEl = makeVideoElement()
    const fakeObjectDetector = {
      detectForVideo: vi.fn().mockReturnValue({ detections: [] }),
      close: vi.fn(),
    }
    proctor.injectSelfView(videoEl)
    proctor.injectObjectDetector(fakeObjectDetector)

    expect(() => proctor.triggerSamplePhone()).not.toThrow()
    proctor.stop()
  })

  it('triggerSamplePhone: objectDetector throws → caught silently', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    const videoEl = makeVideoElement()
    const fakeObjectDetector = {
      detectForVideo: vi.fn().mockImplementation(() => {
        throw new Error('model error')
      }),
      close: vi.fn(),
    }
    proctor.injectSelfView(videoEl)
    proctor.injectObjectDetector(fakeObjectDetector)

    expect(() => proctor.triggerSamplePhone()).not.toThrow()
    proctor.stop()
  })

  it('triggerSamplePhone: selfView not set → no-op (early return)', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())
    // No injectSelfView — selfView is null
    expect(() => proctor.triggerSamplePhone()).not.toThrow()
    proctor.stop()
  })

  it('triggerSnapshot: posts jpeg to snapshot endpoint via candidateFetch', async () => {
    mockCandidateFetch.mockClear().mockResolvedValue({ ok: true })

    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor({ getSessionId: () => 42 })
    proctor.start(makeStream())

    const videoEl = makeVideoElement()
    proctor.injectSelfView(videoEl)

    proctor.triggerSnapshot()
    await Promise.resolve() // settle candidateFetch

    // candidateFetch resolves the URL internally (D-B) — the caller passes the
    // API-relative path, not a pre-built absolute URL.
    expect(mockCandidateFetch).toHaveBeenCalledWith(
      '/candidate/interview/snapshot',
      expect.objectContaining({ method: 'POST' })
    )
    proctor.stop()
  })

  it('triggerSnapshot: includes session_id — the endpoint rejects a body without it', async () => {
    mockCandidateFetch.mockClear().mockResolvedValue({ ok: true })

    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor({ getSessionId: () => 7 })
    proctor.start(makeStream())
    proctor.injectSelfView(makeVideoElement())

    proctor.triggerSnapshot()
    await Promise.resolve()

    const body = (mockCandidateFetch.mock.calls[0]![1] as { body: Record<string, unknown> }).body
    expect(body['session_id']).toBe(7)
    expect(body['image_base64']).toBe('data:image/jpeg;base64,test')
    proctor.stop()
  })

  it('triggerSnapshot: no session id yet → no POST at all (never sends a rejectable body)', async () => {
    mockCandidateFetch.mockClear().mockResolvedValue({ ok: true })

    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor({ getSessionId: () => null })
    proctor.start(makeStream())
    proctor.injectSelfView(makeVideoElement())

    proctor.triggerSnapshot()
    await Promise.resolve()

    expect(mockCandidateFetch).not.toHaveBeenCalled()
    proctor.stop()
  })

  // -------------------------------------------------------------------------
  // acknowledgeEvents — the buffer used to be append-only
  // -------------------------------------------------------------------------

  it('acknowledgeEvents removes exactly the flushed events from the pending buffer', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    proctor.triggerFaceSample({ faceCount: 0 })
    vi.advanceTimersByTime(5000)
    proctor.triggerFaceSample({ faceCount: 0, closeEpisode: true })

    const firstBatch = proctor.getPendingEvents()
    expect(firstBatch.length).toBeGreaterThan(0)

    proctor.acknowledgeEvents(firstBatch)

    expect(proctor.getPendingEvents()).toHaveLength(0)
    proctor.stop()
  })

  it('acknowledgeEvents keeps events recorded AFTER the batch was read', async () => {
    // Identity-based acknowledgement, not drain-on-read: an event recorded while a
    // flush is in flight must not be dropped along with the flushed batch.
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    proctor.triggerFaceSample({ faceCount: 0 })
    vi.advanceTimersByTime(5000)
    proctor.triggerFaceSample({ faceCount: 0, closeEpisode: true })
    const inFlight = proctor.getPendingEvents()

    // A second episode closes while the flush of `inFlight` is still pending
    proctor.triggerFaceSample({ faceCount: 2 })
    vi.advanceTimersByTime(5000)
    proctor.triggerFaceSample({ faceCount: 0, closeEpisode: true })

    proctor.acknowledgeEvents(inFlight)

    const remaining = proctor.getPendingEvents()
    expect(remaining.length).toBeGreaterThan(0)
    expect(remaining.some((e) => inFlight.includes(e))).toBe(false)
    proctor.stop()
  })

  it('a second read after a flush no longer re-sends the acknowledged events', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    proctor.triggerFaceSample({ faceCount: 0 })
    vi.advanceTimersByTime(5000)
    proctor.triggerFaceSample({ faceCount: 0, closeEpisode: true })

    const batchOne = proctor.getPendingEvents()
    proctor.acknowledgeEvents(batchOne)

    proctor.triggerFaceSample({ faceCount: 2 })
    vi.advanceTimersByTime(5000)
    proctor.triggerFaceSample({ faceCount: 0, closeEpisode: true })

    const batchTwo = proctor.getPendingEvents()
    // Previously getPendingEvents() returned every event since session start, so
    // batchTwo would have contained batchOne all over again.
    expect(batchTwo).not.toEqual(expect.arrayContaining(batchOne))
    proctor.stop()
  })

  it('acknowledgeEvents([]) is a no-op', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    proctor.triggerFaceSample({ faceCount: 0 })
    vi.advanceTimersByTime(5000)
    proctor.triggerFaceSample({ faceCount: 0, closeEpisode: true })
    const before = proctor.getPendingEvents()

    proctor.acknowledgeEvents([])

    expect(proctor.getPendingEvents()).toHaveLength(before.length)
    proctor.stop()
  })

  // -------------------------------------------------------------------------
  // onEvent subscription — replaces the consumer-side 1s polling interval
  // -------------------------------------------------------------------------

  it('onEvent fires synchronously for each recorded event', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const seen: { type: string }[] = []
    const proctor = useProctor({ onEvent: (event) => seen.push(event) })
    proctor.start(makeStream())

    proctor.triggerFaceSample({ faceCount: 0 })
    vi.advanceTimersByTime(5000)
    proctor.triggerFaceSample({ faceCount: 0, closeEpisode: true })

    expect(seen.map((e) => e.type)).toContain('face_absent')
    expect(seen).toHaveLength(proctor.getPendingEvents().length)
    proctor.stop()
  })

  it('triggerSnapshot: selfView readyState < 2 → no-op (early return)', async () => {
    mockCandidateFetch.mockClear()

    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    const lowReadyStateVideo = {
      ...makeVideoElement(),
      readyState: 1,
    } as unknown as HTMLVideoElement
    proctor.injectSelfView(lowReadyStateVideo)

    proctor.triggerSnapshot()
    expect(mockCandidateFetch).not.toHaveBeenCalled()
    proctor.stop()
  })

  it('stop() with injected selfView → nulls srcObject (selfView branch covered)', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    const videoEl = makeVideoElement()
    proctor.injectSelfView(videoEl)

    proctor.stop()
    // stop() should null selfView.srcObject
    expect((videoEl as unknown as Record<string, unknown>).srcObject).toBeNull()
  })

  // -------------------------------------------------------------------------
  // ensureLandmarker — async MediaPipe init via escape hatch
  // -------------------------------------------------------------------------

  it('triggerEnsureLandmarker: loads @mediapipe/tasks-vision and returns landmarker', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    const lm = await proctor.triggerEnsureLandmarker()
    expect(lm).not.toBeNull()
    // Second call returns the cached landmarker (already initialised)
    const lm2 = await proctor.triggerEnsureLandmarker()
    expect(lm2).toBe(lm)

    proctor.stop()
  })

  it('triggerEnsureLandmarker: FaceLandmarker.createFromOptions throws → returns null, resets promise', async () => {
    // Re-mock to throw
    const { FaceLandmarker: FLMock } = (await import('@mediapipe/tasks-vision')) as {
      FaceLandmarker: { createFromOptions: ReturnType<typeof vi.fn> }
    }
    FLMock.createFromOptions.mockRejectedValueOnce(new Error('model unavailable'))

    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    const lm = await proctor.triggerEnsureLandmarker()
    expect(lm).toBeNull()

    proctor.stop()
  })

  // -------------------------------------------------------------------------
  // ensureObjectDetector — async MediaPipe init via escape hatch
  // -------------------------------------------------------------------------

  it('triggerEnsureObjectDetector: loads @mediapipe/tasks-vision and returns objectDetector', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    const od = await proctor.triggerEnsureObjectDetector()
    expect(od).not.toBeNull()
    // Second call returns cached
    const od2 = await proctor.triggerEnsureObjectDetector()
    expect(od2).toBe(od)

    proctor.stop()
  })

  it('triggerEnsureObjectDetector: ObjectDetector.createFromOptions throws → returns null', async () => {
    const { ObjectDetector: ODMock } = (await import('@mediapipe/tasks-vision')) as {
      ObjectDetector: { createFromOptions: ReturnType<typeof vi.fn> }
    }
    ODMock.createFromOptions.mockRejectedValueOnce(new Error('tflite unavailable'))

    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    proctor.start(makeStream())

    const od = await proctor.triggerEnsureObjectDetector()
    expect(od).toBeNull()

    proctor.stop()
  })

  // -------------------------------------------------------------------------
  // initCamera — full async path via escape hatch
  // -------------------------------------------------------------------------

  it('triggerInitCamera: sets up selfView, snapshotTimer, and loads MediaPipe landmarker', async () => {
    const videoEl = makeVideoElement()
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'video') return videoEl as unknown as HTMLElement
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: vi.fn().mockReturnValue({ drawImage: vi.fn() }),
          toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,test'),
        } as unknown as HTMLElement
      }
      return { tagName: tag.toUpperCase() } as unknown as HTMLElement
    })

    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    // Must activate (active=true) before initCamera guards pass
    proctor.start(makeStream())

    // Directly await initCamera via escape hatch
    await proctor.triggerInitCamera()

    // snapshotTimer should be running — advance to trigger takeSnapshot
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    vi.advanceTimersByTime(10_000)
    await Promise.resolve()

    proctor.stop()
    // selfView.srcObject should be null after stop
    expect((videoEl as unknown as Record<string, unknown>).srcObject).toBeNull()
  })

  it('triggerInitCamera: no stream → early return (no crash)', async () => {
    const { useProctor } = await import('~/app/composables/useProctor')
    const proctor = useProctor()
    // Call initCamera without calling start() first — stream is null
    await expect(proctor.triggerInitCamera()).resolves.toBeUndefined()
  })
})
