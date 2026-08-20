/**
 * useDeviceCheck — Pre-join camera and microphone device verification
 *
 * Opens a single getUserMedia stream, verifies:
 *   - Camera: at least one video track with readyState === 'live'
 *   - Microphone: audio RMS above MIC_SPEAK_THRESHOLD within a polling window
 *
 * The resolved stream is stored and handed to useProctor.start(stream) on confirmation.
 * NO second getUserMedia is ever opened before confirmation — this is the single-stream
 * handoff contract (spec.md clause (d)). After confirmation, switchCamera/switchMicrophone
 * (Slice 3) may re-acquire, but only while the picker is still enabled — never after
 * `confirmed` is emitted (A7).
 *
 * SSR invariant: all browser APIs (navigator.mediaDevices, AudioContext) are accessed
 * inside async function bodies, never at module scope.
 *
 * This is the ONLY module that calls getUserMedia and the ONLY owner of MediaStream
 * (design D-Technical-Approach). useMediaDeviceList (Slice 4) never touches a stream.
 *
 * Design refs: D1 (preview geometry), D2 (composable interfaces), D3 (switch invariant,
 * Slice 3), D4 (error classification / OverconstrainedError ladder — cookie-facing parts
 * live in useMediaDeviceList), D5 (mic level meter), D6 (mic check stays a hard gate; the
 * micUnavailable dead-end fix).
 */

import { ref, type Ref } from 'vue'

// ── Tunables ────────────────────────────────────────────────────────────────

/** RMS above this level (0–1) = "candidate has spoken" — mic confirmed OK.
 * Exported so the view can place the meter's threshold marker (D5) at the
 * SAME value the composable gates on, rather than duplicating the constant. */
export const MIC_SPEAK_THRESHOLD = 0.04

/** How often (ms) the mic RMS is sampled during the check window */
const MIC_SAMPLE_INTERVAL_MS = 100

/** Preview aspect-ratio clamp (D1) — a portrait camera letterboxes instead of
 * producing an overlong box; an ultra-wide camera is capped symmetrically. */
const PREVIEW_RATIO_MIN = 3 / 4
const PREVIEW_RATIO_MAX = 21 / 9

/** Asymmetric EMA coefficients (D5) — fast attack, slow release. */
const EMA_ATTACK_RAW = 0.6
const EMA_ATTACK_PREV = 0.4
const EMA_RELEASE_RAW = 0.15
const EMA_RELEASE_PREV = 0.85

// ── Public interface ────────────────────────────────────────────────────────

/** A candidate's camera/microphone pick, by deviceId. Either half may be omitted
 * to mean "no preference — use the platform default". */
export interface DeviceSelection {
  cameraId?: string | null
  micId?: string | null
}

/** Stable, provider-neutral classification of a getUserMedia failure (D2). */
export type DeviceCheckError =
  | 'denied' // NotAllowedError / SecurityError
  | 'not_found' // NotFoundError / DevicesNotFoundError
  | 'in_use' // NotReadableError / TrackStartError
  | 'overconstrained' // OverconstrainedError
  | 'unsupported' // navigator.mediaDevices absent
  | 'unknown'

