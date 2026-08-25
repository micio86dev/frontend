/**
 * useProctor — 3-layer integrity collector composable (Task 4.4 GREEN)
 *
 * Collects soft-proctoring integrity signals during a live interview session.
 * Returns an isolated object per call — NO module-scope singletons.
 *
 * Layers:
 *   Layer 1 — Browser: visibilitychange, blur/focus, fullscreenchange, copy/paste
 *   Layer 2 — MediaPipe FaceLandmarker @SAMPLE_FPS: face presence, head pose, face count
 *   Layer 3 — WebAudio AnalyserNode RMS: second_voice detection
 *
 * Camera stream is passed in via start(stream) — this composable does NOT call
 * getUserMedia. The stream originates from useDeviceCheck (single getUserMedia rule, D5).
 *
 * MediaPipe is dynamically imported inside an async function guarded by import.meta.client.
 * NEVER import at module scope — SSR invariant (D3).
 *
 * Phone detection (phone_detected): uses ObjectDetector with efficientdet_lite0.tflite.
 * If the model file is unavailable or loading fails, phone detection degrades gracefully
 * (no exception thrown, session continues without phone detection).
 *
 * Design refs: D3 (composable returns object, SSR invariant), D7 (MediaPipe assets)
 */

import {
  FACE_ABSENT_MS,
  FACE_MIN_WIDTH_RATIO,
  LOOK_AWAY_MS,
  LOOK_AWAY_PITCH_DEG,
  LOOK_AWAY_YAW_DEG,
  LOOK_DOWN_PITCH_DEG,
  MULTI_FACE_MS,
  PHONE_DETECTED_MS,
  PHONE_SAMPLE_MS,
  PHONE_SCORE_THRESHOLD,
  SAMPLE_FPS,
  SECOND_VOICE_MS,
  SNAPSHOT_INTERVAL_MS,
  TOO_FAR_MS,
  VOICE_RMS_THRESHOLD,
  type IntegrityEventInternal,
  type IntegrityType,
} from '~/app/utils/proctor-config'
import { candidateFetch } from '~/app/utils/candidate-api'

// ---------------------------------------------------------------------------
// Minimal structural types for @mediapipe/tasks-vision (dynamically imported)
// ---------------------------------------------------------------------------

interface FaceLandmark {
  x: number
  y: number
  z: number
}
interface FaceResult {
  faceLandmarks: FaceLandmark[][]
  facialTransformationMatrixes?: { data: number[] | Float32Array }[]
}
interface FaceLandmarkerLike {
  detectForVideo(video: HTMLVideoElement, ts: number): FaceResult
  close(): void
}
interface PhoneDetectionResult {
  detections: Array<{ categories: Array<{ categoryName: string; score: number }> }>
}
interface ObjectDetectorLike {
  detectForVideo(video: HTMLVideoElement, ts: number): PhoneDetectionResult
  close(): void
}

// ---------------------------------------------------------------------------
// Open episode type
// ---------------------------------------------------------------------------

type Ep = { start: number; peak?: number } | null

// ---------------------------------------------------------------------------
// Constants from legacy (local to avoid re-export noise)
// ---------------------------------------------------------------------------

const MIN_BROWSER_EPISODE_MS = 500

// ---------------------------------------------------------------------------
// Head pose from transformation matrix (ported from legacy proctor.ts)
// Exported for unit testing — pure function, no side effects.
// ---------------------------------------------------------------------------

