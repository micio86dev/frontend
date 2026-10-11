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

// ---------------------------------------------------------------------------
// Input contract (FE-03 follow-up): a session id is a positive safe integer; an
// invalid id is refused at the write, and advancing to the same id is a no-op
// that still returns a ticket.
// ---------------------------------------------------------------------------

const INVALID_IDS: Array<[string, number]> = [
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['zero', 0],
  ['a negative id', -3],
  ['a fractional id', 4.5],
  ['an id beyond the safe integer range', Number.MAX_SAFE_INTEGER + 2],
]

describe('AttributionCursor — construction', () => {
  it('starts on a valid initial id', () => {
    expect(new AttributionCursor(42).current).toBe(42)
  })

  it.each(INVALID_IDS)('rejects %s as the initial id', (_label, id) => {
    expect(() => new AttributionCursor(id)).toThrow(RangeError)
  })

  it('names the offending value in the error', () => {
    expect(() => new AttributionCursor(-3)).toThrow(/-3/)
  })
})

describe('AttributionCursor — advance', () => {
  it('moves to a new valid id and mints a ticket carrying it', () => {
    const cursor = new AttributionCursor(42)

    const ticket = cursor.advance(77)

    expect(cursor.current).toBe(77)
    expect(ticket.sessionId).toBe(77)
  })

  it.each(INVALID_IDS)('rejects %s and leaves the cursor where it was', (_label, id) => {
    const cursor = new AttributionCursor(42)

    expect(() => cursor.advance(id)).toThrow(RangeError)

    expect(cursor.current).toBe(42)
  })

  it('advancing to the SAME id is an idempotent no-op that still returns a ticket', () => {
    const cursor = new AttributionCursor(42)

    const ticket = cursor.advance(42)

    expect(cursor.current).toBe(42)
    expect(ticket.sessionId).toBe(42)
    expect(cursor.advance(42).sessionId).toBe(42)
  })
})