export interface UseDeviceCheckReturn {
  /** Whether a live camera video track was detected */
  cameraOk: Ref<boolean>
  /** Whether the mic RMS crossed the speak threshold at least once */
  micOk: Ref<boolean>
  /** Smoothed RMS, 0–1 (raw sensor value; display scaling belongs to the view, D5) */
  micLevel: Ref<number>
  /** true when no audio track or AudioContext could be built — the mic gate cannot
   * pass by itself. Not a permanent dead end: release() then check() reopens it (D6). */
  micUnavailable: Ref<boolean>
  /** width/height ratio of the live video track, clamped to [3/4, 21/9]; null until
   * an acquisition has produced track geometry (D1). */
  previewRatio: Ref<number | null>
  /** deviceIds actually in use, read back from getSettings() after every acquisition */
  activeSelection: Ref<DeviceSelection>
  /** Stable classification of the last getUserMedia failure, or null */
  error: Ref<DeviceCheckError | null>
  /** true while a switchCamera/switchMicrophone call is in flight — the view
   * disables both pickers for the duration (D3). */
  switching: Ref<boolean>
  /** The getUserMedia stream — handed to useProctor.start(stream) on confirmation */
  stream: Ref<MediaStream | null>
  /**
   * Runs the device check.
   *
   * Idempotent while a check is in flight, and after one that SUCCEEDED. A check
   * that failed (permission denied, no device, no live video track) leaves the
   * composable retryable: the candidate grants the permission in browser settings
   * and presses retry. Latching on entry made that a permanent dead end on the
   * entry path to the product.
   *
   * `preferred` supplies a stored device selection (Slice 4); omitted or partial
   * fields fall back to the platform default for that kind.
   */
  check(preferred?: DeviceSelection): Promise<void>
  /**
   * Switches the active camera to `deviceId`, preserving the current microphone
   * selection. Release-before-replace + generation guard (D3) — the previous
   * stream is always fully stopped before the replacement is requested, so the
   * camera is never left hot and two live streams never coexist. Serialized with
   * any other in-flight switch on one promise chain: two getUserMedia calls from
   * this composable never overlap. Never called before `confirmed` is emitted, and
   * never after (A7) — that is enforced by the caller (the view), not here.
   */
  switchCamera(deviceId: string): Promise<void>
  /** Switches the active microphone to `deviceId`, preserving the current camera
   * selection. Same invariant as switchCamera(). */
  switchMicrophone(deviceId: string): Promise<void>
  /**
   * Stop the mic RMS polling interval. Safe to call at any time; does NOT touch the
   * stream, whose ownership transfers to useProctor on confirmation (D5).
   */
  stopMicSampling(): void
  /**
   * Stop mic polling AND stop every track of the acquired stream, resetting the
   * composable so `check()` can run again. Call ONLY when the stream was not handed
   * off — stopping a handed-off stream kills the proctoring feed.
   *
   * Also marks the composable disposed and bumps the switch generation, so a
   * switch that is still in flight when release() runs stops its late-arriving
   * stream on arrival instead of ever activating it (D3) — the only mechanism
   * that can stop a stream that did not exist yet when release() ran.
   */
  release(): void
}

// ── Pure helpers (Task 2.1/2.2 — extracted so they are directly unit-testable
// without a single mock; see tests/unit/use-device-check.spec.ts) ───────────

/** Builds the getUserMedia constraints for a device selection. No selection (or an
 * empty one) resolves to the unconstrained platform default, matching the historical
 * `{ video: true, audio: true }` shape. A present id pins that track with `exact`. */
export function buildConstraints(selection?: DeviceSelection): MediaStreamConstraints {
  return {
    video: selection?.cameraId ? { deviceId: { exact: selection.cameraId } } : true,
    audio: selection?.micId ? { deviceId: { exact: selection.micId } } : true,
  }
}

/** Classifies a getUserMedia rejection into a stable, provider-neutral reason. */
export function classifyError(err: unknown): DeviceCheckError {
  const name = err instanceof DOMException || err instanceof Error ? err.name : undefined
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'not_found'
    case 'NotReadableError':
    case 'TrackStartError':
      return 'in_use'
    case 'OverconstrainedError':
      return 'overconstrained'
    default:
      return 'unknown'
  }
}

/** Clamps a measured track aspect ratio into the supported preview range (D1). */
export function clampPreviewRatio(ratio: number): number {
  return Math.min(PREVIEW_RATIO_MAX, Math.max(PREVIEW_RATIO_MIN, ratio))
}

/** Asymmetric EMA step (D5): fast attack on a rising signal, slow release on a
 * falling one — responsive to speech onset, resistant to 100ms sample flicker. */
export function nextMicLevel(prev: number, raw: number): number {
  return raw > prev
    ? EMA_ATTACK_RAW * raw + EMA_ATTACK_PREV * prev
    : EMA_RELEASE_RAW * raw + EMA_RELEASE_PREV * prev
}

/**
 * A failed acquisition attempt, carrying the already-classified reason so every
 * caller can report the SAME classification `classifyError` would have
 * produced, without re-inspecting the raw platform error.
 */
export class DeviceAcquisitionError extends Error {
  constructor(public readonly reason: DeviceCheckError) {
    super(reason)
  }
}

