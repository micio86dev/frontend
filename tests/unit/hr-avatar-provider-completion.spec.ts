/**
 * HrAvatarProvider — completion and the terminal latch (hr-avatar-adapter, F2b).
 *
 * Two triggers can end a question: BEAI's own accent/case/punctuation-insensitive match of the
 * avatar's closing phrase (after a settle race), and the SDK ending with reason
 * `completion_phrase`. One per-start latch guarantees `complete` at most once and gives
 * `complete` and `error` precedence over `stopped`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HrAvatarProvider } from '~/app/providers/hr-avatar'
import type { StartConfig } from '~/app/types/interview-provider'
import { COMPLETION_SETTLE_MS, closingFallbackMs } from '~/app/utils/closing-completion'
import { createFakeSdk, transcriptEntry } from './fixtures/hr-avatar-fake-sdk'

const END_PHRASE = 'Passiamo alla prossima domanda.'
const FINAL_PHRASE = 'Grazie, abbiamo finito.'

function config(overrides: Partial<StartConfig> = {}): StartConfig {
  return {
    dbSessionId: 7,
    sessionToken: 'SECRET',
    hrAvatar: { baseUrl: 'https://hra.example.test', publishableKey: 'PK' },
    endPhrase: END_PHRASE,
    finalPhrase: FINAL_PHRASE,
    ...overrides,
  }
}

async function setup(cfg: StartConfig = config()) {
  const sdk = createFakeSdk()
  const provider = new HrAvatarProvider(sdk.loader)
  const states: unknown[] = []
  const errors: unknown[] = []
  provider.on('state', (s) => states.push(s))
  provider.on('error', (e) => errors.push(e))
  await provider.start(document.createElement('video'), cfg)

  /** Makes the next SDK silence wait controllable from the test. */
  let silent!: () => void
  sdk.conversation.whenAvatarSilent.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        silent = resolve
      })
  )
  return { ...sdk, provider, states, errors, silent: () => silent() }
}

const completes = (states: unknown[]) => states.filter((s) => s === 'complete').length
const stops = (states: unknown[]) => states.filter((s) => s === 'stopped').length

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('end and final phrase on the avatar line', () => {
  it('completes exactly once, after the SDK reports the settle window of silence', async () => {
    const { conversation, states, silent } = await setup()

    conversation.emit('transcript', transcriptEntry('avatar', 'passiamo alla prossima domanda'))
    await vi.advanceTimersByTimeAsync(0)

    expect(conversation.whenAvatarSilent).toHaveBeenCalledWith(COMPLETION_SETTLE_MS)
    expect(completes(states)).toBe(0)

    silent()
    await vi.advanceTimersByTimeAsync(0)

    expect(completes(states)).toBe(1)
  })

  it('completes after the lost-event fallback when the SDK never reports silence', async () => {
    const { conversation, states } = await setup()
    const line = 'Passiamo alla prossima domanda.'

    conversation.emit('transcript', transcriptEntry('avatar', line))
    await vi.advanceTimersByTimeAsync(closingFallbackMs(line) - 1)
    expect(completes(states)).toBe(0)

    await vi.advanceTimersByTimeAsync(1)

    expect(completes(states)).toBe(1)
  })

  it('also matches the final phrase', async () => {
    const { conversation, states, silent } = await setup()

    conversation.emit('transcript', transcriptEntry('avatar', 'Grazie abbiamo finito'))
    silent()
    await vi.advanceTimersByTimeAsync(0)

    expect(completes(states)).toBe(1)
  })

  it.each([
    ['upper case and punctuation', 'PASSIAMO ALLA PROSSIMA DOMANDA!!!'],
    ['a longer sentence around it', 'Bene. Passiamo alla prossima domanda, se per lei va bene.'],
  ])('tolerates %s', async (_name, line) => {
    const { conversation, states, silent } = await setup()

    conversation.emit('transcript', transcriptEntry('avatar', line))
    silent()
    await vi.advanceTimersByTimeAsync(0)

    expect(completes(states)).toBe(1)
  })

  it('tolerates accents', async () => {
    const { conversation, states, silent } = await setup(
      config({ endPhrase: 'È ora della prossima domanda.' })
    )

    conversation.emit('transcript', transcriptEntry('avatar', 'e ora della prossima domanda'))
    silent()
    await vi.advanceTimersByTimeAsync(0)

    expect(completes(states)).toBe(1)
  })

  it('never completes on the candidate line, however long it waits', async () => {
    const { conversation, states } = await setup()

    conversation.emit('transcript', transcriptEntry('user', END_PHRASE))
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(conversation.whenAvatarSilent).not.toHaveBeenCalled()
    expect(completes(states)).toBe(0)
  })

  it('ignores an avatar line that does not carry a phrase, and an interim one that does', async () => {
    const { conversation, states } = await setup()

    conversation.emit('transcript', transcriptEntry('avatar', 'Mi racconti un esempio.'))
    conversation.emit('transcript', transcriptEntry('avatar', END_PHRASE, false))
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(completes(states)).toBe(0)
  })

  it('a second phrase line while the first is settling does not complete twice', async () => {
    const { conversation, states, silent } = await setup()

    conversation.emit('transcript', transcriptEntry('avatar', END_PHRASE))
    conversation.emit('transcript', transcriptEntry('avatar', END_PHRASE))
    silent()
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(completes(states)).toBe(1)
  })
})

