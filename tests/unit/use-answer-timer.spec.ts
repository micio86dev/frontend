/**
 * useAnswerTimer: how long the candidate's answer has been running (design D10).
 *
 * The count starts when the interviewer STOPS speaking and runs on through the answer.
 * Muting is not an input (D9), and the timer never drives `/end`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope, ref } from 'vue'

import { useAnswerTimer } from '~/app/composables/useAnswerTimer'
import type { Speaker } from '~/app/composables/useSpeakerTurn'

function setup(initial: { speaker?: Speaker; sessionId?: number | null; live?: boolean } = {}) {
  const speaker = ref<Speaker>(initial.speaker ?? 'none')
  const sessionId = ref<number | null>(initial.sessionId ?? 1)
  const live = ref(initial.live ?? true)
  const scope = effectScope()
  const timer = scope.run(() => useAnswerTimer({ speaker, sessionId, live: () => live.value }))!

  return { speaker, sessionId, live, scope, ...timer }
}

const tick = (s: number) => vi.advanceTimersByTime(s * 1000)

describe('useAnswerTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts idle at zero and arms no interval', () => {
    const t = setup()

    expect(t.phase.value).toBe('idle')
    expect(t.seconds.value).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('picks up an interviewer who is already speaking when it is created, then counts the silence', () => {
    const t = setup({ speaker: 'avatar' })

    expect(t.phase.value).toBe('listening')
    expect(t.seconds.value).toBe(0)

    t.speaker.value = 'none'
    tick(7)

    expect(t.phase.value).toBe('waiting')
    expect(t.seconds.value).toBe(7)
  })

  it('picks up a candidate who is already speaking when it is created', () => {
    const t = setup({ speaker: 'candidate' })
    tick(3)

    expect(t.phase.value).toBe('answering')
    expect(t.seconds.value).toBe(3)
  })

  it('reads listening at zero while the interviewer speaks, with no interval', () => {
    const t = setup()
    t.speaker.value = 'avatar'
    tick(5)

    expect(t.phase.value).toBe('listening')
    expect(t.seconds.value).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads 12 in waiting after twelve seconds of silence once the interviewer stops', () => {
    const t = setup()
    t.speaker.value = 'avatar'
    t.speaker.value = 'none'
    tick(12)

    expect(t.phase.value).toBe('waiting')
    expect(t.seconds.value).toBe(12)
  })

  it('continues the count when the candidate starts speaking, without a reset', () => {
    const t = setup()
    t.speaker.value = 'avatar'
    t.speaker.value = 'none'
    tick(12)
    t.speaker.value = 'candidate'

    expect(t.phase.value).toBe('answering')
    expect(t.seconds.value).toBe(12)

    tick(28)
    expect(t.seconds.value).toBe(40)
  })

  it('does not stop the count during a 3 second pause in speech', () => {
    const t = setup()
    t.speaker.value = 'avatar'
    t.speaker.value = 'none'
    tick(2)
    t.speaker.value = 'candidate'
    tick(4)
    t.speaker.value = 'none'
    tick(3)

    expect(t.phase.value).toBe('answering')
    expect(t.seconds.value).toBe(9)

    t.speaker.value = 'candidate'
    tick(1)
    expect(t.seconds.value).toBe(10)
  })

  it('resets to listening at zero when the interviewer starts speaking again', () => {
    const t = setup()
    t.speaker.value = 'avatar'
    t.speaker.value = 'none'
    tick(5)
    t.speaker.value = 'candidate'
    tick(5)
    t.speaker.value = 'avatar'

    expect(t.phase.value).toBe('listening')
    expect(t.seconds.value).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    tick(10)
    expect(t.seconds.value).toBe(0)
  })

  it('starts from zero when the candidate speaks while idle', () => {
    const t = setup()
    t.speaker.value = 'candidate'
    tick(3)

    expect(t.phase.value).toBe('answering')
    expect(t.seconds.value).toBe(3)
  })

  it('starts from zero when the candidate speaks straight after a question, with no gap', () => {
    const t = setup()
    t.speaker.value = 'avatar'
    t.speaker.value = 'candidate'
    tick(2)

    expect(t.phase.value).toBe('answering')
    expect(t.seconds.value).toBe(2)
  })

  it('stays idle when silence follows nothing that was asked', () => {
    const t = setup({ speaker: 'candidate' })
    t.speaker.value = 'none'
    t.live.value = false
    t.live.value = true
    t.speaker.value = 'none'

    expect(t.phase.value).toBe('idle')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('goes idle at zero and clears the interval when the session changes', () => {
    const t = setup()
    t.speaker.value = 'avatar'
    t.speaker.value = 'none'
    tick(7)
    t.sessionId.value = 2

    expect(t.phase.value).toBe('idle')
    expect(t.seconds.value).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('follows a speaker that is already talking when the session changes', () => {
    const t = setup()
    t.speaker.value = 'avatar'
    t.speaker.value = 'none'
    tick(3)
    t.speaker.value = 'avatar'
    t.sessionId.value = 2

    expect(t.phase.value).toBe('listening')
    expect(t.seconds.value).toBe(0)

    t.speaker.value = 'none'
    tick(4)
    expect(t.seconds.value).toBe(4)
  })

  it('does not advance while the interview is not live and resumes counting from zero after', () => {
    const t = setup()
    t.speaker.value = 'avatar'
    t.speaker.value = 'none'
    tick(5)
    t.live.value = false

    expect(t.phase.value).toBe('idle')
    expect(t.seconds.value).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    tick(600)
    expect(t.seconds.value).toBe(0)

    t.live.value = true
    expect(t.phase.value).toBe('idle')
    tick(10)
    expect(t.seconds.value).toBe(0)

    t.speaker.value = 'avatar'
    t.speaker.value = 'none'
    tick(2)
    expect(t.seconds.value).toBe(2)
  })

  it('ignores speaker changes while not live', () => {
    const t = setup({ live: false })
    t.speaker.value = 'avatar'
    t.speaker.value = 'none'
    tick(5)

    expect(t.phase.value).toBe('idle')
    expect(t.seconds.value).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs at most one interval, however often the speaker flips', () => {
    const t = setup()
    t.speaker.value = 'avatar'
    t.speaker.value = 'none'
    t.speaker.value = 'candidate'
    t.speaker.value = 'none'
    t.speaker.value = 'candidate'

    expect(vi.getTimerCount()).toBe(1)
  })

  it('clears the interval when the owning scope is disposed', () => {
    const t = setup()
    t.speaker.value = 'avatar'
    t.speaker.value = 'none'
    expect(vi.getTimerCount()).toBe(1)

    t.scope.stop()

    expect(vi.getTimerCount()).toBe(0)
  })
})
