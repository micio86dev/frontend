/**
 * HrAvatarProvider — a stale connect result and non-terminal SDK states
 * (hr-avatar-adapter, F1 cleanup R3-003 / R3-004).
 *
 * A start() whose connect resolves after a newer start() must release its conversation
 * instead of wiring it, and only the SDK's explicit `error` state is a terminal failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HrAvatarProvider } from '~/app/providers/hr-avatar'
import type { StartConfig } from '~/app/types/interview-provider'
import { createFakeConversation, createFakeSdk } from './fixtures/hr-avatar-fake-sdk'

const config: StartConfig = {
  dbSessionId: 7,
  sessionToken: 'CS',
  hrAvatar: { baseUrl: 'https://hra.example.test', publishableKey: 'PK' },
  endPhrase: 'Passiamo alla prossima domanda.',
  finalPhrase: 'Grazie, abbiamo finito.',
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** A provider whose first connect waits for `release*`, and whose later connects resolve at once. */
function racing() {
  const stale = createFakeConversation()
  const fresh = createFakeConversation()
  const sdk = createFakeSdk(fresh)
  let releaseStale!: () => void
  let failStale!: (error: unknown) => void
  sdk.connect.mockImplementationOnce(
    () =>
      new Promise((resolve, reject) => {
        releaseStale = () => resolve(stale)
        failStale = reject
      })
  )
  const provider = new HrAvatarProvider(sdk.loader)
  const errors: unknown[] = []
  const states: unknown[] = []
  provider.on('error', (e) => errors.push(e))
  provider.on('state', (s) => states.push(s))
  const mount = document.createElement('video')
  return {
    provider,
    stale,
    fresh,
    errors,
    states,
    mount,
    releaseStale: () => releaseStale(),
    failStale: (e: unknown) => failStale(e),
  }
}

describe('a stale connect result', () => {
  it('is ended and never wired when a newer start() happened while it connected', async () => {
    const { provider, stale, fresh, mount, releaseStale } = racing()
    const first = provider.start(mount, config)
    await vi.advanceTimersByTimeAsync(0)

    await provider.start(mount, config)
    releaseStale()
    await first

    expect(stale.end).toHaveBeenCalledTimes(1)
    expect(stale.on).not.toHaveBeenCalled()
    // The newer conversation stays the live one: the mic controls reach it, not the stale one.
    await provider.setMicMuted(true)
    expect(fresh.setMicMuted).toHaveBeenCalledWith(true)
    expect(stale.setMicMuted).not.toHaveBeenCalled()
    expect(fresh.end).not.toHaveBeenCalled()
  })

  it('is ended and never wired when stop() and a newer start() both happened meanwhile', async () => {
    const { provider, stale, fresh, mount, releaseStale } = racing()
    const first = provider.start(mount, config)
    await vi.advanceTimersByTimeAsync(0)

    await provider.stop()
    await provider.start(mount, config)
    releaseStale()
    await first

    expect(stale.end).toHaveBeenCalledTimes(1)
    expect(stale.on).not.toHaveBeenCalled()
    expect(fresh.on).toHaveBeenCalled()
  })

  it('a stale connect failure does not fail the newer start', async () => {
    const { provider, errors, mount, failStale } = racing()
    const first = provider.start(mount, config)
    await vi.advanceTimersByTimeAsync(0)

    await provider.start(mount, config)
    failStale(Object.assign(new Error('late'), { code: 'origin_not_allowed' }))
    await first

    expect(errors).toEqual([])
  })
})

describe('SDK states', () => {
  it.each(['reconnecting', 'paused', 'something-new'])(
    'ignores the unknown state %s and keeps the conversation usable',
    async (unknown) => {
      const sdk = createFakeSdk()
      const provider = new HrAvatarProvider(sdk.loader)
      const states: unknown[] = []
      const errors: unknown[] = []
      provider.on('state', (s) => states.push(s))
      provider.on('error', (e) => errors.push(e))
      await provider.start(document.createElement('video'), config)

      sdk.conversation.setState(unknown)
      sdk.conversation.setState('live')
      sdk.conversation.setState('ended')
      await vi.advanceTimersByTimeAsync(0)

      expect(errors).toEqual([])
      expect(states).toEqual(['connecting', 'ready', 'stopped'])
    }
  )
})
