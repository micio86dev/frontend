/**
 * A fake of the third provider's browser SDK, injected through the adapter's `sdkLoader`.
 *
 * Mirrors the three behaviours the adapter depends on: `on('state', h)` replays the current
 * state at once, `toggleMic()` flips and returns the new muted state synchronously, and
 * `end()` is a plain promise. `emit` drives any event from a test.
 */

import { vi } from 'vitest'

export type FakeEvent = 'state' | 'transcript' | 'error' | 'ended'
type Handler = (payload: unknown) => void

export function createFakeConversation() {
  const handlers: Record<FakeEvent, Handler[]> = { state: [], transcript: [], error: [], ended: [] }
  let state = 'connecting'
  let muted = false

  const conversation = {
    on: vi.fn((event: FakeEvent, handler: Handler) => {
      handlers[event].push(handler)
      if (event === 'state') handler(state)
      return () => undefined
    }),
    end: vi.fn(async () => undefined),
    setMicMuted: vi.fn(async (next: boolean) => {
      muted = next
    }),
    toggleMic: vi.fn(() => {
      muted = !muted
      return muted
    }),
    whenAvatarSilent: vi.fn((_ms: number) => new Promise<void>(() => {})),
    /** Delivers a payload to every subscriber of `event`. */
    emit(event: FakeEvent, payload: unknown) {
      for (const handler of handlers[event]) handler(payload)
    },
    /** Moves the SDK to `next` and tells the subscribers, as the real conversation does. */
    setState(next: string) {
      state = next
      conversation.emit('state', next)
    },
    get muted() {
      return muted
    },
  }
  return conversation
}

export type FakeConversation = ReturnType<typeof createFakeConversation>

/** A fake SDK module (`HrAvatar.connect`, like the package entry) that resolves the given (or a fresh) conversation. */
export function createFakeSdk(conversation: FakeConversation = createFakeConversation()) {
  const connect = vi.fn(async (_options: Record<string, unknown>) => conversation)
  const loader = vi.fn(async () => ({ HrAvatar: { connect } }) as never)
  return { conversation, connect, loader }
}

/** A final transcript entry shaped like the SDK's. */
export function transcriptEntry(role: 'user' | 'avatar', text: string, final = true) {
  return { role, text, final, occurredAt: '2026-10-19T12:00:00.000Z' }
}
