/**
 * createProvider — the flag-gated `hr_avatar` arm (hr-avatar-adapter, F3).
 *
 * With the runtime flag off (the default) the arm falls through to the existing
 * unknown-provider error and nothing new is loaded. With it on, `createProvider` still
 * returns synchronously: a small deferred handle that imports the adapter on `start()`.
 *
 * The flag is the RUNTIME value, after Nuxt coerced the environment string with `destr`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { destr } from 'destr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProvider } from '~/app/providers/factory'
import { HeyGenProvider } from '~/app/providers/heygen'
import { TavusProvider } from '~/app/providers/tavus'
import type { StartConfig } from '~/app/types/interview-provider'

const UNKNOWN_PROVIDER_TEXT =
  "[createProvider] Unknown provider: \"hr_avatar\". Expected 'heygen' or 'tavus'."

const cfg: StartConfig = { dbSessionId: 1, endPhrase: 'a', finalPhrase: 'b' }

let adapterEvaluated = false
let sdkImported = false

/** A stand-in adapter module that records how it is driven. */
function mockAdapterModule() {
  const calls: string[] = []
  const instances: Array<{ subscriptions: Array<[string, unknown]> }> = []
  class FakeAdapter {
    subscriptions: Array<[string, unknown]> = []
    constructor() {
      instances.push(this)
    }
    on(evt: string, cb: unknown) {
      calls.push(`on:${evt}`)
      this.subscriptions.push([evt, cb])
    }
    async start() {
      calls.push('start')
      return { providerSessionId: 'adapter-session' }
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
    async whenAvatarSilent(maxMs?: number) {
      calls.push(`whenAvatarSilent:${maxMs}`)
    }
  }
  vi.doMock('~/app/providers/hr-avatar', () => {
    adapterEvaluated = true
    return { HrAvatarProvider: FakeAdapter }
  })
  return { calls, instances }
}

function stubFlag(value: unknown) {
  const useRuntimeConfig = vi.fn(() => ({ public: { hrAvatarEnabled: value } }))
  vi.stubGlobal('useRuntimeConfig', useRuntimeConfig)
  return useRuntimeConfig
}

beforeEach(() => {
  adapterEvaluated = false
  sdkImported = false
  vi.doMock('@hr-avatar/sdk', () => {
    sdkImported = true
    return { HrAvatar: { connect: vi.fn() } }
  })
})

afterEach(() => {
  vi.doUnmock('~/app/providers/hr-avatar')
  vi.doUnmock('@hr-avatar/sdk')
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('flag off', () => {
  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['the number 1', 1],
    ["the string '1'", '1'],
    ["the string 'yes'", 'yes'],
    ['false', false],
    ["the string 'false'", 'false'],
  ])('%s fails closed with the existing unknown-provider error', (_name, value) => {
    mockAdapterModule()
    stubFlag(value)

    expect(() => createProvider('hr_avatar', false)).toThrow(UNKNOWN_PROVIDER_TEXT)
    expect(adapterEvaluated).toBe(false)
    expect(sdkImported).toBe(false)
  })

  it('an unknown name keeps the same error text, whatever the flag', () => {
    stubFlag(true)

    expect(() => createProvider('nope' as 'heygen', false)).toThrow(
      "[createProvider] Unknown provider: \"nope\". Expected 'heygen' or 'tavus'."
    )
  })
})

describe('flag on', () => {
  it.each([
    ['boolean true', true],
    ["the string 'true'", 'true'],
  ])('%s returns a provider synchronously without loading the adapter or the SDK', (_n, value) => {
    mockAdapterModule()
    stubFlag(value)

    const provider = createProvider('hr_avatar', false)

    expect(typeof provider.start).toBe('function')
    expect(typeof provider.stop).toBe('function')
    expect(typeof provider.on).toBe('function')
    expect(typeof provider.toggleMic).toBe('function')
    expect(typeof provider.setMicMuted).toBe('function')
    expect(typeof provider.whenAvatarSilent).toBe('function')
    expect(adapterEvaluated).toBe(false)
    expect(sdkImported).toBe(false)
  })

  it('Nuxt coerces the environment string before the flag is read: TRUE arrives as boolean true', () => {
    expect(destr('true')).toBe(true)
    expect(destr('TRUE')).toBe(true)
    expect(destr('True')).toBe(true)
    expect(destr('1')).toBe(1)
    expect(destr('yes')).toBe('yes')
    expect(destr('')).toBe('')
  })
})

describe('mock and existing providers', () => {
  it('mock wins for hr_avatar and the flag is not read', () => {
    const useRuntimeConfig = stubFlag(false)

    const provider = createProvider('hr_avatar', true)

    // `emitEndPhrase` exists on the in-memory mock only.
    expect(typeof (provider as { emitEndPhrase?: unknown }).emitEndPhrase).toBe('function')
    expect(useRuntimeConfig).not.toHaveBeenCalled()
  })

  it.each([true, false])('heygen and tavus are unchanged with the flag %s', (flag) => {
    const useRuntimeConfig = stubFlag(flag)

    expect(createProvider('heygen', false)).toBeInstanceOf(HeyGenProvider)
    expect(createProvider('tavus', false)).toBeInstanceOf(TavusProvider)
    // The flag is read inside the hr_avatar arm only.
    expect(useRuntimeConfig).not.toHaveBeenCalled()
  })

  it('factory.ts has no static import of the adapter or the SDK', () => {
    const source = readFileSync(join(process.cwd(), 'app', 'providers', 'factory.ts'), 'utf8')
    const importLines = source
      .split('\n')
      .filter((line) => /^import\s/.test(line))
      .join('\n')

    expect(importLines).not.toMatch(/hr-avatar/)
  })
})

describe('deferred handle', () => {
  it('buffers subscriptions and replays them, in order, after the adapter loads', async () => {
    const { calls, instances } = mockAdapterModule()
    stubFlag(true)
    const provider = createProvider('hr_avatar', false)
    const onState = vi.fn()
    const onError = vi.fn()
    provider.on('state', onState)
    provider.on('error', onError)
    expect(instances).toHaveLength(0)

    await provider.start(document.createElement('video'), cfg)

    expect(adapterEvaluated).toBe(true)
    expect(instances).toHaveLength(1)
    expect(instances[0]!.subscriptions).toEqual([
      ['state', onState],
      ['error', onError],
    ])
    expect(calls).toEqual(['on:state', 'on:error', 'start'])
  })

  it('a subscription made after the load goes straight to the adapter', async () => {
    const { calls } = mockAdapterModule()
    stubFlag(true)
    const provider = createProvider('hr_avatar', false)
    await provider.start(document.createElement('video'), cfg)
    calls.length = 0

    provider.on('transcript', vi.fn())

    expect(calls).toEqual(['on:transcript'])
  })

  it('start resolves with the adapter result', async () => {
    mockAdapterModule()
    stubFlag(true)
    const provider = createProvider('hr_avatar', false)

    await expect(provider.start(document.createElement('video'), cfg)).resolves.toEqual({
      providerSessionId: 'adapter-session',
    })
  })

  it('stop, toggleMic and setMicMuted before the load are no-ops that never load it', async () => {
    const { calls } = mockAdapterModule()
    stubFlag(true)
    const provider = createProvider('hr_avatar', false)

    await provider.stop()
    await provider.toggleMic()
    await provider.setMicMuted(true)

    expect(calls).toEqual([])
    expect(adapterEvaluated).toBe(false)
  })

  it('whenAvatarSilent before the load resolves without loading the adapter', async () => {
    mockAdapterModule()
    stubFlag(true)
    const provider = createProvider('hr_avatar', false)

    await expect(provider.whenAvatarSilent?.(5000)).resolves.toBeUndefined()

    expect(adapterEvaluated).toBe(false)
  })

  it('delegates the controls to the adapter once it has loaded', async () => {
    const { calls } = mockAdapterModule()
    stubFlag(true)
    const provider = createProvider('hr_avatar', false)
    await provider.start(document.createElement('video'), cfg)
    calls.length = 0

    await provider.toggleMic()
    await provider.setMicMuted(true)
    await provider.whenAvatarSilent?.(1234)
    await provider.stop()

    expect(calls).toEqual(['toggleMic', 'setMicMuted:true', 'whenAvatarSilent:1234', 'stop'])
  })

  it('a stop() that lands before the load finishes prevents the adapter from starting', async () => {
    const { calls } = mockAdapterModule()
    stubFlag(true)
    const provider = createProvider('hr_avatar', false)

    const starting = provider.start(document.createElement('video'), cfg)
    await provider.stop()
    await starting

    expect(calls).not.toContain('start')
  })

  it('a rejected adapter import emits a stable sdk_error and resolves an empty start', async () => {
    vi.doMock('~/app/providers/hr-avatar', () => {
      throw new Error('chunk failed to load: https://hra.example.test')
    })
    stubFlag(true)
    const provider = createProvider('hr_avatar', false)
    const errors: unknown[] = []
    provider.on('error', (e) => errors.push(e))

    await expect(provider.start(document.createElement('video'), cfg)).resolves.toEqual({})

    expect(errors).toEqual([{ code: 'sdk_error', message: 'provider_unavailable' }])
  })
})
