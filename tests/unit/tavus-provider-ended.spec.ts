/**
 * TavusProvider reports a conversation that ended without the client asking
 * (design N17). The observed ceiling sequence, replayed through an injected fake
 * Daily: conversation.left -> system.shutdown -> avatar track-stopped ->
 * participant-left -> Daily error "Meeting has ended" -> left-meeting.
 */
import { describe, it, expect, vi } from 'vitest'
import { TavusProvider } from '~/app/providers/tavus'

type Handler = (data: unknown) => void

function setup() {
  const handlers = new Map<string, Handler[]>()
  const fire = (event: string, data: unknown = {}) =>
    (handlers.get(event) ?? []).forEach((cb) => cb(data))
  const frame = {
    on: vi.fn((event: string, cb: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), cb])
    }),
    join: vi.fn().mockResolvedValue(undefined),
    // Leaving on purpose makes Daily report `left-meeting` too.
    leave: vi.fn(async () => fire('left-meeting')),
    destroy: vi.fn().mockResolvedValue(undefined),
    sendAppMessage: vi.fn(),
    meetingState: vi.fn(() => 'joined-meeting'),
  }
  const provider = new TavusProvider(vi.fn().mockResolvedValue(frame))
  const states: string[] = []
  const errors: unknown[] = []
  provider.on('state', (s) => states.push(s as string))
  provider.on('error', (e) => errors.push(e))
  const start = () =>
    provider.start(document.createElement('div'), {
      dbSessionId: 1,
      conversationUrl: 'https://tavus.daily.co/x',
      endPhrase: 'Next.',
      finalPhrase: 'Thanks.',
    })
  return { provider, frame, states, errors, fire, start }
}

function replayEndSequence(fire: (event: string, data?: unknown) => void) {
  const message = (event_type: string) =>
    fire('app-message', { data: { message_type: 'conversation', event_type } })
  message('conversation.left')
  message('system.shutdown')
  fire('track-stopped', { participant: { local: false } })
  fire('participant-left', { participant: { local: false } })
  fire('error', { errorMsg: 'Meeting has ended' })
  fire('left-meeting')
}

describe('TavusProvider unannounced end', () => {
  it('reports exactly one stop for the observed end sequence, and no error', async () => {
    const c = setup()
    await c.start()
    c.states.length = 0

    replayEndSequence(c.fire)

    expect(c.states).toEqual(['stopped'])
    expect(c.errors).toEqual([])
  })

  it('a deliberate stop() reports its own single stop, not a second one from left-meeting', async () => {
    const c = setup()
    await c.start()
    c.states.length = 0

    await c.provider.stop()

    expect(c.frame.leave).toHaveBeenCalledOnce()
    expect(c.states).toEqual(['stopped'])
  })

  it('stays silent when left-meeting arrives after a stop', async () => {
    const c = setup()
    await c.start()
    await c.provider.stop()
    c.states.length = 0

    c.fire('left-meeting')

    expect(c.states).toEqual([])
  })
})
