/**
 * TavusProvider — the closing phrase completes a question only once the avatar
 * has finished SPEAKING it (app/providers/tavus.ts).
 *
 * Before this fix, `complete` fired the moment the end-phrase utterance arrived,
 * which can be before the last sentence has finished playing; the interview
 * then moved on and cut the avatar off mid-sentence.
 *
 * Events are the ones the legacy demo already handles:
 *   conversation.replica.started_speaking / stopped_speaking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  TavusProvider,
  COMPLETION_FALLBACK_MS,
  AVATAR_UTTERANCE_PENDING_MS,
} from '~/app/providers/tavus'
import { COMPLETION_SETTLE_MS, closingFallbackMs } from '~/app/utils/closing-completion'

interface MockCallFrame {
  on: ReturnType<typeof vi.fn>
  join: ReturnType<typeof vi.fn>
  leave: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  _emit: (eventName: string, data: unknown) => void
}

function createMockCallFrame(): MockCallFrame {
  const handlers = new Map<string, ((data: unknown) => void)[]>()

  return {
    on: vi.fn((event: string, cb: (data: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), cb])
    }),
    join: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    _emit: (eventName: string, data: unknown) => {
      for (const cb of handlers.get(eventName) ?? []) cb(data)
    },
  }
}

const PHRASES = {
  endPhrase: 'Passiamo alla prossima domanda.',
  finalPhrase: 'Grazie per il tuo tempo.',
}

const CONVERSATION_URL = 'https://tavus.daily.co/fake-room-id'

const endUtterance = (role: 'replica' | 'user' = 'replica') => ({
  data: {
    event_type: 'conversation.utterance',
    properties: { role, speech: `Ottimo. ${PHRASES.endPhrase}` },
  },
})

const END_SPEECH = `Ottimo. ${PHRASES.endPhrase}`
const toolCall = { data: { type: 'conversation.tool_call', name: 'end_interview' } }

const replicaStarted = { data: { event_type: 'conversation.replica.started_speaking' } }
const replicaStopped = { data: { event_type: 'conversation.replica.stopped_speaking' } }

describe('TavusProvider — the end phrase waits for the avatar to finish speaking', () => {
  let frame: MockCallFrame
  let states: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    frame = createMockCallFrame()
    states = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function startProvider() {
    const provider = new TavusProvider(vi.fn().mockResolvedValue(frame))
    provider.on('state', (s) => states.push(s as string))
    await provider.start(document.createElement('div'), {
      dbSessionId: 1,
      conversationUrl: CONVERSATION_URL,
      ...PHRASES,
    })
    return provider
  }

  it('does not complete on the end-phrase utterance while the avatar is still speaking', async () => {
    await startProvider()

    frame._emit('app-message', replicaStarted)
    frame._emit('app-message', endUtterance())

    expect(states).not.toContain('complete')
  })

  it('completes once the avatar stops speaking, after the end phrase was heard', async () => {
    await startProvider()

    frame._emit('app-message', replicaStarted)
    frame._emit('app-message', endUtterance())
    frame._emit('app-message', replicaStopped)
    expect(states).not.toContain('complete')

    vi.advanceTimersByTime(COMPLETION_SETTLE_MS)

    expect(states).toContain('complete')
  })

  it('holds an end phrase heard after the speech ended until the utterance gate and the settle window pass', async () => {
    await startProvider()

    frame._emit('app-message', replicaStarted)
    frame._emit('app-message', replicaStopped)
    frame._emit('app-message', endUtterance())
    vi.advanceTimersByTime(AVATAR_UTTERANCE_PENDING_MS + COMPLETION_SETTLE_MS - 1)
    expect(states).not.toContain('complete')

    vi.advanceTimersByTime(1)

    expect(states.filter((state) => state === 'complete')).toHaveLength(1)
  })

  it('does not complete on stopped_speaking when no end phrase was heard', async () => {
    await startProvider()

    frame._emit('app-message', replicaStarted)
    frame._emit('app-message', replicaStopped)

    expect(states).not.toContain('complete')
  })

  it('still completes when stopped_speaking never arrives, after the fallback window', async () => {
    await startProvider()

    frame._emit('app-message', replicaStarted)
    frame._emit('app-message', endUtterance())
    expect(states).not.toContain('complete')

    vi.advanceTimersByTime(closingFallbackMs(END_SPEECH))

    expect(states).toContain('complete')
  })

  it('never completes on the candidate reading the end phrase aloud', async () => {
    await startProvider()

    frame._emit('app-message', endUtterance('user'))
    frame._emit('app-message', replicaStopped)
    vi.advanceTimersByTime(COMPLETION_FALLBACK_MS)

    expect(states).not.toContain('complete')
  })

  it('a repeated end phrase while the avatar speaks completes the question exactly once', async () => {
    await startProvider()

    frame._emit('app-message', replicaStarted)
    frame._emit('app-message', endUtterance())
    frame._emit('app-message', endUtterance())
    frame._emit('app-message', replicaStopped)
    vi.advanceTimersByTime(COMPLETION_SETTLE_MS * 3)

    expect(states.filter((state) => state === 'complete')).toHaveLength(1)
  })

  it('a repeated end phrase keeps the fallback armed, so a lost stopped_speaking still closes the question', async () => {
    await startProvider()

    frame._emit('app-message', replicaStarted)
    frame._emit('app-message', endUtterance())
    frame._emit('app-message', endUtterance())
    vi.advanceTimersByTime(closingFallbackMs(END_SPEECH))

    expect(states.filter((state) => state === 'complete')).toHaveLength(1)
  })

  it('a deferred completion never fires after stop()', async () => {
    const provider = await startProvider()

    frame._emit('app-message', replicaStarted)
    frame._emit('app-message', endUtterance())
    await provider.stop()
    frame._emit('app-message', replicaStopped)
    vi.advanceTimersByTime(COMPLETION_FALLBACK_MS)

    expect(states).not.toContain('complete')
  })

  it('a lost stopped_speaking does not leak into the next session on the same provider', async () => {
    const provider = await startProvider()

    frame._emit('app-message', replicaStarted)
    await provider.stop()
    await provider.start(document.createElement('div'), {
      dbSessionId: 2,
      conversationUrl: CONVERSATION_URL,
      ...PHRASES,
    })
    frame._emit('app-message', endUtterance())
    vi.advanceTimersByTime(AVATAR_UTTERANCE_PENDING_MS + COMPLETION_SETTLE_MS)

    expect(states).toContain('complete')
  })

  it('the tool call on a silent avatar completes after the settle window, not before', async () => {
    await startProvider()

    frame._emit('app-message', toolCall)
    vi.advanceTimersByTime(COMPLETION_SETTLE_MS - 1)
    expect(states).not.toContain('complete')

    vi.advanceTimersByTime(1)

    expect(states).toContain('complete')
  })

  it('does not complete the tool call while the avatar is still speaking its closing sentence', async () => {
    await startProvider()

    frame._emit('app-message', replicaStarted)
    frame._emit('app-message', toolCall)

    expect(states).not.toContain('complete')

    frame._emit('app-message', replicaStopped)
    vi.advanceTimersByTime(COMPLETION_SETTLE_MS)

    expect(states).toContain('complete')
  })

  it('holds an end phrase whose utterance arrives BEFORE started_speaking', async () => {
    await startProvider()

    frame._emit('app-message', endUtterance())
    expect(states).not.toContain('complete')

    frame._emit('app-message', replicaStarted)
    vi.advanceTimersByTime(AVATAR_UTTERANCE_PENDING_MS + COMPLETION_SETTLE_MS)
    expect(states).not.toContain('complete')

    frame._emit('app-message', replicaStopped)
    vi.advanceTimersByTime(COMPLETION_SETTLE_MS - 1)
    expect(states).not.toContain('complete')

    vi.advanceTimersByTime(1)

    expect(states.filter((state) => state === 'complete')).toHaveLength(1)
  })

  it('a mid-speech stop followed by speech inside the settle window does not complete', async () => {
    await startProvider()

    frame._emit('app-message', replicaStarted)
    frame._emit('app-message', endUtterance())
    frame._emit('app-message', replicaStopped)
    vi.advanceTimersByTime(COMPLETION_SETTLE_MS - 1)
    frame._emit('app-message', replicaStarted)
    vi.advanceTimersByTime(COMPLETION_SETTLE_MS * 2)
    expect(states).not.toContain('complete')

    frame._emit('app-message', replicaStopped)
    vi.advanceTimersByTime(COMPLETION_SETTLE_MS)

    expect(states.filter((state) => state === 'complete')).toHaveLength(1)
  })

  it('the fallback is the base window plus the estimated speech, and not earlier', async () => {
    await startProvider()
    const longSpeech = `${'a'.repeat(1000)} ${PHRASES.endPhrase}`

    frame._emit('app-message', replicaStarted)
    frame._emit('app-message', {
      data: {
        event_type: 'conversation.utterance',
        properties: { role: 'replica', speech: longSpeech },
      },
    })
    const fallback = closingFallbackMs(longSpeech)

    expect(fallback).toBeGreaterThan(COMPLETION_FALLBACK_MS)
    vi.advanceTimersByTime(fallback - 1)
    expect(states).not.toContain('complete')

    vi.advanceTimersByTime(1)

    expect(states.filter((state) => state === 'complete')).toHaveLength(1)
  })

  it('caps the fallback at five minutes', () => {
    expect(closingFallbackMs('a'.repeat(100_000))).toBe(5 * 60_000)
  })

  it('stop() clears the settle timer, so no complete follows it', async () => {
    const provider = await startProvider()

    frame._emit('app-message', replicaStarted)
    frame._emit('app-message', endUtterance())
    frame._emit('app-message', replicaStopped)
    await provider.stop()
    vi.advanceTimersByTime(closingFallbackMs(END_SPEECH) + COMPLETION_SETTLE_MS)

    expect(states).not.toContain('complete')
  })
})
