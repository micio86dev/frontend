/**
 * The utterance outbox keeps transcript lines that could not be delivered, in order,
 * and sends them once the network is back. Order matters: a late line must never
 * reach the server before an earlier one.
 */

import { describe, it, expect, vi } from 'vitest'
import { UtteranceOutbox, type PendingUtterance } from '~/app/utils/utterance-outbox'

const line = (text: string): PendingUtterance => ({
  session: 7,
  speaker: 'candidate',
  text,
  ts: '2026-10-12T10:00:00.000Z',
})

describe('UtteranceOutbox', () => {
  it('starts empty and counts what it holds', () => {
    const outbox = new UtteranceOutbox()
    expect(outbox.size).toBe(0)
    outbox.enqueue(line('a'))
    outbox.enqueue(line('b'))
    expect(outbox.size).toBe(2)
  })

  it('delivers in the order they were queued', async () => {
    const outbox = new UtteranceOutbox()
    outbox.enqueue(line('first'))
    outbox.enqueue(line('second'))
    const sent: string[] = []

    const delivered = await outbox.flush(async (item) => {
      sent.push(item.text)
      return true
    })

    expect(delivered).toBe(2)
    expect(sent).toEqual(['first', 'second'])
    expect(outbox.size).toBe(0)
  })

  it('stops at the first line that still cannot be sent, keeping it and everything after it', async () => {
    const outbox = new UtteranceOutbox()
    outbox.enqueue(line('a'))
    outbox.enqueue(line('b'))
    outbox.enqueue(line('c'))
    const send = vi.fn(async (item: PendingUtterance) => item.text === 'a')

    const delivered = await outbox.flush(send)

    expect(delivered).toBe(1)
    expect(send).toHaveBeenCalledTimes(2)
    expect(outbox.size).toBe(2)
  })

  it('never sends a line twice when a second flush starts while the first is still sending', async () => {
    const outbox = new UtteranceOutbox()
    outbox.enqueue(line('a'))
    const sent: string[] = []
    const slowSend = async (item: PendingUtterance) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      sent.push(item.text)
      return true
    }

    const first = outbox.flush(slowSend)
    const second = outbox.flush(slowSend)
    await Promise.all([first, second])

    expect(sent).toEqual(['a'])
    expect(outbox.size).toBe(0)
  })

  it('does nothing when empty', async () => {
    const send = vi.fn(async () => true)
    expect(await new UtteranceOutbox().flush(send)).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })
})
