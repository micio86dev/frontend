/**
 * The deferred hr_avatar handle — a mic choice made before the adapter has connected is
 * remembered and applied once it has, and the factory switch stays exhaustive
 * (hr-avatar-adapter, F1 cleanup R3-005 / R3-006).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProvider } from '~/app/providers/factory'
import type { StartConfig } from '~/app/types/interview-provider'

const cfg: StartConfig = { dbSessionId: 1, endPhrase: 'a', finalPhrase: 'b' }

function mockAdapter() {
  const calls: string[] = []
  class FakeAdapter {
    on() {}
    async start() {
      calls.push('start')
      return {}
    }
    async stop() {
      calls.push('stop')
    }
    async toggleMic() {
      calls.push('toggleMic')
    }
    async setMicMuted(muted: boolean) {
      calls.push(`setMicMuted:${muted}`)
    }
  }
  vi.doMock('~/app/providers/hr-avatar', () => ({ HrAvatarProvider: FakeAdapter }))
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { hrAvatarEnabled: true } }))
  return calls
}

afterEach(() => {
  vi.doUnmock('~/app/providers/hr-avatar')
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('a mic choice made before the adapter has connected', () => {
  it('a mute chosen before start() is applied once start() has resolved', async () => {
    const calls = mockAdapter()
    const provider = createProvider('hr_avatar', false)

    await provider.setMicMuted(true)
    await provider.start(document.createElement('video'), cfg)

    expect(calls).toEqual(['start', 'setMicMuted:true'])
  })

  it('only the last choice is applied', async () => {
    const calls = mockAdapter()
    const provider = createProvider('hr_avatar', false)

    await provider.setMicMuted(true)
    await provider.setMicMuted(false)
    await provider.start(document.createElement('video'), cfg)

    expect(calls).toEqual(['start', 'setMicMuted:false'])
  })

  it('a toggle before start() counts as a mute choice', async () => {
    const calls = mockAdapter()
    const provider = createProvider('hr_avatar', false)

    await provider.toggleMic()
    await provider.start(document.createElement('video'), cfg)

    expect(calls).toEqual(['start', 'setMicMuted:true'])
  })

  it('is applied once: a later start() does not replay it', async () => {
    const calls = mockAdapter()
    const provider = createProvider('hr_avatar', false)
    await provider.setMicMuted(true)
    await provider.start(document.createElement('video'), cfg)
    calls.length = 0

    await provider.start(document.createElement('video'), cfg)

    expect(calls).toEqual(['start'])
  })

  it('is dropped when stop() landed first', async () => {
    const calls = mockAdapter()
    const provider = createProvider('hr_avatar', false)
    await provider.setMicMuted(true)

    const starting = provider.start(document.createElement('video'), cfg)
    await provider.stop()
    await starting

    expect(calls).not.toContain('setMicMuted:true')
  })
})

/** An adapter whose every start() stays connecting until the test releases it, in call order. */
function mockGatedAdapter() {
  const calls: string[] = []
  const gates: Array<() => void> = []
  class FakeAdapter {
    on() {}
    start() {
      calls.push('start')
      return new Promise<Record<string, never>>((resolve) => {
        gates.push(() => {
          calls.push('connected')
          resolve({})
        })
      })
    }
    async stop() {}
    async toggleMic() {
      calls.push('toggleMic')
    }
    async setMicMuted(muted: boolean) {
      calls.push(`setMicMuted:${muted}`)
    }
  }
  vi.doMock('~/app/providers/hr-avatar', () => ({ HrAvatarProvider: FakeAdapter }))
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { hrAvatarEnabled: true } }))
  return { calls, gates }
}

/** Waits until the handle's lazy import has run and `count` adapter starts are connecting. */
async function connecting(gates: unknown[], count: number) {
  await vi.waitFor(() => expect(gates).toHaveLength(count))
}

describe('a mic choice made while a later start() is connecting', () => {
  it('is queued during a re-start and applied once that start has resolved', async () => {
    const { calls, gates } = mockGatedAdapter()
    const provider = createProvider('hr_avatar', false)
    const first = provider.start(document.createElement('video'), cfg)
    await connecting(gates, 1)
    gates[0]!()
    await first

    const second = provider.start(document.createElement('video'), cfg)
    await connecting(gates, 2)
    await provider.setMicMuted(true)

    expect(calls).toEqual(['start', 'connected', 'start'])

    gates[1]!()
    await second

    expect(calls).toEqual(['start', 'connected', 'start', 'connected', 'setMicMuted:true'])
  })

  it('a toggle during a re-start is queued too', async () => {
    const { calls, gates } = mockGatedAdapter()
    const provider = createProvider('hr_avatar', false)
    const first = provider.start(document.createElement('video'), cfg)
    await connecting(gates, 1)
    gates[0]!()
    await first

    const second = provider.start(document.createElement('video'), cfg)
    await connecting(gates, 2)
    await provider.toggleMic()
    gates[1]!()
    await second

    expect(calls).toEqual(['start', 'connected', 'start', 'connected', 'setMicMuted:true'])
  })

  it('is applied by the newest start only, not by an older one that resolves later', async () => {
    const { calls, gates } = mockGatedAdapter()
    const provider = createProvider('hr_avatar', false)
    const older = provider.start(document.createElement('video'), cfg)
    await connecting(gates, 1)
    const newer = provider.start(document.createElement('video'), cfg)
    await connecting(gates, 2)
    await provider.setMicMuted(true)

    gates[0]!()
    await older

    expect(calls).toEqual(['start', 'start', 'connected'])

    gates[1]!()
    await newer

    expect(calls).toEqual(['start', 'start', 'connected', 'connected', 'setMicMuted:true'])
  })

  it('is forwarded at once after the latest start has resolved', async () => {
    const { calls, gates } = mockGatedAdapter()
    const provider = createProvider('hr_avatar', false)
    const first = provider.start(document.createElement('video'), cfg)
    await connecting(gates, 1)
    gates[0]!()
    await first

    await provider.setMicMuted(true)

    expect(calls).toEqual(['start', 'connected', 'setMicMuted:true'])
  })
})

describe('factory switch', () => {
  it('keeps the compile-time exhaustiveness check over ProviderName', () => {
    const source = readFileSync(join(process.cwd(), 'app', 'providers', 'factory.ts'), 'utf8')

    expect(source).toMatch(/default:\s*\{[^}]*const exhaustive: never = name/)
  })
})
