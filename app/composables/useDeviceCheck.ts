/**
 * useDeviceCheck — Pre-join camera and microphone device verification (Task 4.6 GREEN)
 *
 * Opens a single getUserMedia({ video: true, audio: true }) stream, verifies:
 *   - Camera: at least one video track with readyState === 'live'
 *   - Microphone: audio RMS above MIC_SPEAK_THRESHOLD within a polling window
 *
 * The resolved stream is stored and handed to useProctor.start(stream) on confirmation.
 * NO second getUserMedia is ever opened — this is the single-stream handoff contract (D5).
 *
 * SSR invariant: all browser APIs (navigator.mediaDevices, AudioContext) are accessed
 * inside async function bodies, never at module scope.
 *
 * Design refs: D5 (single getUserMedia handoff), D3 (composable returns object)
 */

import { ref, type Ref } from 'vue'

// ── Tunables ────────────────────────────────────────────────────────────────

/** RMS above this level (0–1) = "candidate has spoken" — mic confirmed OK */
const MIC_SPEAK_THRESHOLD = 0.04

/** How often (ms) the mic RMS is sampled during the check window */
const MIC_SAMPLE_INTERVAL_MS = 100

// ── Public interface ────────────────────────────────────────────────────────

export interface UseDeviceCheckReturn {
  /** Whether a live camera video track was detected */
  cameraOk: Ref<boolean>
  /** Whether the mic RMS crossed the speak threshold at least once */
  micOk: Ref<boolean>
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
   */
  check(): Promise<void>
  /**
   * Stop the mic RMS polling interval. Safe to call at any time; does NOT touch the
   * stream, whose ownership transfers to useProctor on confirmation (D5).
   */
  stopMicSampling(): void
  /**
   * Stop mic polling AND stop every track of the acquired stream, resetting the
   * composable so `check()` can run again. Call ONLY when the stream was not handed
   * off — stopping a handed-off stream kills the proctoring feed.
   */
  release(): void
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function useDeviceCheck(): UseDeviceCheckReturn {
  const cameraOk = ref(false)
  const micOk = ref(false)
  const stream = ref<MediaStream | null>(null)

  /** Set only after a check that actually produced a usable camera. */
  let succeeded = false
  /** The in-flight check, so concurrent calls share one getUserMedia. */
  let inFlight: Promise<void> | null = null

  // Internal state for mic polling (so it can be cleaned up if needed)
  let micSampleTimer: ReturnType<typeof setInterval> | null = null

  function stopMicSampling(): void {
    if (micSampleTimer != null) {
      clearInterval(micSampleTimer)
      micSampleTimer = null
    }
  }

  function release(): void {
    stopMicSampling()
    for (const track of stream.value?.getTracks() ?? []) {
      track.stop()
    }
    stream.value = null
    cameraOk.value = false
    micOk.value = false
    succeeded = false
  }

  function check(): Promise<void> {
    if (succeeded) return Promise.resolve()
    if (inFlight) return inFlight

    inFlight = runCheck().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  async function runCheck(): Promise<void> {
    let acquired: MediaStream

    try {
      acquired = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    } catch {
      // NotFoundError, NotAllowedError, OverconstrainedError, etc.
      // cameraOk and micOk stay false; stream stays null. `succeeded` stays false so
      // the candidate can grant the permission and retry.
      return
    }

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

    // ── Microphone check (async, polling via AudioContext RMS) ─────────────
    // We reuse the audio tracks from the same acquired stream — no second getUserMedia.
    const audioTracks = acquired.getAudioTracks()
    if (audioTracks.length > 0) {
      try {
        const audioCtx = new AudioContext()
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 256
        audioCtx.createMediaStreamSource(acquired).connect(analyser)
        const buffer = new Uint8Array(analyser.frequencyBinCount)

        micSampleTimer = setInterval(() => {
          analyser.getByteTimeDomainData(buffer)
          let sum = 0
          for (let i = 0; i < buffer.length; i++) {
            const v = ((buffer[i] ?? 128) - 128) / 128
            sum += v * v
          }
          const rms = Math.sqrt(sum / buffer.length)

          if (rms > MIC_SPEAK_THRESHOLD) {
            micOk.value = true
            stopMicSampling()
          }
        }, MIC_SAMPLE_INTERVAL_MS)
      } catch {
        // AudioContext unavailable — mic check degraded; micOk stays false
      }
    }
  }

  return { cameraOk, micOk, stream, check, stopMicSampling, release }
}