function computeRms(buffer: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < buffer.length; i++) {
    const v = ((buffer[i] ?? 128) - 128) / 128
    sum += v * v
  }
  return Math.sqrt(sum / buffer.length)
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function useDeviceCheck(): UseDeviceCheckReturn {
  const cameraOk = ref(false)
  const micOk = ref(false)
  const micLevel = ref(0)
  const micUnavailable = ref(false)
  const previewRatio = ref<number | null>(null)
  const activeSelection = ref<DeviceSelection>({})
  const error = ref<DeviceCheckError | null>(null)
  const switching = ref(false)
  const stream = ref<MediaStream | null>(null)

  /** Set only after a check that actually produced a usable camera. */
  let succeeded = false
  /** The in-flight check, so concurrent calls share one getUserMedia. */
  let inFlight: Promise<void> | null = null

  /**
   * Bumped by check(), every switch attempt, and release(). A switch (or check)
   * whose captured generation no longer matches the current one when its
   * getUserMedia resolves has been superseded — its result is stopped on
   * arrival instead of becoming active (D3, "the crux").
   */
  let generation = 0
  /** Set true by release(); reset by the next check()/switch attempt. Guards a
   * switch already in flight when release() runs (Task 3.5's dedicated case). */
  let disposed = false
  /** Serializes switchCamera/switchMicrophone calls onto one promise chain, so
   * two getUserMedia calls from this composable never overlap (D3). */
  let switchChain: Promise<void> = Promise.resolve()

  // Internal state for mic polling (so it can be cleaned up if needed)
  let micSampleTimer: ReturnType<typeof setInterval> | null = null

  function stopMicSampling(): void {
    if (micSampleTimer != null) {
      clearInterval(micSampleTimer)
      micSampleTimer = null
    }
  }

  /** Starts RMS polling on `acquired`'s audio tracks. Sets micUnavailable
   * instead of throwing if there is no audio track or AudioContext fails to
   * construct — the D6 mic-gate dead-end fix, shared by check() and every
   * switch (a device switch reacquires an entirely new track, so mic state is
   * re-verified rather than carried over from the previous one). */
  function startMicSampler(acquired: MediaStream): void {
    const audioTracks = acquired.getAudioTracks()
    if (audioTracks.length === 0) {
      micUnavailable.value = true
      return
    }

    try {
      const audioCtx = new AudioContext()
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      audioCtx.createMediaStreamSource(acquired).connect(analyser)
      const buffer = new Uint8Array(analyser.frequencyBinCount)

      micSampleTimer = setInterval(() => {
        analyser.getByteTimeDomainData(buffer)
        const rms = computeRms(buffer)
        micLevel.value = nextMicLevel(micLevel.value, rms)

        if (rms > MIC_SPEAK_THRESHOLD) {
          micOk.value = true
          // Sampling keeps running (unlike the pre-Slice-2 code, which stopped here):
          // the live meter (D5) must keep reflecting the candidate's mic level for as
          // long as the device-check screen is open, not just until the first pass.
        }
      }, MIC_SAMPLE_INTERVAL_MS)
    } catch {
      // AudioContext unavailable — the other genuine dead end D6 closes:
      // previously the mic check silently degraded with no observable signal.
      micUnavailable.value = true
    }
  }

  function stopAllTracks(acquired: MediaStream | null): void {
    for (const track of acquired?.getTracks() ?? []) {
      track.stop()
    }
  }

  /**
   * getUserMedia with the D4 fallback ladder: a stale `exact` deviceId (the
   * device was unplugged between the pre-flight enumeration and this
   * acquisition — a real race, not the common case) throws
   * OverconstrainedError. Drop BOTH pins and retry once, unconstrained,
   * rather than the bare `catch {}` this composable shipped with originally.
   * Used by both the initial check() and every switchCamera/switchMicrophone
   * — same failure mode, same fix, one implementation.
   */
  async function acquireWithFallback(selection?: DeviceSelection): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia(buildConstraints(selection))
    } catch (err) {
      if (classifyError(err) !== 'overconstrained') {
        throw new DeviceAcquisitionError(classifyError(err))
      }
      try {
        return await navigator.mediaDevices.getUserMedia(buildConstraints())
      } catch (err2) {
        throw new DeviceAcquisitionError(classifyError(err2))
      }
    }
  }

  function release(): void {
    disposed = true
    generation++
    stopMicSampling()
    stopAllTracks(stream.value)
    stream.value = null
    cameraOk.value = false
    micOk.value = false
    micLevel.value = 0
    micUnavailable.value = false
    previewRatio.value = null
    activeSelection.value = {}
    error.value = null
    switching.value = false
    succeeded = false
  }

  function check(preferred?: DeviceSelection): Promise<void> {
    if (succeeded) return Promise.resolve()
    if (inFlight) return inFlight

    inFlight = runCheck(preferred).finally(() => {
      inFlight = null
    })
    return inFlight
  }

  async function runCheck(preferred?: DeviceSelection): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      error.value = 'unsupported'
      return
    }

    disposed = false
    generation++

    let acquired: MediaStream

    try {
      acquired = await acquireWithFallback(preferred)
    } catch (err) {
      // cameraOk and micOk stay false; stream stays null. `succeeded` stays false so
      // the candidate can grant the permission and retry.
      error.value = err instanceof DeviceAcquisitionError ? err.reason : 'unknown'
      return
    }

    error.value = null
    stream.value = acquired

    // ── Camera check ──────────────────────────────────────────────────────
    // A live video track is the only reliable proof the camera is working.
    const videoTracks = acquired.getVideoTracks()
    cameraOk.value = videoTracks.length > 0 && videoTracks.some((t) => t.readyState === 'live')

    if (!cameraOk.value) {
      // Nothing can be handed off, so release the tracks instead of leaving the
      // camera hot for the rest of the session, and stay retryable.
      release()
      return
    }

    succeeded = true

    // Seed previewRatio (D1) from the live track's reported geometry, in the same
    // synchronous step as the acquisition. Corrected later by loadedmetadata —
    // that correction is the view's job (it owns the <video> element).
    const primaryVideoTrack = videoTracks[0]
    const videoSettings = primaryVideoTrack?.getSettings?.()
    if (videoSettings?.width && videoSettings?.height) {
      previewRatio.value = clampPreviewRatio(videoSettings.width / videoSettings.height)
    }

    activeSelection.value = {
      cameraId: videoSettings?.deviceId ?? null,
      micId: acquired.getAudioTracks()[0]?.getSettings?.()?.deviceId ?? null,
    }

    // ── Microphone check (async, polling via AudioContext RMS) ─────────────
    // We reuse the audio tracks from the same acquired stream — no second getUserMedia.
    startMicSampler(acquired)
  }

  // ── Switching (Slice 3, D3 — "the crux") ────────────────────────────────

  function applyAcquiredStream(acquired: MediaStream): void {
    error.value = null
    stream.value = acquired

    const videoTracks = acquired.getVideoTracks()
    cameraOk.value = videoTracks.length > 0 && videoTracks.some((t) => t.readyState === 'live')

    const videoSettings = videoTracks[0]?.getSettings?.()
    if (videoSettings?.width && videoSettings?.height) {
      previewRatio.value = clampPreviewRatio(videoSettings.width / videoSettings.height)
    }

    activeSelection.value = {
      cameraId: videoSettings?.deviceId ?? null,
      micId: acquired.getAudioTracks()[0]?.getSettings?.()?.deviceId ?? null,
    }

    micOk.value = false
    micUnavailable.value = false
    startMicSampler(acquired)
  }

  /**
   * Acquisition attempt for `next` via the shared D4 fallback ladder
   * (acquireWithFallback), applied only if this attempt has not been
   * superseded by a later switch or a release(). Called ONLY through
   * queueSwitch(), never directly: the previous stream must already be
   * stopped and `gen` already captured by the SYNCHRONOUS prefix in
   * queueSwitch() before this (possibly queued, possibly deferred)
   * acquisition ever starts.
   */
  async function acquireForSwitch(gen: number, next: DeviceSelection): Promise<void> {
    let acquired: MediaStream
    try {
      acquired = await acquireWithFallback(next)
    } catch (err) {
      if (gen !== generation) return
      error.value = err instanceof DeviceAcquisitionError ? err.reason : 'unknown'
      cameraOk.value = false
      switching.value = false
      return
    }

    if (gen !== generation || disposed) {
      // Superseded by a later switch, or release() ran while this was in
      // flight — the only thing allowed to stop a stream that did not exist
      // when release() ran.
      stopAllTracks(acquired)
      return
    }

    applyAcquiredStream(acquired)
    switching.value = false
  }

  /**
   * Release-before-replace + generation guard (D3). The stop-old-stream step
   * and the generation bump run SYNCHRONOUSLY here, before any queueing or
   * await — "the camera light is off before the replacement is requested" is
   * an ordering, not a race, even under a rapid double-switch. Only the actual
   * getUserMedia call is deferred onto switchChain, so two such calls from
   * this composable never overlap.
   */
  function queueSwitch(next: DeviceSelection): Promise<void> {
    disposed = false
    const gen = ++generation
    switching.value = true

    stopMicSampling()
    stopAllTracks(stream.value) // camera light OFF before the replacement is requested
    stream.value = null
    previewRatio.value = null

    const run = switchChain.then(() => acquireForSwitch(gen, next))
    switchChain = run
    return run
  }

  function switchCamera(deviceId: string): Promise<void> {
    return queueSwitch({ cameraId: deviceId, micId: activeSelection.value.micId })
  }

  function switchMicrophone(deviceId: string): Promise<void> {
    return queueSwitch({ cameraId: activeSelection.value.cameraId, micId: deviceId })
  }

  return {
    cameraOk,
    micOk,
    micLevel,
    micUnavailable,
    previewRatio,
    activeSelection,
    error,
    switching,
    stream,
    check,
    switchCamera,
    switchMicrophone,
    stopMicSampling,
    release,
  }
}
