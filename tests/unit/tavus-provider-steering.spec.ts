/**
 * Boundary steering over the Tavus provider (design N5, N15), proven with an
 * injected fake Daily. The echo shapes replay the live spike (Appendix A, L4):
 * the `respond` comes back as a user-role utterance with the sent text, and
 * shares its `inference_id` with the avatar's reply.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TavusProvider, STEERING_ACK_TIMEOUT_MS } from '~/app/providers/tavus'
import { canSteerContext } from '~/app/types/interview-provider'
import {
  buildAdvancePayload,
  createBoundaryTicket,
  RESPOND_TEXT,
} from '~/app/utils/advance-interaction'

type Handler = (data: unknown) => void

const ticket = createBoundaryTicket('conv-1', 'PRS')

function setup(meetingState = 'joined-meeting') {
  const handlers = new Map<string, Handler[]>()
  const frame = {
    on: vi.fn((event: string, cb: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), cb])
    }),
    join: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    sendAppMessage: vi.fn(),
    meetingState: vi.fn(() => meetingState),
  }
  const provider = new TavusProvider(vi.fn().mockResolvedValue(frame))
  const transcripts: { role: string; text: string }[] = []
  const failures: unknown[] = []
  provider.on('transcript', (t) => transcripts.push(t as { role: string; text: string }))
  provider.on('steering_failed', (f) => failures.push(f))

  const fire = (event: string, data: unknown = {}) =>
    (handlers.get(event) ?? []).forEach((cb) => cb(data))
  const utter = (role: string, speech: string, extra: Record<string, unknown> = {}) =>
    fire('app-message', {
      data: {
        message_type: 'conversation',
        event_type: 'conversation.utterance',
        properties: { role, speech },
        ...extra,
      },
    })
  const start = () =>
    provider.start(document.createElement('div'), {
      dbSessionId: 1,
      conversationUrl: 'https://tavus.daily.co/x',
      endPhrase: 'Next.',
      finalPhrase: 'Thanks.',
    })

  return { provider, frame, transcripts, failures, fire, utter, start }
}

describe('TavusProvider.sendBoundary', () => {
  let ctx: ReturnType<typeof setup>

  beforeEach(async () => {
    vi.useFakeTimers()
    ctx = setup()
    await ctx.start()
  })
  afterEach(() => vi.useRealTimers())

  it('is exposed through the SupportsContextSteering guard', () => {
    expect(canSteerContext(ctx.provider)).toBe(true)
    expect(canSteerContext({ start: vi.fn() } as never)).toBe(false)
  })

  it('sends the append THEN the respond through sendAppMessage(msg, "*")', async () => {
    const pending = ctx.provider.sendBoundary(ticket)
    const [append, respond] = buildAdvancePayload(ticket)

    expect(ctx.frame.sendAppMessage.mock.calls).toEqual([
      [append, '*'],
      [respond, '*'],
    ])
    ctx.utter('replica', 'Topic two.', { inference_id: 'i1' })
    await pending
  })

  it('refuses without sending when the call is not joined', async () => {
    const c = setup('left-meeting')
    await c.start()

    const result = await c.provider.sendBoundary(ticket)

    expect(result).toEqual({ ok: false, reason: 'not_joined' })
    expect(c.frame.sendAppMessage).not.toHaveBeenCalled()
    expect(c.failures).toHaveLength(1)
  })

  it('acknowledges on the first avatar utterance; the pal twin is not a second ack', async () => {
    const first = ctx.provider.sendBoundary(ticket)
    ctx.utter('replica', 'Topic two.', { inference_id: 'i1' })
    expect(await first).toEqual({ ok: true })

    const second = ctx.provider.sendBoundary(ticket)
    ctx.utter('pal', 'Topic two.', { inference_id: 'i1' }) // twin of the first reply
    await vi.advanceTimersByTimeAsync(STEERING_ACK_TIMEOUT_MS)

    expect(await second).toEqual({ ok: false, reason: 'timeout' })
    expect(ctx.failures).toHaveLength(1)
  })

  it('emits steering_failed when a send throws', async () => {
    ctx.frame.sendAppMessage.mockImplementation(() => {
      throw new Error('boom')
    })

    expect(await ctx.provider.sendBoundary(ticket)).toEqual({ ok: false, reason: 'send_failed' })
    expect(ctx.failures).toHaveLength(1)
  })

  it.each(['left-meeting', 'error'])('fails the steering on %s', async (event) => {
    const pending = ctx.provider.sendBoundary(ticket)
    ctx.fire(event)

    expect(await pending).toEqual({ ok: false, reason: event === 'error' ? 'error' : 'left' })
    expect(ctx.failures).toHaveLength(1)
  })

  it('fails with timeout when no avatar utterance arrives in 10 s', async () => {
    const pending = ctx.provider.sendBoundary(ticket)
    await vi.advanceTimersByTimeAsync(STEERING_ACK_TIMEOUT_MS - 1)
    expect(ctx.failures).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)

    expect(STEERING_ACK_TIMEOUT_MS).toBe(10_000)
    expect(await pending).toEqual({ ok: false, reason: 'timeout' })
    expect(ctx.failures).toHaveLength(1)
  })
})

describe('TavusProvider steering echo filter (N15)', () => {
  let ctx: ReturnType<typeof setup>

  beforeEach(async () => {
    vi.useFakeTimers()
    ctx = setup()
    await ctx.start()
  })
  afterEach(() => vi.useRealTimers())

  it('holds the echo, then discards it when the reply shares its inference_id', async () => {
    const pending = ctx.provider.sendBoundary(ticket)
    ctx.utter('user', RESPOND_TEXT, { inference_id: 'i1', turn_idx: 1 })
    expect(ctx.transcripts).toEqual([]) // held, not emitted

    ctx.utter('replica', 'Topic two.', { inference_id: 'i1', turn_idx: 1 })
    ctx.utter('pal', 'Topic two.', { inference_id: 'i1', turn_idx: 1 })
    await pending

    expect(ctx.transcripts.map((t) => [t.role, t.text])).toEqual([['avatar', 'Topic two.']])
  })

  it('discards the held echo when the ack times out', async () => {
    const pending = ctx.provider.sendBoundary(ticket)
    ctx.utter('user', RESPOND_TEXT, { inference_id: 'i1', turn_idx: 1 })
    await vi.advanceTimersByTimeAsync(STEERING_ACK_TIMEOUT_MS)
    await pending

    expect(ctx.transcripts).toEqual([])
  })

  it('emits a user utterance with different text while armed', async () => {
    const pending = ctx.provider.sendBoundary(ticket)
    ctx.utter('user', 'I think so', { inference_id: 'i9' })
    expect(ctx.transcripts.map((t) => t.text)).toEqual(['I think so'])

    ctx.utter('replica', 'Topic two.', { inference_id: 'i1' })
    await pending
  })

  it('emits the same text once disarmed', async () => {
    const pending = ctx.provider.sendBoundary(ticket)
    ctx.utter('replica', 'Topic two.', { inference_id: 'i1' })
    await pending

    ctx.utter('user', RESPOND_TEXT, { inference_id: 'i2' })

    expect(ctx.transcripts.map((t) => [t.role, t.text])).toEqual([
      ['avatar', 'Topic two.'],
      ['user', RESPOND_TEXT],
    ])
  })

  it('releases a held utterance when the reply carries another inference_id', async () => {
    const pending = ctx.provider.sendBoundary(ticket)
    ctx.utter('user', RESPOND_TEXT, { inference_id: 'i1' })
    ctx.utter('replica', 'Topic two.', { inference_id: 'other' })
    await pending

    expect(ctx.transcripts.map((t) => [t.role, t.text])).toEqual([
      ['user', RESPOND_TEXT],
      ['avatar', 'Topic two.'],
    ])
  })
})
