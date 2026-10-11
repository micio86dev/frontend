/**
 * Tavus sends every avatar utterance twice over the data channel: once with
 * role "replica" and once with the legacy role "pal", same inference_id and
 * same speech. Only one of the pair may reach the transcript, and it must be
 * labelled as the avatar, never as the candidate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TavusProvider } from '~/app/providers/tavus'

const PHRASES = { endPhrase: 'Passiamo alla prossima domanda.', finalPhrase: 'Grazie.' }

type Handler = (data: unknown) => void

function setup() {
  const handlers = new Map<string, Handler[]>()
  const frame = {
    on: vi.fn((event: string, cb: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), cb])
    }),
    join: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
  const provider = new TavusProvider(vi.fn().mockResolvedValue(frame))
  const transcripts: { role: string; text: string }[] = []
  const states: string[] = []
  provider.on('transcript', (t) => transcripts.push(t as { role: string; text: string }))
  provider.on('state', (s) => states.push(s as string))

  const send = (role: string, speech: string, extra: Record<string, unknown> = {}) => {
    for (const cb of handlers.get('app-message') ?? []) {
      cb({
        data: {
          message_type: 'conversation',
          event_type: 'conversation.utterance',
          properties: { role, speech },
          ...extra,
        },
      })
    }
  }
  const start = () =>
    provider.start(document.createElement('div'), {
      dbSessionId: 1,
      conversationUrl: 'https://tavus.daily.co/x',
      ...PHRASES,
    })

  return { provider, transcripts, states, send, start }
}

describe('TavusProvider legacy "pal" duplicate', () => {
  let ctx: ReturnType<typeof setup>

  beforeEach(async () => {
    ctx = setup()
    await ctx.start()
  })

  it('emits ONE avatar transcript for a replica+pal pair with the same inference_id', () => {
    ctx.send('replica', 'Raccontami di un conflitto.', { inference_id: 'a' })
    ctx.send('pal', 'Raccontami di un conflitto.', { inference_id: 'a' })

    expect(ctx.transcripts).toEqual([
      expect.objectContaining({ role: 'avatar', text: 'Raccontami di un conflitto.' }),
    ])
  })

  it('fires complete ONCE when the pair carries the end phrase', () => {
    ctx.send('replica', PHRASES.endPhrase, { inference_id: 'e' })
    ctx.send('pal', PHRASES.endPhrase, { inference_id: 'e' })

    expect(ctx.states.filter((s) => s === 'complete')).toHaveLength(1)
    expect(ctx.transcripts).toHaveLength(1)
  })

  it('handles pal arriving BEFORE replica', () => {
    ctx.send('pal', 'Ciao.', { inference_id: 'b' })
    ctx.send('replica', 'Ciao.', { inference_id: 'b' })

    expect(ctx.transcripts).toEqual([expect.objectContaining({ role: 'avatar', text: 'Ciao.' })])
  })

  it('treats a lone pal as the avatar, never as the candidate', () => {
    ctx.send('pal', PHRASES.endPhrase, { inference_id: 'c' })

    expect(ctx.transcripts).toEqual([expect.objectContaining({ role: 'avatar' })])
    expect(ctx.states).toContain('complete')
  })

  it('leaves a real user utterance untouched, even with the avatar inference_id', () => {
    ctx.send('replica', 'Domanda?', { inference_id: 'd' })
    ctx.send('user', 'Domanda?', { inference_id: 'd' })

    expect(ctx.transcripts.map((t) => t.role)).toEqual(['avatar', 'user'])
  })

  it('passes two different inference_ids even with identical speech', () => {
    ctx.send('replica', 'Grazie.', { inference_id: 'x1' })
    ctx.send('pal', 'Grazie.', { inference_id: 'x1' })
    ctx.send('replica', 'Grazie.', { inference_id: 'x2' })
    ctx.send('pal', 'Grazie.', { inference_id: 'x2' })

    expect(ctx.transcripts.map((t) => t.role)).toEqual(['avatar', 'avatar'])
  })

  it('remembers only a bounded number of inference_ids', () => {
    ctx.send('replica', 'Primo.', { inference_id: 'old' })
    for (let i = 0; i < 60; i++) {
      ctx.send('replica', `Frase ${i}`, { inference_id: `n${i}` })
    }
    ctx.send('pal', 'Primo.', { inference_id: 'old' })

    // Evicted: the late copy is no longer recognised (bounded memory beats a leak).
    expect(ctx.transcripts.filter((t) => t.text === 'Primo.')).toHaveLength(2)
  })

  it('forgets seen utterances after stop()', async () => {
    ctx.send('replica', 'Ciao.', { inference_id: 'r' })
    await ctx.provider.stop()
    ctx.send('replica', 'Ciao.', { inference_id: 'r' })

    expect(ctx.transcripts).toHaveLength(2)
  })

  describe('without inference_id', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('drops the twin with the same speech and turn_idx', () => {
      ctx.send('replica', 'Ciao.', { turn_idx: 3 })
      ctx.send('pal', 'Ciao.', { turn_idx: 3 })

      expect(ctx.transcripts).toHaveLength(1)
    })

    it('drops the twin with the same speech inside the time window when turn_idx is absent', () => {
      ctx.send('replica', 'Ciao.')
      vi.advanceTimersByTime(500)
      ctx.send('pal', 'Ciao.')

      expect(ctx.transcripts).toHaveLength(1)
    })

    it('keeps the same speech once the window has passed', () => {
      ctx.send('replica', 'Ciao.')
      vi.advanceTimersByTime(5000)
      ctx.send('replica', 'Ciao.')

      expect(ctx.transcripts).toHaveLength(2)
    })

    it('keeps the same speech on a different turn_idx', () => {
      ctx.send('replica', 'Ciao.', { turn_idx: 1 })
      ctx.send('replica', 'Ciao.', { turn_idx: 2 })

      expect(ctx.transcripts).toHaveLength(2)
    })
  })
})
