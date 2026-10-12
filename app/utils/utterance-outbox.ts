/**
 * Transcript lines that could not be delivered yet, kept in the order they were spoken.
 *
 * Held in memory only: a transcript line is personal data, so it is not written to any
 * browser store. A line still queued when the page is closed is lost, and that is a
 * known limit of this design.
 */

export interface PendingUtterance {
  session: number
  speaker: 'candidate' | 'avatar'
  text: string
  ts: string
}

export class UtteranceOutbox {
  private readonly items: PendingUtterance[] = []

  get size(): number {
    return this.items.length
  }

  enqueue(item: PendingUtterance): void {
    this.items.push(item)
  }

  /** Removes and returns the head line, for a line the server keeps refusing: the rest must not wait on it. */
  dropHead(): PendingUtterance | undefined {
    return this.items.shift()
  }

  /**
   * Sends the queued lines in order. `send` resolves true when a line is settled (delivered,
   * or refused for good) and false when it should be tried again. The first line that is not
   * settled stops the flush, so a later line can never reach the server before an earlier one.
   * Returns how many lines were settled.
   */
  async flush(send: (item: PendingUtterance) => Promise<boolean>): Promise<number> {
    // One flush at a time: a second call waits for the first, then sends what is still queued.
    // Two runs over the same head line would deliver it twice.
    const previous = this.running
    const run = (async () => {
      if (previous !== null) await previous.catch(() => 0)
      return this.drain(send)
    })()
    this.running = run
    try {
      return await run
    } finally {
      if (this.running === run) this.running = null
    }
  }

  private running: Promise<number> | null = null

  private async drain(send: (item: PendingUtterance) => Promise<boolean>): Promise<number> {
    let settled = 0
    while (this.items.length > 0) {
      const next = this.items[0]!
      const done = await send(next)
      if (!done) break
      this.items.shift()
      settled += 1
    }

    return settled
  }
}
