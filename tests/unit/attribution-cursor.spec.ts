/**
 * AttributionCursor — the single holder of "which DB interview session the
 * transcript, integrity events, snapshots, /end and /suspend belong to right
 * now" (tavus-single-session-interview, A2 / N4).
 */

import { describe, it, expect } from 'vitest'
import { AttributionCursor } from '~/app/utils/attribution-cursor'

describe('AttributionCursor', () => {
  it('starts on the session it was created for', () => {
    expect(new AttributionCursor(42).current).toBe(42)
  })

  it('advance() moves current and returns a ticket naming the new session', () => {
    const cursor = new AttributionCursor(42)

    const ticket = cursor.advance(77)

    expect(cursor.current).toBe(77)
    expect(ticket.sessionId).toBe(77)
  })

  it('advance() is the only writer: current has no setter', () => {
    const cursor = new AttributionCursor(42)

    expect(() => {
      // @ts-expect-error `current` is read-only; advance() is the single mutator
      cursor.current = 99
    }).toThrow()
    expect(cursor.current).toBe(42)
  })

  it('two cursors never share state', () => {
    const a = new AttributionCursor(1)
    const b = new AttributionCursor(1)

    a.advance(2)

    expect(b.current).toBe(1)
  })
})
