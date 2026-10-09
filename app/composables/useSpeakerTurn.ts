/**
 * useSpeakerTurn.ts — who is speaking right now: the avatar, the candidate or nobody.
 *
 * candidate-interview-call-ui, design D4. One signal built from two kinds of
 * evidence, because neither alone is enough: HeyGen reports `speaking`, Tavus
 * reports nothing of the kind, and a provider event says nothing about the
 * candidate at all. So the avatar's remote audio and the candidate's own
 * microphone are read as levels too, and the rules below turn the lot into a
 * single value.
 *
 * Nothing here leaves the browser: both streams are analysed locally and only
 * the resulting level is looked at.
 *
 * THE RULES (all constants are exported and unit-tested)
 *
 * 1. `avatar` when the provider state is `speaking`, or the avatar's audio stays above
 *    `AVATAR_AUDIO_GATE` for `AVATAR_ONSET_MS`. Held for `AVATAR_HOLD_MS` after the
 *    last positive reading, so a pause between words does not flicker.
 * 2. `candidate` when it is not `avatar` and the mic stays above `MIC_SPEAK_THRESHOLD` for
 *    `CANDIDATE_ONSET_MS`. Held for `CANDIDATE_HOLD_MS`. Suppressed while the avatar is
 *    active and for `CANDIDATE_SUPPRESS_AFTER_AVATAR_MS` after it, so a candidate with
 *    speakers is not "speaking" while the avatar talks.
 * 3. `none` otherwise, including between turns and in every state but `live`.
 * 4. A provider `speaking -> ready` does not end the avatar turn while the audio gate is
 *    still active. This needs no code of its own: the provider and the audio are two
 *    independent sources of a positive reading, so losing one while the other holds
 *    changes nothing.
 *
 * COST: one `setInterval` reading two analysers, started when the session becomes
 * `live` and cleared otherwise. Nothing runs while paused.
 *
 * Armed by `InterviewSession` only with the `candidateCallUi` flag on.
 */

import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue'
import { MIC_SPEAK_THRESHOLD } from '~/app/composables/useDeviceCheck'
import type { SessionState } from '~/app/composables/useInterviewSession'
import type { ProviderState } from '~/app/types/interview-provider'

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Avatar audio RMS (0-1) above which the interviewer counts as talking.
 *
 * Not fixed by D4, which names the gate but not its value. Half of
 * `MIC_SPEAK_THRESHOLD`: a remote WebRTC feed has none of a room's noise floor
 * (silence is close to digital zero), so it needs a lower gate than a live
 * microphone does. Tuning is a manual-pass item, the signal being unverified
 * against real provider audio.
 */
export const AVATAR_AUDIO_GATE = 0.02

/** How long the avatar's audio must stay above the gate before it counts. */
export const AVATAR_ONSET_MS = 120
/** How long the avatar stays lit after its last positive reading. */
export const AVATAR_HOLD_MS = 600

/** How long the mic must stay above `MIC_SPEAK_THRESHOLD` before it counts. */
export const CANDIDATE_ONSET_MS = 200
/** How long the candidate stays lit after their last positive reading. */
export const CANDIDATE_HOLD_MS = 800
/** How long the candidate stays suppressed after the avatar goes quiet. */
export const CANDIDATE_SUPPRESS_AFTER_AVATAR_MS = 500

/** How often both analysers are read while the session is `live`. */
export const SPEAKER_SAMPLE_INTERVAL_MS = 60

// ── Types ───────────────────────────────────────────────────────────────────

export type Speaker = 'avatar' | 'candidate' | 'none'

/** Reads the current level (RMS, 0-1) of one stream. */
export interface LevelReader {
  read(): number
  dispose(): void
}

/** Builds a reader for a stream, or null when it cannot be analysed. */
export type LevelReaderFactory = (stream: MediaStream) => LevelReader | null

export interface UseSpeakerTurnOptions {
  /** The interview session's state; anything but `live` forces `none`. */
  state: Readonly<Ref<SessionState>>
  /** The live role's latest provider state, or null before it reports one. */
  providerState: Readonly<Ref<ProviderState | null>>
  /** The avatar's remote stream, as `AvatarPlayer` emits it. */
  avatarStream: Readonly<Ref<MediaStream | null>>
  /** The candidate's confirmed microphone stream. */
  micStream: Readonly<Ref<MediaStream | null>>
  /** Test seam; defaults to the `AnalyserNode` reader. */
  createLevelReader?: LevelReaderFactory
}

// ── The default analyser ────────────────────────────────────────────────────

/**
 * An `AnalyserNode` over the stream, read as RMS.
 *
 * Deliberately NOT connected to `destination`: the media element already owns
 * playback of the avatar, and a second sink would play every word twice. The
 * mic is never routed to an output either.
 *
 * Null when there is no `AudioContext`, or building the graph throws: that input
 * simply never fires, which is a quieter failure than a broken interview.
 */
