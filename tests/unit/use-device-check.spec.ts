/**
 * Task 4.5 RED — Unit tests for app/composables/useDeviceCheck
 *
 * Verifies:
 * - check() calls getUserMedia({ video: true, audio: true }) ONCE
 * - Camera confirmed (live video track) → cameraOk = true
 * - Microphone confirmed (audio above RMS threshold) → micOk = true
 * - getUserMedia throws NotFoundError → cameraOk = false; proceed disabled
 * - No video track in stream → cameraOk = false
 * - Both confirmed → stream is returned (to hand to useProctor.start(stream))
 * - getUserMedia NOT called a second time after check()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Stateful mock tracks: stop() flips readyState to 'ended', mirroring the real
// platform (Task 3.1 — "previous tracks readyState !== 'live' after switch").
function makeLiveVideoTrack(
  settings: Partial<{ deviceId: string; width: number; height: number }> = {}
): MediaStreamTrack {
  const track = {
    kind: 'video',
    readyState: 'live',
    enabled: true,
    label: 'camera',
    getSettings: () => ({ deviceId: 'default-cam', width: 1280, height: 720, ...settings }),
  } as unknown as MediaStreamTrack & { readyState: string }
  track.stop = vi.fn(() => {
    track.readyState = 'ended'
  })
  return track
}

function makeAudioTrack(settings: Partial<{ deviceId: string }> = {}): MediaStreamTrack {
  const track = {
    kind: 'audio',
    readyState: 'live',
    enabled: true,
    label: 'microphone',
    getSettings: () => ({ deviceId: 'default-mic', ...settings }),
  } as unknown as MediaStreamTrack & { readyState: string }
  track.stop = vi.fn(() => {
    track.readyState = 'ended'
  })
  return track
}

function makeStream(
  videoTracks: MediaStreamTrack[] = [],
  audioTracks: MediaStreamTrack[] = []
): MediaStream {
  return {
    getTracks: () => [...videoTracks, ...audioTracks],
    getVideoTracks: () => videoTracks,
    getAudioTracks: () => audioTracks,
  } as unknown as MediaStream
}

function makeAudioContext(highRms = false): AudioContext {
  const analyserNode: Partial<AnalyserNode> = {
    fftSize: 256,
    frequencyBinCount: 128,
    getByteTimeDomainData: vi.fn((arr: Uint8Array) => {
      // 128 = silence; 200 = above-threshold signal
      arr.fill(highRms ? 200 : 128)
    }),
    connect: vi.fn(),
  }
  return {
    createAnalyser: () => analyserNode as AnalyserNode,
    createMediaStreamSource: () => ({ connect: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AudioContext
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useDeviceCheck', () => {
  let getUserMediaSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()

    getUserMediaSpy = vi.fn()
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: getUserMediaSpy },
    })
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => makeAudioContext(false))
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  // -------------------------------------------------------------------------
  // Single getUserMedia call
  // -------------------------------------------------------------------------

  it('check() calls getUserMedia exactly once with the resolved default constraints', async () => {
    const videoTrack = makeLiveVideoTrack()
    const audioTrack = makeAudioTrack()
    const stream = makeStream([videoTrack], [audioTrack])
    getUserMediaSpy.mockResolvedValue(stream)

    const { useDeviceCheck, buildConstraints } = await import('~/app/composables/useDeviceCheck')
    const dc = useDeviceCheck()

    void dc.check()
    await Promise.resolve()

    expect(getUserMediaSpy).toHaveBeenCalledOnce()
    // Resolved-constraints shape (Task 2.1) — no preferred selection means the
    // unconstrained default, produced by the same pure function `check()` uses
    // internally to build a preferred-selection's constraints (Task 2.2).
    expect(getUserMediaSpy).toHaveBeenCalledWith(buildConstraints())
  })

  it('check(preferred) requests exact deviceId constraints for the given selection', async () => {
    const videoTrack = makeLiveVideoTrack()
    const audioTrack = makeAudioTrack()
    const stream = makeStream([videoTrack], [audioTrack])
    getUserMediaSpy.mockResolvedValue(stream)

    const { useDeviceCheck, buildConstraints } = await import('~/app/composables/useDeviceCheck')
    const dc = useDeviceCheck()

    await dc.check({ cameraId: 'cam-1', micId: 'mic-1' })

    expect(getUserMediaSpy).toHaveBeenCalledWith(
      buildConstraints({ cameraId: 'cam-1', micId: 'mic-1' })
    )
    expect(getUserMediaSpy).toHaveBeenCalledWith({
      video: { deviceId: { exact: 'cam-1' } },
      audio: { deviceId: { exact: 'mic-1' } },
    })
  })

  it('getUserMedia is NOT called a second time after check()', async () => {
    const stream = makeStream([makeLiveVideoTrack()], [makeAudioTrack()])
    getUserMediaSpy.mockResolvedValue(stream)

    const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
    const dc = useDeviceCheck()

    await dc.check()
    await dc.check() // second call should be no-op

    expect(getUserMediaSpy).toHaveBeenCalledOnce()
  })

  // -------------------------------------------------------------------------
  // Camera check
  // -------------------------------------------------------------------------

  it('live video track → cameraOk = true', async () => {
    const videoTrack = makeLiveVideoTrack()
    const stream = makeStream([videoTrack], [makeAudioTrack()])
    getUserMediaSpy.mockResolvedValue(stream)

    const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
    const dc = useDeviceCheck()
    await dc.check()

    expect(dc.cameraOk.value).toBe(true)
  })

  it('no video track in stream → cameraOk = false', async () => {
    // Stream with only audio track, no video
    const stream = makeStream([], [makeAudioTrack()])
    getUserMediaSpy.mockResolvedValue(stream)

    const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
    const dc = useDeviceCheck()
    await dc.check()

    expect(dc.cameraOk.value).toBe(false)
  })

  it('video track readyState not live → cameraOk = false', async () => {
    const endedTrack = {
      kind: 'video',
      readyState: 'ended',
      stop: vi.fn(),
      enabled: true,
      label: 'camera',
    } as unknown as MediaStreamTrack
    const stream = makeStream([endedTrack], [makeAudioTrack()])
    getUserMediaSpy.mockResolvedValue(stream)

    const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
    const dc = useDeviceCheck()
    await dc.check()

    expect(dc.cameraOk.value).toBe(false)
  })

  // -------------------------------------------------------------------------
  // getUserMedia error handling
  // -------------------------------------------------------------------------

  it('getUserMedia throws NotFoundError → cameraOk = false', async () => {
    const notFoundError = new DOMException('No device found', 'NotFoundError')
    getUserMediaSpy.mockRejectedValue(notFoundError)

    const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
    const dc = useDeviceCheck()
    await dc.check()

    expect(dc.cameraOk.value).toBe(false)
    expect(dc.stream.value).toBeNull()
  })

  it('getUserMedia throws NotAllowedError → cameraOk = false', async () => {
    const deniedError = new DOMException('Permission denied', 'NotAllowedError')
    getUserMediaSpy.mockRejectedValue(deniedError)

    const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
    const dc = useDeviceCheck()
    await dc.check()

    expect(dc.cameraOk.value).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Microphone check
  // -------------------------------------------------------------------------

  it('audio RMS above threshold → micOk = true', async () => {
    const videoTrack = makeLiveVideoTrack()
    const audioTrack = makeAudioTrack()
    const stream = makeStream([videoTrack], [audioTrack])
    getUserMediaSpy.mockResolvedValue(stream)

    // High-RMS AudioContext
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => makeAudioContext(true))
    )

    const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
    const dc = useDeviceCheck()
    await dc.check()

    // Advance the mic sampling interval to trigger RMS evaluation
    vi.advanceTimersByTime(500)
    await Promise.resolve()

    expect(dc.micOk.value).toBe(true)
  })

  it('audio RMS stays below threshold → micOk = false after timeout', async () => {
    const videoTrack = makeLiveVideoTrack()
    const audioTrack = makeAudioTrack()
    const stream = makeStream([videoTrack], [audioTrack])
    getUserMediaSpy.mockResolvedValue(stream)

    // Silence AudioContext
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => makeAudioContext(false))
    )

    const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
    const dc = useDeviceCheck()
    await dc.check()

    // Even after advancing time, mic never confirmed
    vi.advanceTimersByTime(5000)
    await Promise.resolve()

    expect(dc.micOk.value).toBe(false)
  })

  // -------------------------------------------------------------------------
  // stream returned
  // -------------------------------------------------------------------------

  it('both camera and mic confirmed → stream is the getUserMedia stream', async () => {
    const videoTrack = makeLiveVideoTrack()
    const audioTrack = makeAudioTrack()
    const stream = makeStream([videoTrack], [audioTrack])
    getUserMediaSpy.mockResolvedValue(stream)

    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => makeAudioContext(true))
    )

    const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
    const dc = useDeviceCheck()
    await dc.check()
    vi.advanceTimersByTime(500)
    await Promise.resolve()

    // Vue ref wraps objects in a reactive proxy so reference identity differs.
    // Verify stream is not null and has the same structure as the mock.
    expect(dc.stream.value).not.toBeNull()
    expect(dc.stream.value!.getVideoTracks()).toHaveLength(1)
    expect(dc.cameraOk.value).toBe(true)
    expect(dc.micOk.value).toBe(true)
  })

  it('AudioContext throws → mic check degraded, no crash (catch branch line 117)', async () => {
    const videoTrack = makeLiveVideoTrack()
    const audioTrack = makeAudioTrack()
    const stream = makeStream([videoTrack], [audioTrack])
    getUserMediaSpy.mockResolvedValue(stream)

    // AudioContext constructor throws
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => {
        throw new DOMException('Not supported', 'NotSupportedError')
      })
    )

    const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
    const dc = useDeviceCheck()

    await expect(dc.check()).resolves.not.toThrow()
    // micOk stays false — AudioContext unavailable
    expect(dc.micOk.value).toBe(false)
    // cameraOk should still work
    expect(dc.cameraOk.value).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Isolation
  // -------------------------------------------------------------------------

  it('returns a fresh isolated instance per call (no singleton state)', async () => {
    const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
    const dc1 = useDeviceCheck()
    const dc2 = useDeviceCheck()
    expect(dc1).not.toBe(dc2)
    expect(dc1.cameraOk).not.toBe(dc2.cameraOk)
  })

  // -------------------------------------------------------------------------
  // Retry after a failed check (permission denied → granted → retry)
  // -------------------------------------------------------------------------

  describe('retry after failure', () => {
    it('permission denied, then granted → a second check() re-runs getUserMedia and succeeds', async () => {
      // `checked = true` was set BEFORE getUserMedia and never reset, so the retry
      // button was a permanent dead end on the entry path to the product.
      const deniedError = new DOMException('Permission denied', 'NotAllowedError')
      getUserMediaSpy.mockRejectedValueOnce(deniedError)

      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()

      await dc.check()
      expect(dc.cameraOk.value).toBe(false)

      // Candidate grants the permission in browser settings and presses retry
      getUserMediaSpy.mockResolvedValueOnce(makeStream([makeLiveVideoTrack()], [makeAudioTrack()]))
      await dc.check()

      expect(getUserMediaSpy).toHaveBeenCalledTimes(2)
      expect(dc.cameraOk.value).toBe(true)
      expect(dc.stream.value).not.toBeNull()
    })

    it('no live video track → retryable, and the dead stream is released', async () => {
      const endedTrack = {
        kind: 'video',
        readyState: 'ended',
        stop: vi.fn(),
        enabled: true,
        label: 'camera',
      } as unknown as MediaStreamTrack
      const audioTrack = makeAudioTrack()
      getUserMediaSpy.mockResolvedValueOnce(makeStream([endedTrack], [audioTrack]))

      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()

      expect(dc.cameraOk.value).toBe(false)
      // Every track of the unusable stream is stopped — the camera light must not
      // stay on for the rest of the session.
      expect(endedTrack.stop).toHaveBeenCalled()
      expect(audioTrack.stop).toHaveBeenCalled()
      expect(dc.stream.value).toBeNull()

      getUserMediaSpy.mockResolvedValueOnce(makeStream([makeLiveVideoTrack()], [makeAudioTrack()]))
      await dc.check()

      expect(getUserMediaSpy).toHaveBeenCalledTimes(2)
      expect(dc.cameraOk.value).toBe(true)
    })

    it('a SUCCESSFUL check stays idempotent — no second getUserMedia', async () => {
      getUserMediaSpy.mockResolvedValue(makeStream([makeLiveVideoTrack()], [makeAudioTrack()]))

      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()

      await dc.check()
      await dc.check()
      await dc.check()

      expect(getUserMediaSpy).toHaveBeenCalledOnce()
    })

    it('concurrent check() calls share a single in-flight getUserMedia', async () => {
      getUserMediaSpy.mockResolvedValue(makeStream([makeLiveVideoTrack()], [makeAudioTrack()]))

      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()

      await Promise.all([dc.check(), dc.check(), dc.check()])

      expect(getUserMediaSpy).toHaveBeenCalledOnce()
    })
  })

  // -------------------------------------------------------------------------
  // Cleanup — the mic RMS interval used to run for the whole session
  // -------------------------------------------------------------------------

  describe('cleanup', () => {
    it('stopMicSampling() halts the RMS polling for a silent candidate', async () => {
      const audioContext = makeAudioContext(false)
      const analyser = audioContext.createAnalyser()
      const sampleSpy = analyser.getByteTimeDomainData as unknown as ReturnType<typeof vi.fn>
      vi.stubGlobal(
        'AudioContext',
        vi.fn(() => audioContext)
      )
      getUserMediaSpy.mockResolvedValue(makeStream([makeLiveVideoTrack()], [makeAudioTrack()]))

      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()

      vi.advanceTimersByTime(500)
      const callsWhilePolling = sampleSpy.mock.calls.length
      expect(callsWhilePolling).toBeGreaterThan(0)

      dc.stopMicSampling()
      vi.advanceTimersByTime(5000)

      // Threshold never crossed, so nothing else would ever have cleared the interval.
      expect(sampleSpy.mock.calls.length).toBe(callsWhilePolling)
    })

    it('stopMicSampling() does NOT stop the stream — ownership transfers to useProctor', async () => {
      const videoTrack = makeLiveVideoTrack()
      getUserMediaSpy.mockResolvedValue(makeStream([videoTrack], [makeAudioTrack()]))

      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()

      dc.stopMicSampling()

      expect(videoTrack.stop).not.toHaveBeenCalled()
      expect(dc.stream.value).not.toBeNull()
    })

    it('release() stops every track and resets the composable for a fresh check', async () => {
      const videoTrack = makeLiveVideoTrack()
      const audioTrack = makeAudioTrack()
      getUserMediaSpy.mockResolvedValueOnce(makeStream([videoTrack], [audioTrack]))

      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()
      expect(dc.cameraOk.value).toBe(true)

      dc.release()

      expect(videoTrack.stop).toHaveBeenCalled()
      expect(audioTrack.stop).toHaveBeenCalled()
      expect(dc.stream.value).toBeNull()
      expect(dc.cameraOk.value).toBe(false)

      getUserMediaSpy.mockResolvedValueOnce(makeStream([makeLiveVideoTrack()], [makeAudioTrack()]))
      await dc.check()
      expect(getUserMediaSpy).toHaveBeenCalledTimes(2)
    })
  })

  // -------------------------------------------------------------------------
  // Task 2.1/2.2 — pure functions (Extract-Before-Mock: no mocks needed)
  // -------------------------------------------------------------------------

  describe('buildConstraints (pure)', () => {
    it('no selection → unconstrained default', async () => {
      const { buildConstraints } = await import('~/app/composables/useDeviceCheck')
      expect(buildConstraints()).toEqual({ video: true, audio: true })
    })

    it('cameraId only → exact video constraint, unconstrained audio', async () => {
      const { buildConstraints } = await import('~/app/composables/useDeviceCheck')
      expect(buildConstraints({ cameraId: 'cam-1' })).toEqual({
        video: { deviceId: { exact: 'cam-1' } },
        audio: true,
      })
    })

    it('micId only → exact audio constraint, unconstrained video', async () => {
      const { buildConstraints } = await import('~/app/composables/useDeviceCheck')
      expect(buildConstraints({ micId: 'mic-1' })).toEqual({
        video: true,
        audio: { deviceId: { exact: 'mic-1' } },
      })
    })

    it('both ids → exact constraints on both tracks', async () => {
      const { buildConstraints } = await import('~/app/composables/useDeviceCheck')
      expect(buildConstraints({ cameraId: 'cam-1', micId: 'mic-1' })).toEqual({
        video: { deviceId: { exact: 'cam-1' } },
        audio: { deviceId: { exact: 'mic-1' } },
      })
    })
  })

  describe('classifyError (pure)', () => {
    it('NotAllowedError → denied', async () => {
      const { classifyError } = await import('~/app/composables/useDeviceCheck')
      expect(classifyError(new DOMException('x', 'NotAllowedError'))).toBe('denied')
    })

    it('SecurityError → denied', async () => {
      const { classifyError } = await import('~/app/composables/useDeviceCheck')
      expect(classifyError(new DOMException('x', 'SecurityError'))).toBe('denied')
    })

    it('NotFoundError → not_found', async () => {
      const { classifyError } = await import('~/app/composables/useDeviceCheck')
      expect(classifyError(new DOMException('x', 'NotFoundError'))).toBe('not_found')
    })

    it('DevicesNotFoundError → not_found', async () => {
      const { classifyError } = await import('~/app/composables/useDeviceCheck')
      expect(classifyError(new DOMException('x', 'DevicesNotFoundError'))).toBe('not_found')
    })

    it('NotReadableError → in_use', async () => {
      const { classifyError } = await import('~/app/composables/useDeviceCheck')
      expect(classifyError(new DOMException('x', 'NotReadableError'))).toBe('in_use')
    })

    it('TrackStartError → in_use', async () => {
      const { classifyError } = await import('~/app/composables/useDeviceCheck')
      expect(classifyError(new DOMException('x', 'TrackStartError'))).toBe('in_use')
    })

    it('OverconstrainedError → overconstrained', async () => {
      const { classifyError } = await import('~/app/composables/useDeviceCheck')
      expect(classifyError(new DOMException('x', 'OverconstrainedError'))).toBe('overconstrained')
    })

    it('an unrecognized DOMException name → unknown', async () => {
      const { classifyError } = await import('~/app/composables/useDeviceCheck')
      expect(classifyError(new DOMException('x', 'AbortError'))).toBe('unknown')
    })

    it('a non-Error value → unknown', async () => {
      const { classifyError } = await import('~/app/composables/useDeviceCheck')
      expect(classifyError('not an error')).toBe('unknown')
    })
  })

  describe('clampPreviewRatio (pure)', () => {
    it('a 16:9 ratio passes through unchanged', async () => {
      const { clampPreviewRatio } = await import('~/app/composables/useDeviceCheck')
      expect(clampPreviewRatio(16 / 9)).toBeCloseTo(16 / 9, 5)
    })

    it('a ratio below 3/4 (tall portrait) clamps to the 3/4 floor', async () => {
      const { clampPreviewRatio } = await import('~/app/composables/useDeviceCheck')
      expect(clampPreviewRatio(9 / 16)).toBeCloseTo(3 / 4, 5)
    })

    it('a ratio above 21/9 (ultra-wide) clamps to the 21/9 ceiling', async () => {
      const { clampPreviewRatio } = await import('~/app/composables/useDeviceCheck')
      expect(clampPreviewRatio(32 / 9)).toBeCloseTo(21 / 9, 5)
    })
  })

  describe('nextMicLevel (pure EMA)', () => {
    it('rising input uses the fast-attack coefficients (0.6/0.4)', async () => {
      const { nextMicLevel } = await import('~/app/composables/useDeviceCheck')
      // prev=0.1, raw=0.5 (rising) → 0.6*0.5 + 0.4*0.1 = 0.34
      expect(nextMicLevel(0.1, 0.5)).toBeCloseTo(0.34, 5)
    })

    it('falling input uses the slow-release coefficients (0.15/0.85)', async () => {
      const { nextMicLevel } = await import('~/app/composables/useDeviceCheck')
      // prev=0.5, raw=0.1 (falling) → 0.15*0.1 + 0.85*0.5 = 0.44
      expect(nextMicLevel(0.5, 0.1)).toBeCloseTo(0.44, 5)
    })

    it('equal input/prev takes the release branch and is a no-op', async () => {
      const { nextMicLevel } = await import('~/app/composables/useDeviceCheck')
      expect(nextMicLevel(0.3, 0.3)).toBeCloseTo(0.3, 5)
    })
  })

  // -------------------------------------------------------------------------
  // Task 2.2 — previewRatio seeded from getSettings()
  // -------------------------------------------------------------------------

  describe('previewRatio', () => {
    it('seeds previewRatio from the video track getSettings() width/height', async () => {
      const videoTrack = makeLiveVideoTrack({ width: 1920, height: 1080 })
      getUserMediaSpy.mockResolvedValue(makeStream([videoTrack], [makeAudioTrack()]))

      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()

      expect(dc.previewRatio.value).toBeCloseTo(1920 / 1080, 5)
    })

    it('clamps a portrait track ratio to the 3/4 floor', async () => {
      const videoTrack = makeLiveVideoTrack({ width: 480, height: 640 })
      getUserMediaSpy.mockResolvedValue(makeStream([videoTrack], [makeAudioTrack()]))

      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()

      expect(dc.previewRatio.value).toBeCloseTo(3 / 4, 5)
    })

    it('stays null when the camera check fails', async () => {
      getUserMediaSpy.mockRejectedValue(new DOMException('x', 'NotFoundError'))

      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()

      expect(dc.previewRatio.value).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Task 2.3 — error classification wired into check()
  // -------------------------------------------------------------------------

  describe('error classification wired into check()', () => {
    it('NotAllowedError rejection → error = denied', async () => {
      getUserMediaSpy.mockRejectedValue(new DOMException('x', 'NotAllowedError'))
      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()
      expect(dc.error.value).toBe('denied')
    })

    it('NotFoundError rejection → error = not_found', async () => {
      getUserMediaSpy.mockRejectedValue(new DOMException('x', 'NotFoundError'))
      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()
      expect(dc.error.value).toBe('not_found')
    })

    it('NotReadableError rejection → error = in_use', async () => {
      getUserMediaSpy.mockRejectedValue(new DOMException('x', 'NotReadableError'))
      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()
      expect(dc.error.value).toBe('in_use')
    })

    it('a successful check clears any previous error', async () => {
      getUserMediaSpy.mockRejectedValueOnce(new DOMException('x', 'NotAllowedError'))
      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()
      expect(dc.error.value).toBe('denied')

      getUserMediaSpy.mockResolvedValueOnce(makeStream([makeLiveVideoTrack()], [makeAudioTrack()]))
      await dc.check()
      expect(dc.error.value).toBeNull()
    })

    it('navigator.mediaDevices missing → error = unsupported, no getUserMedia call attempted', async () => {
      vi.stubGlobal('navigator', {})
      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()
      expect(dc.error.value).toBe('unsupported')
      expect(getUserMediaSpy).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Task 2.2/2.4 — micUnavailable (the mic-gate dead-end fix, D6)
  // -------------------------------------------------------------------------

  describe('micUnavailable', () => {
    it('no audio track in the acquired stream → micUnavailable = true, micOk stays false', async () => {
      const videoTrack = makeLiveVideoTrack()
      getUserMediaSpy.mockResolvedValue(makeStream([videoTrack], []))

      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()

      expect(dc.micUnavailable.value).toBe(true)
      expect(dc.micOk.value).toBe(false)
      // Camera still passed — the mic gate blocks continue, but it is not a
      // silent dead end: the flag is observable by the UI.
      expect(dc.cameraOk.value).toBe(true)
    })

    it('AudioContext throws → micUnavailable = true (not just a silent catch)', async () => {
      const videoTrack = makeLiveVideoTrack()
      const audioTrack = makeAudioTrack()
      getUserMediaSpy.mockResolvedValue(makeStream([videoTrack], [audioTrack]))
      vi.stubGlobal(
        'AudioContext',
        vi.fn(() => {
          throw new DOMException('Not supported', 'NotSupportedError')
        })
      )

      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()

      expect(dc.micUnavailable.value).toBe(true)
      expect(dc.micOk.value).toBe(false)
    })

    it('a working mic never sets micUnavailable', async () => {
      const videoTrack = makeLiveVideoTrack()
      const audioTrack = makeAudioTrack()
      getUserMediaSpy.mockResolvedValue(makeStream([videoTrack], [audioTrack]))

      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()

      expect(dc.micUnavailable.value).toBe(false)
    })

    it('release() then check() reopens a micUnavailable state (the dead-end fix)', async () => {
      // First attempt: no audio track at all.
      getUserMediaSpy.mockResolvedValueOnce(makeStream([makeLiveVideoTrack()], []))
      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()
      expect(dc.micUnavailable.value).toBe(true)

      // Candidate plugs in a mic and presses Retry (release() then check()).
      dc.release()
      expect(dc.micUnavailable.value).toBe(false)

      getUserMediaSpy.mockResolvedValueOnce(makeStream([makeLiveVideoTrack()], [makeAudioTrack()]))
      vi.stubGlobal(
        'AudioContext',
        vi.fn(() => makeAudioContext(true))
      )
      await dc.check()
      vi.advanceTimersByTime(500)
      await Promise.resolve()

      expect(dc.micUnavailable.value).toBe(false)
      expect(dc.micOk.value).toBe(true)
      expect(getUserMediaSpy).toHaveBeenCalledTimes(2)
    })
  })

  // -------------------------------------------------------------------------
  // Task 2.2 — micLevel EMA output, driven through the real sampling timer
  // -------------------------------------------------------------------------

  describe('micLevel (EMA-smoothed, sampled every 100ms)', () => {
    it('rises quickly on a loud sample, then settles slowly on silence', async () => {
      const videoTrack = makeLiveVideoTrack()
      const audioTrack = makeAudioTrack()
      getUserMediaSpy.mockResolvedValue(makeStream([videoTrack], [audioTrack]))

      // A mutable RMS source the AudioContext mock reads on every sample tick.
      let currentFill = 128 // silence
      const analyserNode: Partial<AnalyserNode> = {
        fftSize: 256,
        frequencyBinCount: 128,
        getByteTimeDomainData: vi.fn((arr: Uint8Array) => arr.fill(currentFill)),
        connect: vi.fn(),
      }
      vi.stubGlobal(
        'AudioContext',
        vi.fn(
          () =>
            ({
              createAnalyser: () => analyserNode as AnalyserNode,
              createMediaStreamSource: () => ({ connect: vi.fn() }),
              close: vi.fn().mockResolvedValue(undefined),
            }) as unknown as AudioContext
        )
      )

      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()

      expect(dc.micLevel.value).toBe(0)

      // Loud sample — fill=200 → raw RMS = |(200-128)/128| = 0.5625 on every
      // bin. Rising from 0 takes the fast-attack branch:
      // 0.6*0.5625 + 0.4*0 = 0.3375.
      currentFill = 200
      vi.advanceTimersByTime(100)
      await Promise.resolve()
      expect(dc.micLevel.value).toBeCloseTo(0.3375, 5)

      // Silence again — raw RMS = 0, falling, slow-release branch:
      // 0.15*0 + 0.85*0.3375 = 0.286875. Must NOT collapse to 0 in one tick —
      // that is the flicker the asymmetric EMA exists to prevent.
      currentFill = 128
      vi.advanceTimersByTime(100)
      await Promise.resolve()
      expect(dc.micLevel.value).toBeCloseTo(0.286875, 5)
    })
  })

  // -------------------------------------------------------------------------
  // Slice 4 (Task 4.3) — check()'s initial acquisition gains the same D4
  // fallback ladder as a switch: a stale cookie-sourced deviceId throws
  // OverconstrainedError, so drop BOTH pins and retry unconstrained once.
  // -------------------------------------------------------------------------

  describe('check(preferred) — OverconstrainedError fallback ladder (D4)', () => {
    it('OverconstrainedError on the preferred selection → retries unconstrained → succeeds', async () => {
      getUserMediaSpy.mockRejectedValueOnce(new DOMException('gone', 'OverconstrainedError'))
      const fallbackVideo = makeLiveVideoTrack({ deviceId: 'cam-fallback' })
      const fallbackAudio = makeAudioTrack({ deviceId: 'mic-fallback' })
      getUserMediaSpy.mockResolvedValueOnce(makeStream([fallbackVideo], [fallbackAudio]))

      const { useDeviceCheck, buildConstraints } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check({ cameraId: 'cam-gone', micId: 'mic-gone' })

      expect(getUserMediaSpy).toHaveBeenCalledTimes(2)
      expect(getUserMediaSpy).toHaveBeenNthCalledWith(
        1,
        buildConstraints({ cameraId: 'cam-gone', micId: 'mic-gone' })
      )
      expect(getUserMediaSpy).toHaveBeenNthCalledWith(2, buildConstraints())
      expect(dc.error.value).toBeNull()
      expect(dc.cameraOk.value).toBe(true)
      expect(dc.activeSelection.value).toEqual({ cameraId: 'cam-fallback', micId: 'mic-fallback' })
    })

    it('OverconstrainedError on both attempts → classified error, stays retryable', async () => {
      getUserMediaSpy.mockRejectedValueOnce(new DOMException('gone', 'OverconstrainedError'))
      getUserMediaSpy.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))

      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check({ cameraId: 'cam-gone' })

      expect(dc.error.value).toBe('denied')
      expect(dc.cameraOk.value).toBe(false)
      expect(dc.stream.value).toBeNull()
    })

    it('a non-overconstrained rejection on the FIRST attempt never retries (only one getUserMedia call)', async () => {
      getUserMediaSpy.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))

      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check({ cameraId: 'cam-1' })

      expect(getUserMediaSpy).toHaveBeenCalledOnce()
      expect(dc.error.value).toBe('denied')
    })
  })

  // -------------------------------------------------------------------------
  // Slice 3 (Tasks 3.1-3.5) — switchCamera/switchMicrophone, the highest-risk
  // code in the change (D3, D10). One-live-stream invariant: release-before-
  // replace + generation guard.
  // -------------------------------------------------------------------------

  describe('switchCamera / switchMicrophone — one-live-stream invariant (D3)', () => {
    async function checkedDeviceCheck(
      videoTrack = makeLiveVideoTrack({ deviceId: 'cam-0' }),
      audioTrack = makeAudioTrack({ deviceId: 'mic-0' })
    ) {
      getUserMediaSpy.mockResolvedValueOnce(makeStream([videoTrack], [audioTrack]))
      const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
      const dc = useDeviceCheck()
      await dc.check()
      return { dc, videoTrack, audioTrack }
    }

    it('Task 3.1 — stops every track of the previous stream before the replacement resolves', async () => {
      const { dc, videoTrack: oldVideo, audioTrack: oldAudio } = await checkedDeviceCheck()

      let resolveSwitch!: (s: MediaStream) => void
      const deferred = new Promise<MediaStream>((resolve) => {
        resolveSwitch = resolve
      })
      getUserMediaSpy.mockReturnValueOnce(deferred)

      const switchPromise = dc.switchCamera('cam-1')
      // BEFORE the replacement stream resolves, the old tracks must already be
      // stopped — release-before-replace is an ordering, not a race (D3).
      expect(oldVideo.readyState).not.toBe('live')
      expect(oldAudio.readyState).not.toBe('live')
      expect(oldVideo.stop).toHaveBeenCalled()
      expect(oldAudio.stop).toHaveBeenCalled()

      resolveSwitch(makeStream([makeLiveVideoTrack({ deviceId: 'cam-1' })], [makeAudioTrack()]))
      await switchPromise
    })

    it('Task 3.1 — the new stream becomes active and activeSelection reconciles to it', async () => {
      const { dc } = await checkedDeviceCheck()

      getUserMediaSpy.mockResolvedValueOnce(
        makeStream(
          [makeLiveVideoTrack({ deviceId: 'cam-1' })],
          [makeAudioTrack({ deviceId: 'mic-0' })]
        )
      )
      await dc.switchCamera('cam-1')

      expect(dc.activeSelection.value).toEqual({ cameraId: 'cam-1', micId: 'mic-0' })
      expect(dc.cameraOk.value).toBe(true)
      expect(dc.switching.value).toBe(false)
    })

    it('Task 3.1 — switchMicrophone preserves the current camera selection', async () => {
      const { dc } = await checkedDeviceCheck()

      getUserMediaSpy.mockResolvedValueOnce(
        makeStream(
          [makeLiveVideoTrack({ deviceId: 'cam-0' })],
          [makeAudioTrack({ deviceId: 'mic-1' })]
        )
      )
      await dc.switchMicrophone('mic-1')

      expect(getUserMediaSpy).toHaveBeenLastCalledWith({
        video: { deviceId: { exact: 'cam-0' } },
        audio: { deviceId: { exact: 'mic-1' } },
      })
      expect(dc.activeSelection.value).toEqual({ cameraId: 'cam-0', micId: 'mic-1' })
    })

    it('Task 3.2 — switch fails mid-flight: nothing hot, an actionable error surfaces, pickers stay usable', async () => {
      const { dc, videoTrack: oldVideo } = await checkedDeviceCheck()

      getUserMediaSpy.mockRejectedValueOnce(new DOMException('busy', 'NotReadableError'))
      await dc.switchCamera('cam-broken')

      // Nothing is left live: the old camera was already stopped, and the
      // failed replacement never became active.
      expect(oldVideo.readyState).not.toBe('live')
      expect(dc.stream.value).toBeNull()
      expect(dc.cameraOk.value).toBe(false)
      expect(dc.error.value).toBe('in_use')
      // switching resets to false so the pickers are usable again — the
      // candidate can pick a different device instead of being stuck.
      expect(dc.switching.value).toBe(false)
    })

    it('Task 3.3 — stale deviceId → OverconstrainedError → retries unconstrained → reconciles', async () => {
      const { dc } = await checkedDeviceCheck()

      getUserMediaSpy.mockRejectedValueOnce(new DOMException('gone', 'OverconstrainedError'))
      const fallbackVideo = makeLiveVideoTrack({ deviceId: 'cam-fallback' })
      const fallbackAudio = makeAudioTrack({ deviceId: 'mic-fallback' })
      getUserMediaSpy.mockResolvedValueOnce(makeStream([fallbackVideo], [fallbackAudio]))

      await dc.switchCamera('cam-unplugged')

      expect(getUserMediaSpy).toHaveBeenCalledTimes(3) // initial check() + failed switch + unconstrained retry
      expect(getUserMediaSpy).toHaveBeenLastCalledWith({ video: true, audio: true })
      expect(dc.error.value).toBeNull()
      expect(dc.cameraOk.value).toBe(true)
      // Reconciled to what was ACTUALLY obtained, not the stale requested id.
      expect(dc.activeSelection.value).toEqual({ cameraId: 'cam-fallback', micId: 'mic-fallback' })
    })

    it('Task 3.3 — OverconstrainedError on the unconstrained retry too → classified error, retryable', async () => {
      const { dc } = await checkedDeviceCheck()

      getUserMediaSpy.mockRejectedValueOnce(new DOMException('gone', 'OverconstrainedError'))
      getUserMediaSpy.mockRejectedValueOnce(new DOMException('still gone', 'NotFoundError'))

      await dc.switchCamera('cam-unplugged')

      expect(dc.error.value).toBe('not_found')
      expect(dc.cameraOk.value).toBe(false)
      expect(dc.switching.value).toBe(false)
    })

    it('Task 3.4 — two rapid switches: only the latest stream survives, the superseded one is stopped', async () => {
      const { dc } = await checkedDeviceCheck()

      const firstVideo = makeLiveVideoTrack({ deviceId: 'cam-1' })
      const firstAudio = makeAudioTrack({ deviceId: 'mic-0' })
      getUserMediaSpy.mockResolvedValueOnce(makeStream([firstVideo], [firstAudio]))

      const secondVideo = makeLiveVideoTrack({ deviceId: 'cam-2' })
      const secondAudio = makeAudioTrack({ deviceId: 'mic-0' })
      getUserMediaSpy.mockResolvedValueOnce(makeStream([secondVideo], [secondAudio]))

      // Fire both without awaiting the first — a rapid double-switch.
      const p1 = dc.switchCamera('cam-1')
      const p2 = dc.switchCamera('cam-2')
      await Promise.all([p1, p2])

      expect(dc.activeSelection.value.cameraId).toBe('cam-2')
      expect(dc.stream.value).not.toBeNull()
      expect(dc.stream.value!.getVideoTracks()[0]).toBe(secondVideo)
      // The intermediate (cam-1) stream never stays live — superseded, stopped.
      expect(firstVideo.readyState).not.toBe('live')
      expect(firstVideo.stop).toHaveBeenCalled()
    })

    it('Task 3.5 — release() during an in-flight switch stops the late-arriving stream and never activates it', async () => {
      const { dc } = await checkedDeviceCheck()

      let resolveSwitch!: (s: MediaStream) => void
      const deferred = new Promise<MediaStream>((resolve) => {
        resolveSwitch = resolve
      })
      getUserMediaSpy.mockReturnValueOnce(deferred)

      const switchPromise = dc.switchCamera('cam-1')

      // Unmount fires while the switch's getUserMedia is still pending.
      dc.release()
      expect(dc.stream.value).toBeNull()

      const lateVideo = makeLiveVideoTrack({ deviceId: 'cam-1' })
      const lateAudio = makeAudioTrack({ deviceId: 'mic-1' })
      resolveSwitch(makeStream([lateVideo], [lateAudio]))
      await switchPromise

      // The late-arriving stream must never become active — it is stopped on
      // arrival instead (the ONLY thing that stops a stream that did not exist
      // when release() ran).
      expect(dc.stream.value).toBeNull()
      expect(lateVideo.stop).toHaveBeenCalled()
      expect(lateAudio.stop).toHaveBeenCalled()
      expect(dc.activeSelection.value).toEqual({})
    })

    it('Task 3.7 — a switch never calls getUserMedia before the initial check() has completed', async () => {
      const { dc } = await checkedDeviceCheck()
      const callsAfterInitialCheck = getUserMediaSpy.mock.calls.length
      expect(callsAfterInitialCheck).toBe(1)

      getUserMediaSpy.mockResolvedValueOnce(makeStream([makeLiveVideoTrack()], [makeAudioTrack()]))
      await dc.switchCamera('cam-1')

      // The switch is a SEPARATE, explicit call — check()'s own single-acquisition
      // contract (Task 2.7 / spec.md clause (d)) is unaffected.
      expect(getUserMediaSpy).toHaveBeenCalledTimes(2)
    })
  })
})
