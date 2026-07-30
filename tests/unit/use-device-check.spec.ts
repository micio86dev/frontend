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

function makeLiveVideoTrack(): MediaStreamTrack {
  return {
    kind: 'video',
    readyState: 'live',
    stop: vi.fn(),
    enabled: true,
    label: 'camera',
  } as unknown as MediaStreamTrack
}

function makeAudioTrack(): MediaStreamTrack {
  return {
    kind: 'audio',
    readyState: 'live',
    stop: vi.fn(),
    enabled: true,
    label: 'microphone',
  } as unknown as MediaStreamTrack
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

  it('check() calls getUserMedia exactly once with video+audio constraints', async () => {
    const videoTrack = makeLiveVideoTrack()
    const audioTrack = makeAudioTrack()
    const stream = makeStream([videoTrack], [audioTrack])
    getUserMediaSpy.mockResolvedValue(stream)

    const { useDeviceCheck } = await import('~/app/composables/useDeviceCheck')
    const dc = useDeviceCheck()

    void dc.check()
    await Promise.resolve()

    expect(getUserMediaSpy).toHaveBeenCalledOnce()
    expect(getUserMediaSpy).toHaveBeenCalledWith({ video: true, audio: true })
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
})
