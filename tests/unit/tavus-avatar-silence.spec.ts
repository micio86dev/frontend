/**
 * TavusProvider.whenAvatarSilent — resolves only once the avatar has been
 * continuously silent for the settle window, so the primary-question boundary
 * never cuts the avatar's last sentence.
 *
 * Races covered: the avatar `conversation.utterance` arriving BEFORE
 * `started_speaking`, a mid-sentence TTS pause shorter than the settle window,
 * and a lost `stopped_speaking` (bounded by the max).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  TavusProvider,
  AVATAR_SETTLE_MS,
  AVATAR_UTTERANCE_PENDING_MS,
  COMPLETION_FALLBACK_MS,
} from '~/app/providers/tavus'

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
  const msg = (data: unknown) => (handlers.get('app-message') ?? []).forEach((cb) => cb({ data }))

  return {
    provider,
    start: () =>
      provider.start(document.createElement('div'), {
        dbSessionId: 1,
        conversationUrl: 'https://tavus.daily.co/x',
        endPhrase: 'Next.',
        finalPhrase: 'Thanks.',
      }),
    started: () => msg({ event_type: 'conversation.replica.started_speaking' }),
    stopped: () => msg({ event_type: 'conversation.replica.stopped_speaking' }),
    avatarUtterance: (role = 'replica') =>
      msg({
        event_type: 'conversation.utterance',
        properties: { role, speech: `Sentence ${Math.random()}` },
      }),
  }
}

/** Track settlement without awaiting it. */
function watch(p: Promise<void>) {
  const state = { done: false }
  void p.then(() => (state.done = true))

  return state
}

describe('TavusProvider.whenAvatarSilent', () => {
  let ctx: ReturnType<typeof setup>

  beforeEach(async () => {
    vi.useFakeTimers()
    ctx = setup()
    await ctx.start()
  })
  afterEach(() => vi.useRealTimers())

  it('resolves after the settle window when the avatar never spoke', async () => {
    const w = watch(ctx.provider.whenAvatarSilent())

    await vi.advanceTimersByTimeAsync(AVATAR_SETTLE_MS - 1)
    expect(w.done).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(w.done).toBe(true)
  })

  it('normal stop: waits for stopped_speaking, then the settle window', async () => {
    ctx.started()
    const w = watch(ctx.provider.whenAvatarSilent())

    await vi.advanceTimersByTimeAsync(5_000)
    expect(w.done).toBe(false)

    ctx.stopped()
    await vi.advanceTimersByTimeAsync(AVATAR_SETTLE_MS - 1)
    expect(w.done).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(w.done).toBe(true)
  })

  it('an avatar utterance BEFORE started_speaking counts as speaking-pending', async () => {
    ctx.avatarUtterance()
    const w = watch(ctx.provider.whenAvatarSilent())

    // Past the settle window, still pending: the audio has not started yet.
    await vi.advanceTimersByTimeAsync(AVATAR_SETTLE_MS + 100)
    expect(w.done).toBe(false)

    ctx.started()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(w.done).toBe(false)

    ctx.stopped()
    await vi.advanceTimersByTimeAsync(AVATAR_SETTLE_MS)
    expect(w.done).toBe(true)
  })

  it('a pending utterance that never gets audio cannot hang the gate', async () => {
    ctx.avatarUtterance()
    const w = watch(ctx.provider.whenAvatarSilent())

    await vi.advanceTimersByTimeAsync(AVATAR_UTTERANCE_PENDING_MS + AVATAR_SETTLE_MS)
    expect(w.done).toBe(true)
  })

  it('a mid-sentence pause shorter than the settle window does not release', async () => {
    ctx.started()
    const w = watch(ctx.provider.whenAvatarSilent())

    ctx.stopped()
    await vi.advanceTimersByTimeAsync(AVATAR_SETTLE_MS - 100)
    expect(w.done).toBe(false)

    ctx.started() // TTS resumes inside the window
    await vi.advanceTimersByTimeAsync(AVATAR_SETTLE_MS * 4)
    expect(w.done).toBe(false)

    ctx.stopped()
    await vi.advanceTimersByTimeAsync(AVATAR_SETTLE_MS)
    expect(w.done).toBe(true)
  })

  it('resolves at the max when stopped_speaking is lost', async () => {
    ctx.started()
    const w = watch(ctx.provider.whenAvatarSilent())

    await vi.advanceTimersByTimeAsync(COMPLETION_FALLBACK_MS - 1)
    expect(w.done).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(w.done).toBe(true)
  })

  it('honours a custom max', async () => {
    ctx.started()
    const w = watch(ctx.provider.whenAvatarSilent(1_000))

    await vi.advanceTimersByTimeAsync(1_000)
    expect(w.done).toBe(true)
  })

  it('stop() releases a waiting gate', async () => {
    ctx.started()
    const w = watch(ctx.provider.whenAvatarSilent())

    await ctx.provider.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.done).toBe(true)
  })
})