export function poseFromMatrix(
  data: number[] | Float32Array
): { yaw: number; pitch: number } | null {
  if (!data || data.length < 11) return null
  const fx = data[8]
  const fy = data[9]
  const fz = Math.abs(data[10] ?? 0) || 1e-6
  const yaw = (Math.atan2(fx!, fz) * 180) / Math.PI
  const pitch = (Math.atan2(fy!, fz) * 180) / Math.PI
  return { yaw, pitch }
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ProctoFaceSampleInput {
  faceCount: number
  yaw?: number
  pitch?: number
  faceWidth?: number
  closeEpisode?: boolean
}

export interface UseProctorOptions {
  /**
   * Supplies the DB session id for POST /snapshot. A getter, not a value: the id
   * changes between competencies. Returning null suppresses the POST — the endpoint
   * requires `session_id` and rejects the request without it.
   */
  getSessionId?: () => number | null
  /**
   * Called synchronously for each integrity event as it is recorded, so consumers
   * can react instead of polling getPendingEvents() on an interval.
   */
  onEvent?: (event: IntegrityEventInternal) => void
}

export interface UseProctorReturn {
  start(_stream: MediaStream): void
  stop(): void
  setAvatarSpeaking(_speaking: boolean): void
  /** Non-destructive read of the events awaiting flush. */
  getPendingEvents(): IntegrityEventInternal[]
  /**
   * Drop the given events from the pending buffer — call ONLY after they have been
   * successfully flushed. Matching is by object identity, so events recorded while a
   * flush was in flight are never dropped along with it.
   */
  acknowledgeEvents(_events: IntegrityEventInternal[]): void
  /** Test escape hatch: directly trigger face evaluation (bypasses timer/MediaPipe) */
  triggerFaceSample(_input: ProctoFaceSampleInput): void
  /** Test escape hatch: directly trigger voice RMS evaluation */
  triggerVoiceSample(_aboveThreshold: boolean): void
  /** Test escape hatch: inject a selfView video element directly (bypasses DOM/initCamera) */
  injectSelfView(_video: HTMLVideoElement): void
  /** Test escape hatch: inject a FaceLandmarker-like mock directly */
  injectLandmarker(_lm: {
    detectForVideo(_v: HTMLVideoElement, _ts: number): unknown
    close(): void
  }): void
  /** Test escape hatch: inject an ObjectDetector-like mock directly */
  injectObjectDetector(_od: {
    detectForVideo(_v: HTMLVideoElement, _ts: number): unknown
    close(): void
  }): void
  /** Test escape hatch: call sampleOnce() synchronously */
  triggerSampleOnce(): void
  /** Test escape hatch: call samplePhone() synchronously */
  triggerSamplePhone(): void
  /** Test escape hatch: call takeSnapshot() synchronously */
  triggerSnapshot(): void
  /** Test escape hatch: call initCamera() and return the async promise (for awaiting in tests) */
  triggerInitCamera(): Promise<void>
  /** Test escape hatch: call ensureLandmarker() and return the promise */
  triggerEnsureLandmarker(): Promise<unknown>
  /** Test escape hatch: call ensureObjectDetector() and return the promise */
  triggerEnsureObjectDetector(): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Composable factory
// ---------------------------------------------------------------------------

export function useProctor(options: UseProctorOptions = {}): UseProctorReturn {
  // Per-instance state (no module singletons)
  const buffer: IntegrityEventInternal[] = []
  let active = false
  let stream: MediaStream | null = null
  let selfView: HTMLVideoElement | null = null
  let avatarSpeaking = false

  // Episode trackers
  let hiddenEp: Ep = null
  let focusEp: Ep = null
  let faceAbsentEp: Ep = null
  let multiFaceEp: Ep = null
  let lookAwayEp: Ep = null
  let lookDownEp: Ep = null
  let tooFarEp: Ep = null
  let phoneEp: Ep = null
  let secondVoiceEp: Ep = null
  let lastPose: { yaw: number; pitch: number } | null = null

  // Timer handles
  let sampleTimer: ReturnType<typeof setInterval> | null = null
  let phoneSampleTimer: ReturnType<typeof setInterval> | null = null
  let snapshotTimer: ReturnType<typeof setInterval> | null = null
  let audioSampleTimer: ReturnType<typeof setInterval> | null = null

  // MediaPipe handles
  let landmarker: FaceLandmarkerLike | null = null
  let landmarkerPromise: Promise<FaceLandmarkerLike | null> | null = null
  let objectDetector: ObjectDetectorLike | null = null
  let objectDetectorPromise: Promise<ObjectDetectorLike | null> | null = null

  // Audio handles
  let audioCtx: AudioContext | null = null
  let analyserNode: AnalyserNode | null = null
  let audioDataArray: Uint8Array<ArrayBuffer> | null = null

  // Bound listener references (for removal)
  let onVisibilityBound: (() => void) | null = null
  let onBlurBound: (() => void) | null = null
  let onFocusBound: (() => void) | null = null
  let onFullscreenBound: (() => void) | null = null
  let onCopyBound: (() => void) | null = null
  let onPasteBound: (() => void) | null = null

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  function now(): number {
    return Date.now()
  }

  function push(type: IntegrityType, meta?: Record<string, unknown>): void {
    const event: IntegrityEventInternal = {
      type,
      ts: new Date().toISOString(),
      meta: meta ?? null,
    }
    buffer.push(event)
    options.onEvent?.(event)
  }

  function closeEpisode(
    ep: Ep,
    type: IntegrityType,
    minMs: number,
    extra?: Record<string, unknown>
  ): Ep {
    if (ep) {
      const durationMs = now() - ep.start
      if (durationMs >= minMs) push(type, { durationMs, ...extra })
    }
    return null
  }

  function closeAllEpisodes(): void {
    hiddenEp = closeEpisode(hiddenEp, 'tab_hidden', MIN_BROWSER_EPISODE_MS)
    focusEp = closeEpisode(focusEp, 'focus_lost', MIN_BROWSER_EPISODE_MS)
    faceAbsentEp = closeEpisode(faceAbsentEp, 'face_absent', FACE_ABSENT_MS)
    multiFaceEp = closeEpisode(multiFaceEp, 'multiple_faces', MULTI_FACE_MS, {
      count: multiFaceEp?.peak ?? 2,
    })
    lookAwayEp = closeEpisode(lookAwayEp, 'looking_away', LOOK_AWAY_MS, {
      yaw: lastPose ? Math.round(lastPose.yaw) : undefined,
      pitch: lastPose ? Math.round(lastPose.pitch) : undefined,
    })
    lookDownEp = closeEpisode(lookDownEp, 'looking_down', LOOK_AWAY_MS)
    tooFarEp = closeEpisode(tooFarEp, 'too_far', TOO_FAR_MS)
    phoneEp = closeEpisode(phoneEp, 'phone_detected', PHONE_DETECTED_MS)
    secondVoiceEp = closeEpisode(secondVoiceEp, 'second_voice', SECOND_VOICE_MS)
  }

  // -------------------------------------------------------------------------
  // Layer 1 — Browser events
  // -------------------------------------------------------------------------

  function onVisibility(): void {
    if (document.visibilityState === 'hidden') {
      if (!hiddenEp) hiddenEp = { start: now() }
    } else {
      hiddenEp = closeEpisode(hiddenEp, 'tab_hidden', MIN_BROWSER_EPISODE_MS)
    }
  }

  function onBlur(): void {
    if (document.visibilityState === 'visible' && !focusEp) {
      focusEp = { start: now() }
    }
  }

  function onFocus(): void {
    focusEp = closeEpisode(focusEp, 'focus_lost', MIN_BROWSER_EPISODE_MS)
  }

  function onFullscreenChange(): void {
    if (!document.fullscreenElement && active) {
      push('fullscreen_exit')
    }
  }

  function onCopy(): void {
    if (active) push('clipboard_copy')
  }

  function onPaste(): void {
    if (active) push('clipboard_paste')
  }

  // -------------------------------------------------------------------------
  // Layer 2 — Face detection (episode-based, same as legacy)
  // -------------------------------------------------------------------------

  function evaluateFrame(
    faceCount: number,
    pose: { yaw: number; pitch: number } | null,
    faceWidth = 0
  ): void {
    const t = now()

    // face_absent
    if (faceCount === 0) {
      if (!faceAbsentEp) faceAbsentEp = { start: t }
    } else {
      faceAbsentEp = closeEpisode(faceAbsentEp, 'face_absent', FACE_ABSENT_MS)
    }

    // multiple_faces
    if (faceCount >= 2) {
      if (!multiFaceEp) multiFaceEp = { start: t, peak: faceCount }
      else multiFaceEp.peak = Math.max(multiFaceEp.peak ?? 2, faceCount)
    } else {
      multiFaceEp = closeEpisode(multiFaceEp, 'multiple_faces', MULTI_FACE_MS, {
        count: multiFaceEp?.peak ?? 2,
      })
    }

    // looking_away — exactly one face, turned off-axis
    const away =
      faceCount === 1 &&
      pose != null &&
      (Math.abs(pose.yaw) >= LOOK_AWAY_YAW_DEG || Math.abs(pose.pitch) >= LOOK_AWAY_PITCH_DEG)
    if (away) {
      lastPose = pose
      if (!lookAwayEp) lookAwayEp = { start: t }
    } else {
      lookAwayEp = closeEpisode(lookAwayEp, 'looking_away', LOOK_AWAY_MS, {
        yaw: lastPose ? Math.round(lastPose.yaw) : undefined,
        pitch: lastPose ? Math.round(lastPose.pitch) : undefined,
      })
    }

    // looking_down
    const down = faceCount === 1 && pose != null && pose.pitch < -LOOK_DOWN_PITCH_DEG
    if (down) {
      if (!lookDownEp) lookDownEp = { start: t }
    } else {
      lookDownEp = closeEpisode(lookDownEp, 'looking_down', LOOK_AWAY_MS, {
        pitch: pose ? Math.round(pose.pitch) : undefined,
      })
    }

    // too_far
    const farAway = faceCount === 1 && faceWidth > 0 && faceWidth < FACE_MIN_WIDTH_RATIO
    if (farAway) {
      if (!tooFarEp) tooFarEp = { start: t }
    } else {
      tooFarEp = closeEpisode(tooFarEp, 'too_far', TOO_FAR_MS)
    }
  }

  function sampleOnce(): void {
    if (!landmarker || !selfView || selfView.readyState < 2) return
    let result: FaceResult
    try {
      result = landmarker.detectForVideo(selfView, performance.now())
    } catch {
      return
    }
    const faces = result.faceLandmarks ?? []
    const faceCount = faces.length
    const matrix = result.facialTransformationMatrixes?.[0]?.data
    const pose = faceCount === 1 && matrix ? poseFromMatrix(matrix) : null
    let faceWidth = 0
    if (faceCount === 1 && faces[0]) {
      let minX = 1
      let maxX = 0
      for (const l of faces[0]) {
        if (l.x < minX) minX = l.x
        if (l.x > maxX) maxX = l.x
      }
      faceWidth = maxX - minX
    }
    evaluateFrame(faceCount, pose, faceWidth)
  }

  function samplePhone(): void {
    if (!objectDetector || !selfView || selfView.readyState < 2) return
    try {
      const result = objectDetector.detectForVideo(selfView, performance.now())
      if (result.detections.length > 0) {
        if (!phoneEp) phoneEp = { start: now() }
      } else {
        phoneEp = closeEpisode(phoneEp, 'phone_detected', PHONE_DETECTED_MS)
      }
    } catch {
      /* transient */
    }
  }

  async function ensureLandmarker(): Promise<FaceLandmarkerLike | null> {
    if (landmarker) return landmarker
    if (!landmarkerPromise) {
      landmarkerPromise = (async () => {
        try {
          const vision = await import('@mediapipe/tasks-vision')
          const fileset = await vision.FilesetResolver.forVisionTasks('/proctor/wasm')
          landmarker = (await vision.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: '/proctor/face_landmarker.task' },
            runningMode: 'VIDEO',
            numFaces: 2,
            outputFacialTransformationMatrixes: true,
            outputFaceBlendshapes: false,
          })) as unknown as FaceLandmarkerLike
          return landmarker
        } catch (err) {
          console.warn('[useProctor] face detection unavailable:', err)
          // Tell the SERVER, not just the console. A console warning nobody
          // reads is what let this stay dead for weeks while every session
          // reported "Rischio basso" about a candidate nobody watched.
          push('proctor_unavailable', { layer: 'face', reason: String(err) })
          landmarkerPromise = null
          return null
        }
      })()
    }
    return landmarkerPromise
  }

  async function ensureObjectDetector(): Promise<ObjectDetectorLike | null> {
    if (objectDetector) return objectDetector
    if (!objectDetectorPromise) {
      objectDetectorPromise = (async () => {
        try {
          const vision = await import('@mediapipe/tasks-vision')
          const fileset = await vision.FilesetResolver.forVisionTasks('/proctor/wasm')
          objectDetector = (await vision.ObjectDetector.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: '/proctor/efficientdet_lite0.tflite' },
            runningMode: 'VIDEO',
            scoreThreshold: PHONE_SCORE_THRESHOLD,
            categoryAllowlist: ['cell phone'],
          })) as unknown as ObjectDetectorLike
          return objectDetector
        } catch (err) {
          console.warn('[useProctor] phone detection unavailable:', err)
          push('proctor_unavailable', { layer: 'phone', reason: String(err) })
          objectDetectorPromise = null
          return null
        }
      })()
    }
    return objectDetectorPromise
  }

  // -------------------------------------------------------------------------
  // Layer 3 — Audio (second_voice)
  // -------------------------------------------------------------------------

  function sampleAudio(): void {
    if (!analyserNode || !audioDataArray) return
    analyserNode.getByteTimeDomainData(audioDataArray)
    let sum = 0
    for (let i = 0; i < audioDataArray.length; i++) {
      const v = ((audioDataArray[i] ?? 128) - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / audioDataArray.length)

    if (avatarSpeaking && rms > VOICE_RMS_THRESHOLD) {
      if (!secondVoiceEp) secondVoiceEp = { start: now() }
    } else {
      secondVoiceEp = closeEpisode(secondVoiceEp, 'second_voice', SECOND_VOICE_MS)
    }
  }

  function initAudio(): void {
    // Audio init is sync setup using the video stream's audio tracks.
    // With echoCancellation:true, avatar speaker audio is suppressed.
    // We re-use the same stream (no second getUserMedia for audio).
    if (!stream) return
    const audioTracks = stream.getAudioTracks?.() ?? []
    if (audioTracks.length === 0) return

    try {
      audioCtx = new AudioContext()
      analyserNode = audioCtx.createAnalyser()
      analyserNode.fftSize = 256
      audioDataArray = new Uint8Array(analyserNode.frequencyBinCount)
      audioCtx.createMediaStreamSource(stream).connect(analyserNode)
      audioSampleTimer = setInterval(sampleAudio, 500)
    } catch {
      // AudioContext unavailable — second_voice detection degraded
    }
  }

  // -------------------------------------------------------------------------
  // Snapshot (periodic)
  // -------------------------------------------------------------------------

  /**
   * Capture a frame and POST it to /snapshot.
   *
   * This is the SINGLE authoritative snapshot path. useInterviewSession also carried a
   * snapshot interval, but its send function was empty and it holds no video element,
   * so it could never have captured anything; it has been removed.
   */
  function takeSnapshot(): void {
    if (!selfView || selfView.readyState < 2) return

    // POST /snapshot requires session_id — without it the request is rejected outright.
    const snapshotSessionId = options.getSessionId?.() ?? null
    if (snapshotSessionId === null) return

    const canvas = document.createElement('canvas')
    canvas.width = selfView.videoWidth || 320
    canvas.height = selfView.videoHeight || 240
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(selfView, 0, 0)

    // toDataURL returns "data:image/jpeg;base64,<payload>"; the endpoint's
    // `image_base64` field wants the PAYLOAD ONLY.
    //
    // Sending the whole data URL produced a hard 422 on every snapshot in
    // production ("Image must be a JPEG (invalid magic bytes)"), and the failure
    // mode is worth spelling out because it is not the obvious one: the server
    // decodes with strict:false, and every character of "dataimagejpegbase64" is
    // itself in the base64 alphabet. So the decode did not reject the prefix — it
    // consumed it, shifting the payload out of alignment, and the resulting bytes
    // no longer started with FF D8 FF. A stricter decoder would have failed
    // loudly on the ':' and ';' instead.
    const imageBase64 = canvas.toDataURL('image/jpeg', 0.7).split(',')[1] ?? ''
    if (!imageBase64) return

    // Best-effort POST to /snapshot; errors are silent. Routed through the
    // single authenticated transport (D-B) — this was previously a raw
    // `fetch()` call that escaped the candidate-fetch guard.
    candidateFetch('/candidate/interview/snapshot', {
      method: 'POST',
      body: {
        session_id: snapshotSessionId,
        image_base64: imageBase64,
        ts: new Date().toISOString(),
      },
      keepalive: true,
    }).catch(() => {
      // 413/422 → log, continue interval
    })
  }

  // -------------------------------------------------------------------------
  // Camera init (uses the passed-in stream)
  // -------------------------------------------------------------------------

  async function initCamera(): Promise<void> {
    if (!stream || !active) return

    // Create a hidden video element for MediaPipe frame sampling
    selfView = document.createElement('video') as HTMLVideoElement
    selfView.srcObject = stream
    selfView.muted = true
    Object.assign(selfView, { hidden: true })
    // Needed for detectForVideo to have frames
    void selfView.play().catch(() => {})

    // Start periodic snapshot timer
    snapshotTimer = setInterval(takeSnapshot, SNAPSHOT_INTERVAL_MS)

    // Load FaceLandmarker (async, client-only via dynamic import)
    if (import.meta.client) {
      const lm = await ensureLandmarker()
      if (!active || !lm) return
      sampleTimer = setInterval(sampleOnce, Math.round(1000 / SAMPLE_FPS))

      // Phone detection loads in parallel, doesn't block face detection
      void ensureObjectDetector().then((od) => {
        if (!active || !od) return
        phoneSampleTimer = setInterval(samplePhone, PHONE_SAMPLE_MS)
      })
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function start(videoStream: MediaStream): void {
    if (active) return
    active = true
    stream = videoStream

    // second_monitor check (one-shot; WebKit guard: isExtended may be undefined)
    const screenExtended = (screen as Screen & { isExtended?: unknown }).isExtended
    if (screenExtended === true) {
      push('second_monitor', { isExtended: true })
    }

    // Layer 1 listeners
    onVisibilityBound = onVisibility
    onBlurBound = onBlur
    onFocusBound = onFocus
    onFullscreenBound = onFullscreenChange
    onCopyBound = onCopy
    onPasteBound = onPaste

    document.addEventListener('visibilitychange', onVisibilityBound)
    window.addEventListener('blur', onBlurBound)
    window.addEventListener('focus', onFocusBound)
    document.addEventListener('fullscreenchange', onFullscreenBound)
    document.addEventListener('copy', onCopyBound)
    document.addEventListener('paste', onPasteBound)

    // Layer 3 — audio (uses the passed stream)
    initAudio()

    // Layer 2 — camera + MediaPipe (client-only)
    if (import.meta.client) {
      void initCamera()
    }

    // No periodic flush timer here: flushing is the consumer's job, driven by the
    // `onEvent` subscription plus getPendingEvents()/acknowledgeEvents(). A timer
    // firing an empty function read as working machinery and was removed.
  }

  function stop(): void {
    if (!active) return
    active = false

    // Remove Layer 1 listeners
    if (onVisibilityBound) document.removeEventListener('visibilitychange', onVisibilityBound)
    if (onBlurBound) window.removeEventListener('blur', onBlurBound)
    if (onFocusBound) window.removeEventListener('focus', onFocusBound)
    if (onFullscreenBound) document.removeEventListener('fullscreenchange', onFullscreenBound)
    if (onCopyBound) document.removeEventListener('copy', onCopyBound)
    if (onPasteBound) document.removeEventListener('paste', onPasteBound)

    // Clear timers
    if (sampleTimer != null) clearInterval(sampleTimer)
    if (phoneSampleTimer != null) clearInterval(phoneSampleTimer)
    if (snapshotTimer != null) clearInterval(snapshotTimer)
    if (audioSampleTimer != null) clearInterval(audioSampleTimer)
    sampleTimer = null
    phoneSampleTimer = null
    snapshotTimer = null
    audioSampleTimer = null

    // Close audio resources
    analyserNode = null
    audioDataArray = null
    void audioCtx?.close().catch(() => {})
    audioCtx = null
    avatarSpeaking = false

    // Close all open episodes before final flush
    closeAllEpisodes()

    // Release video element
    if (selfView) {
      selfView.srcObject = null
    }
    selfView = null
    stream = null
  }

  function setAvatarSpeaking(speaking: boolean): void {
    avatarSpeaking = speaking
  }

  function getPendingEvents(): IntegrityEventInternal[] {
    return [...buffer]
  }

  /**
   * Remove already-flushed events from the buffer.
   *
   * The buffer used to be append-only, so every flush re-sent the entire session's
   * history. Acknowledging is by object identity rather than draining on read: a
   * flush can fail (sendBeacon refuses oversized payloads, a POST can 5xx), and a
   * destructive read would discard those events with no way to retry them.
   */
  function acknowledgeEvents(events: IntegrityEventInternal[]): void {
    if (events.length === 0) return
    const acknowledged = new Set<IntegrityEventInternal>(events)
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (acknowledged.has(buffer[i]!)) buffer.splice(i, 1)
    }
  }

  // -------------------------------------------------------------------------
  // Test escape hatches (allow unit tests to drive episode logic without timers)
  // -------------------------------------------------------------------------

  function triggerFaceSample(input: ProctoFaceSampleInput): void {
    const pose =
      input.yaw !== undefined && input.pitch !== undefined
        ? { yaw: input.yaw, pitch: input.pitch }
        : null
    if (input.closeEpisode) {
      // Force-close all face episodes
      faceAbsentEp = closeEpisode(faceAbsentEp, 'face_absent', FACE_ABSENT_MS)
      multiFaceEp = closeEpisode(multiFaceEp, 'multiple_faces', MULTI_FACE_MS, {
        count: multiFaceEp?.peak ?? 2,
      })
      lookAwayEp = closeEpisode(lookAwayEp, 'looking_away', LOOK_AWAY_MS, {
        yaw: lastPose ? Math.round(lastPose.yaw) : undefined,
        pitch: lastPose ? Math.round(lastPose.pitch) : undefined,
      })
      lookDownEp = closeEpisode(lookDownEp, 'looking_down', LOOK_AWAY_MS)
      tooFarEp = closeEpisode(tooFarEp, 'too_far', TOO_FAR_MS)
    } else {
      evaluateFrame(input.faceCount, pose, input.faceWidth ?? 0)
    }
  }

  function triggerVoiceSample(aboveThreshold: boolean): void {
    if (aboveThreshold) {
      if (avatarSpeaking && !secondVoiceEp) secondVoiceEp = { start: now() }
    } else {
      secondVoiceEp = closeEpisode(secondVoiceEp, 'second_voice', SECOND_VOICE_MS)
    }
  }

  function injectSelfView(video: HTMLVideoElement): void {
    selfView = video
  }

  function injectLandmarker(lm: {
    detectForVideo(v: HTMLVideoElement, ts: number): unknown
    close(): void
  }): void {
    landmarker = lm as FaceLandmarkerLike
  }

  function injectObjectDetector(od: {
    detectForVideo(v: HTMLVideoElement, ts: number): unknown
    close(): void
  }): void {
    objectDetector = od as ObjectDetectorLike
  }

  return {
    start,
    stop,
    setAvatarSpeaking,
    getPendingEvents,
    acknowledgeEvents,
    triggerFaceSample,
    triggerVoiceSample,
    injectSelfView,
    injectLandmarker,
    injectObjectDetector,
    triggerSampleOnce: sampleOnce,
    triggerSamplePhone: samplePhone,
    triggerSnapshot: takeSnapshot,
    triggerInitCamera: initCamera,
    triggerEnsureLandmarker: ensureLandmarker,
    triggerEnsureObjectDetector: ensureObjectDetector,
  }
}
