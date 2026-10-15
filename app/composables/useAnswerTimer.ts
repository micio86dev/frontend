/**
 * useAnswerTimer: how long the candidate's answer has been running.
 *
 * live-interview-call-chrome, design D10. The count starts when the interviewer STOPS
 * speaking (`avatar` -> `none`) and runs on through the answer: twelve seconds of silence
 * after a question read 12, and the candidate starting to speak does not reset it. A pause
 * in speech does not stop it either; only the interviewer speaking again does (a new
 * question or follow-up).
 *
 * The microphone is not an input: muting is silence to the provider, so the count keeps
 * running (D9). The timer is guidance for the panel and never drives `/end`.
 *
 * COST: one `setInterval`, armed only while `waiting` or `answering` and cleared otherwise
 * and on scope disposal. It counts its own ticks: this is a display of seconds spent, not
 * the interview clock (`useInterviewClock` owns the timestamp-based figure).
 */

import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue'

import type { Speaker } from '~/app/composables/useSpeakerTurn'

export type AnswerPhase = 'idle' | 'listening' | 'waiting' | 'answering'

const TICK_MS = 1000

export interface UseAnswerTimerOptions {
  speaker: Readonly<Ref<Speaker>>
  sessionId: Readonly<Ref<number | null>>
  /** True while the interview is live; false (suspended, connecting, ended) resets to idle. */
  live: () => boolean
}

export interface UseAnswerTimerReturn {
  phase: Readonly<Ref<AnswerPhase>>
  seconds: Readonly<Ref<number>>
}

export function useAnswerTimer(options: UseAnswerTimerOptions): UseAnswerTimerReturn {
  const phase = ref<AnswerPhase>('idle')
  const seconds = ref(0)
  let timer: ReturnType<typeof setInterval> | null = null

  function disarm(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function arm(): void {
    timer ??= setInterval(() => {
      seconds.value += 1
    }, TICK_MS)
  }

  function reset(): void {
    disarm()
    phase.value = 'idle'
    seconds.value = 0
  }

  function onSpeaker(speaker: Speaker): void {
    if (!options.live()) return

    if (speaker === 'avatar') {
      disarm()
      phase.value = 'listening'
      seconds.value = 0
    } else if (speaker === 'candidate') {
      if (phase.value === 'idle' || phase.value === 'listening') seconds.value = 0
      phase.value = 'answering'
      arm()
    } else if (phase.value === 'listening') {
      phase.value = 'waiting' // `listening` always holds 0 seconds
      arm()
    }
    // `none` while idle, waiting or answering changes nothing: a pause is not the end.
  }

  watch(options.speaker, onSpeaker, { flush: 'sync' })

  // A new session or leaving `live` starts over; whoever is already talking is picked up
  // again so a crossfade that keeps the interviewer speaking does not lose the question.
  watch(
    [() => options.live(), options.sessionId],
    () => {
      reset()
      onSpeaker(options.speaker.value)
    },
    { flush: 'sync' }
  )

  if (getCurrentScope()) onScopeDispose(disarm)

  return { phase, seconds }
}
