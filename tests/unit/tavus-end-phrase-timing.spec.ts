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
import { TavusProvider, COMPLETION_FALLBACK_MS } from '~/app/providers/tavus'

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

    expect(states).toContain('complete')
  })

  it('completes on stopped_speaking even when the end phrase arrived after the speech ended', async () => {
    await startProvider()

    frame._emit('app-message', replicaStarted)
    frame._emit('app-message', replicaStopped)
    frame._emit('app-message', endUtterance())

    expect(states).toContain('complete')
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

    vi.advanceTimersByTime(COMPLETION_FALLBACK_MS)

    expect(states).toContain('complete')
  })

  it('never completes on the candidate reading the end phrase aloud', async () => {
    await startProvider()

    frame._emit('app-message', endUtterance('user'))
    frame._emit('app-message', replicaStopped)
    vi.advanceTimersByTime(COMPLETION_FALLBACK_MS)

    expect(states).not.toContain('complete')
  })

  it('completes the tool call immediately when the avatar is not speaking', async () => {
    await startProvider()

    frame._emit('app-message', { data: { type: 'conversation.tool_call', name: 'end_interview' } })

    expect(states).toContain('complete')
  })

  it('does not complete the tool call while the avatar is still speaking its closing sentence', async () => {
    await startProvider()

    frame._emit('app-message', replicaStarted)
    frame._emit('app-message', { data: { type: 'conversation.tool_call', name: 'end_interview' } })

    expect(states).not.toContain('complete')

    frame._emit('app-message', replicaStopped)

    expect(states).toContain('complete')
  })
})
