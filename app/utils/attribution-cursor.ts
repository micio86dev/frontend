/**
 * AttributionCursor — which DB interview session the live conversation's
 * transcript, integrity events, snapshots, `/end` and `/suspend` belong to
 * RIGHT NOW (tavus-single-session-interview, A2 / N4).
 *
 * Why it exists. Today a provider handle serves exactly one competency row, so
 * the handle's creation-time `dbSessionId` and "the row we are attributing to"
 * are the same number and were read interchangeably. In a single-conversation
 * flow one handle serves several rows, and the two diverge: the handle is the
 * CALL OBJECT (the player key, never changes), the cursor is the COMPETENCY
 * (moves). Every reader of "the current session id" must read the cursor, at the
 * moment it needs the value — never capture it when wiring an event handler.
 *
 * The ordering rule. `advance()` is the only writer. The cursor MUST be written
 * BEFORE any boundary signal is sent to the provider: a transcript line that
 * arrives between the write and the signal then lands on the new row, and one
 * that arrived earlier landed on the old row. Writing after the send would let
 * the new competency's first words be attributed to the old one. `advance()`
 * returns an {@link AdvanceTicket}, the capability a boundary sender requires, so
 * "send before moving the cursor" is not expressible rather than merely
 * discouraged.
 *
 * Input contract. A session id is a positive safe integer (it is a DB primary
 * key). Anything else — NaN, 0, a negative, a fraction — is refused with a
 * `RangeError` at the write, before it can be POSTed as `session_id` and rejected
 * by the API far from the cause. A refused `advance()` leaves the cursor where it
 * was. Advancing to the id the cursor already holds is an idempotent no-op that
 * still returns a ticket, so a caller that re-asserts the current row is not
 * forced to special-case it.
 */

declare const ticketBrand: unique symbol

/** Proof that the cursor has already moved to `sessionId`. Only `advance()` mints one. */
export interface AdvanceTicket {
  readonly [ticketBrand]: true
  readonly sessionId: number
}

/** Throws `RangeError` unless `id` is a positive safe integer. */
export function assertSessionId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new RangeError(
      `Invalid interview session id: ${String(id)} (expected a positive integer)`
    )
  }
}

export class AttributionCursor {
  #id: number

  constructor(initial: number) {
    assertSessionId(initial)
    this.#id = initial
  }

  /** Read at EMIT time by every consumer; never cache it. */
  get current(): number {
    return this.#id
  }

  /**
   * The ONLY writer, and the ONLY minter of {@link AdvanceTicket}. Throws
   * `RangeError` (cursor unchanged) for an invalid id; the same id is a no-op
   * that still returns a ticket.
   */
  advance(nextSessionId: number): AdvanceTicket {
    assertSessionId(nextSessionId)
    this.#id = nextSessionId
    return { sessionId: nextSessionId } as AdvanceTicket
  }
}