describe('SDK ended reasons', () => {
  it('completion_phrase completes', async () => {
    const { conversation, states } = await setup()

    conversation.emit('ended', { reason: 'completion_phrase' })

    expect(completes(states)).toBe(1)
    expect(stops(states)).toBe(0)
  })

  it.each(['user', 'server', 'provider'])('%s stops without completing', async (reason) => {
    const { conversation, states } = await setup()

    conversation.emit('ended', { reason })
    await vi.advanceTimersByTimeAsync(0)

    expect(completes(states)).toBe(0)
    expect(stops(states)).toBe(1)
  })

  it('error is an error event, not a stop', async () => {
    const { conversation, states, errors } = await setup()

    conversation.emit('ended', { reason: 'error' })
    await vi.advanceTimersByTimeAsync(0)

    expect(errors).toEqual([{ code: 'sdk_error', message: 'provider_unavailable' }])
    expect(stops(states)).toBe(0)
  })
})

describe('terminal latch', () => {
  it('both triggers emit complete exactly once', async () => {
    const { conversation, states, silent } = await setup()

    conversation.emit('transcript', transcriptEntry('avatar', END_PHRASE))
    conversation.emit('ended', { reason: 'completion_phrase' })
    silent()
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(completes(states)).toBe(1)
    expect(stops(states)).toBe(0)
  })

  it('state ended then ended(completion_phrase) in the same tick completes, with no stopped', async () => {
    const { conversation, states } = await setup()

    conversation.setState('ended')
    conversation.emit('ended', { reason: 'completion_phrase' })
    await vi.advanceTimersByTimeAsync(0)

    expect(completes(states)).toBe(1)
    expect(stops(states)).toBe(0)
  })

  it('ended(completion_phrase) then state ended completes, with no stopped', async () => {
    const { conversation, states } = await setup()

    conversation.emit('ended', { reason: 'completion_phrase' })
    conversation.setState('ended')
    await vi.advanceTimersByTimeAsync(0)

    expect(completes(states)).toBe(1)
    expect(stops(states)).toBe(0)
  })

  it('ended(provider) while a phrase match is settling completes at once, with no stopped', async () => {
    const { conversation, states, silent } = await setup()

    conversation.emit('transcript', transcriptEntry('avatar', END_PHRASE))
    conversation.emit('ended', { reason: 'provider' })
    conversation.setState('ended')
    await vi.advanceTimersByTimeAsync(0)

    expect(completes(states)).toBe(1)
    expect(stops(states)).toBe(0)

    silent()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(completes(states)).toBe(1)
  })

  it('an SDK error then state ended is an error, with no stopped', async () => {
    const { conversation, states, errors } = await setup()

    conversation.emit('error', { code: 'transport_error' })
    conversation.setState('ended')
    await vi.advanceTimersByTimeAsync(0)

    expect(errors).toHaveLength(1)
    expect(stops(states)).toBe(0)
  })

  it('an error state followed by ended(error) is one error', async () => {
    const { conversation, errors } = await setup()

    conversation.setState('error')
    conversation.emit('ended', { reason: 'error' })
    await vi.advanceTimersByTimeAsync(0)

    expect(errors).toHaveLength(1)
  })

  it('ended(user) then state ended emits exactly one stopped', async () => {
    const { conversation, states } = await setup()

    conversation.emit('ended', { reason: 'user' })
    conversation.setState('ended')
    await vi.advanceTimersByTimeAsync(0)

    expect(stops(states)).toBe(1)
  })

  it('nothing follows a stop: a later completion phrase or error is ignored', async () => {
    const { conversation, states, errors } = await setup()

    conversation.emit('ended', { reason: 'user' })
    conversation.emit('transcript', transcriptEntry('avatar', END_PHRASE))
    conversation.emit('error', { code: 'x' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(conversation.whenAvatarSilent).not.toHaveBeenCalled()
    expect(completes(states)).toBe(0)
    expect(errors).toHaveLength(0)
  })

  it('the latch resets on a new start(): the next question can complete again', async () => {
    const { conversation, states, connect, provider } = await setup()
    conversation.emit('ended', { reason: 'completion_phrase' })
    expect(completes(states)).toBe(1)

    const second = createFakeSdk()
    connect.mockResolvedValueOnce(second.conversation)
    await provider.start(document.createElement('video'), config())
    second.conversation.emit('ended', { reason: 'completion_phrase' })

    expect(completes(states)).toBe(2)
  })

  it('a stopped deferred by an old start() does not land on the new one', async () => {
    const { conversation, states, connect, provider } = await setup()
    conversation.setState('ended')

    const second = createFakeSdk()
    connect.mockResolvedValueOnce(second.conversation)
    await provider.start(document.createElement('video'), config())
    await vi.advanceTimersByTimeAsync(0)

    expect(stops(states)).toBe(0)
  })
})