export function createAnalyserLevelReader(stream: MediaStream): LevelReader | null {
  const Ctor =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

  if (typeof Ctor !== 'function') return null

  try {
    const context = new Ctor()
    void context.resume().catch(() => undefined)

    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)

    const samples = new Uint8Array(new ArrayBuffer(analyser.fftSize))

    return {
      read() {
        // An autoplay policy can leave the context suspended after the single
        // resume() above. A suspended analyser returns a stale buffer, so report
        // silence and ask again (once per sample; a rejection is swallowed).
        if (context.state === 'suspended') {
          void context.resume().catch(() => undefined)
          return 0
        }

        analyser.getByteTimeDomainData(samples)

        let sum = 0
        for (const sample of samples) {
          const deviation = (sample - 128) / 128
          sum += deviation * deviation
        }

        return Math.sqrt(sum / samples.length)
      },
      dispose() {
        source.disconnect()
        analyser.disconnect()
        void context.close().catch(() => undefined)
      },
    }
  } catch {
    return null
  }
}

// ── The composable ──────────────────────────────────────────────────────────

export function useSpeakerTurn(options: UseSpeakerTurnOptions): {
  speaker: Readonly<Ref<Speaker>>
  stop: () => void
} {
  const { state, providerState, avatarStream, micStream } = options
  const createLevelReader = options.createLevelReader ?? createAnalyserLevelReader

  const speaker = ref<Speaker>('none')

  let timer: ReturnType<typeof setInterval> | null = null
  let avatarReader: LevelReader | null = null
  let micReader: LevelReader | null = null

  // Timestamps, in `Date.now()` terms. `-Infinity` means "never".
  let avatarAboveSince: number | null = null
  let avatarLitUntil = -Infinity
  let avatarWasActive = false
  let avatarEndedAt = -Infinity
  let micAboveSince: number | null = null
  let candidateLitUntil = -Infinity

  function resetTimeline(): void {
    avatarAboveSince = null
    avatarLitUntil = -Infinity
    avatarWasActive = false
    avatarEndedAt = -Infinity
    micAboveSince = null
    candidateLitUntil = -Infinity
  }

  function evaluate(): void {
    if (state.value !== 'live') {
      speaker.value = 'none'
      return
    }

    const now = Date.now()

    // Rule 1: the avatar. Two independent sources of a positive reading.
    const audioLevel = avatarReader?.read() ?? 0
    if (audioLevel > AVATAR_AUDIO_GATE) {
      avatarAboveSince ??= now
    } else {
      avatarAboveSince = null
    }
    const audioActive = avatarAboveSince !== null && now - avatarAboveSince >= AVATAR_ONSET_MS

    if (providerState.value === 'speaking' || audioActive) {
      avatarLitUntil = now + AVATAR_HOLD_MS
    }

    const avatarActive = now < avatarLitUntil
    if (avatarWasActive && !avatarActive) avatarEndedAt = avatarLitUntil
    avatarWasActive = avatarActive

    // Rule 2: the candidate, suppressed while the avatar is active and just after.
    // The onset restarts after the suppression ends: a mic that has been
    // hearing the avatar all along must not light the instant the tail runs out.
    const suppressed = avatarActive || now - avatarEndedAt < CANDIDATE_SUPPRESS_AFTER_AVATAR_MS

    const micLevel = micReader?.read() ?? 0
    if (suppressed || micLevel <= MIC_SPEAK_THRESHOLD) {
      micAboveSince = null
    } else {
      micAboveSince ??= now
    }

    if (suppressed) {
      candidateLitUntil = -Infinity
    } else if (micAboveSince !== null && now - micAboveSince >= CANDIDATE_ONSET_MS) {
      candidateLitUntil = now + CANDIDATE_HOLD_MS
    }

    // Rule 3: everything else is `none`.
    if (avatarActive) speaker.value = 'avatar'
    else if (now < candidateLitUntil) speaker.value = 'candidate'
    else speaker.value = 'none'
  }

  function releaseReaders(): void {
    avatarReader?.dispose()
    micReader?.dispose()
    avatarReader = null
    micReader = null
  }

  /** Tear everything down, or build it up, to match the session state and streams. */
  function sync(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    releaseReaders()
    resetTimeline()

    if (state.value !== 'live') {
      speaker.value = 'none'
      return
    }

    avatarReader = avatarStream.value ? createLevelReader(avatarStream.value) : null
    micReader = micStream.value ? createLevelReader(micStream.value) : null

    timer = setInterval(evaluate, SPEAKER_SAMPLE_INTERVAL_MS)
    evaluate()
  }

  // `sync` rebuilds everything, so it must not run for a provider event: that
  // would throw away the holds. The provider path only needs a fresh evaluation.
  const stopStreams = watch([state, avatarStream, micStream], sync, {
    immediate: true,
    flush: 'sync',
  })
  const stopProvider = watch(providerState, evaluate, { flush: 'sync' })

  function stop(): void {
    stopStreams()
    stopProvider()
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    releaseReaders()
    speaker.value = 'none'
  }

  if (getCurrentScope()) onScopeDispose(stop)

  return { speaker, stop }
}
