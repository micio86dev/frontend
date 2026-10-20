/**
 * HrAvatarProvider — adapter core (hr-avatar-adapter, F2a).
 *
 * A fake SDK is injected through the `sdkLoader`, so nothing here opens a connection.
 * Completion and the terminal latch live in hr-avatar-provider-completion.spec.ts.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HR_AVATAR_FORWARD_TRANSCRIPT, HrAvatarProvider } from '~/app/providers/hr-avatar'
import { AVATAR_SETTLE_MS } from '~/app/providers/tavus'
import type { StartConfig } from '~/app/types/interview-provider'
import {
  createFakeConversation,
  createFakeSdk,
  transcriptEntry,
} from './fixtures/hr-avatar-fake-sdk'

const SECRET = 'CLIENT_SECRET_VALUE'
const PUBLISHABLE = 'PUBLISHABLE_KEY_VALUE'
const BASE_URL = 'https://hra.example.test'
const VENDOR = /hr-avatar|hr_avatar|hravatar|hr avatar/i

function config(overrides: Partial<StartConfig> = {}): StartConfig {
  return {
    dbSessionId: 7,
    sessionToken: SECRET,
    hrAvatar: { baseUrl: BASE_URL, publishableKey: PUBLISHABLE },
    endPhrase: 'Passiamo alla prossima domanda.',
    finalPhrase: 'Grazie, abbiamo finito.',
    ...overrides,
  }
}

function setup() {
  const sdk = createFakeSdk()
  const provider = new HrAvatarProvider(sdk.loader)
  const states: unknown[] = []
  const errors: unknown[] = []
  const transcripts: unknown[] = []
  provider.on('state', (s) => states.push(s))
  provider.on('error', (e) => errors.push(e))
  provider.on('transcript', (t) => transcripts.push(t))
  const mount = document.createElement('video')
  return { ...sdk, provider, states, errors, transcripts, mount }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetModules()
  vi.doUnmock('@hr-avatar/sdk')
})

describe('lazy SDK load', () => {
  it('does not load the SDK on construction, only on the first start()', async () => {
    const { loader, provider, mount } = setup()
    expect(loader).not.toHaveBeenCalled()

    await provider.start(mount, config())

    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('the default loader imports the SDK module only when start() runs', async () => {
    let evaluated = false
    const connect = vi.fn(async () => createFakeConversation())
    vi.doMock('@hr-avatar/sdk', () => {
      evaluated = true
      return { HrAvatar: { connect } }
    })
    const { HrAvatarProvider: Fresh } = await import('~/app/providers/hr-avatar')

    const provider = new Fresh()
    expect(evaluated).toBe(false)

    await provider.start(document.createElement('video'), config())

    expect(evaluated).toBe(true)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('a rejected SDK import is a stable sdk_error that leaks no rejection text', async () => {
    const errors: unknown[] = []
    const provider = new HrAvatarProvider(
      vi.fn().mockRejectedValue(new Error(`HR-Avatar bundle failed at ${BASE_URL}`))
    )
    provider.on('error', (e) => errors.push(e))

    await expect(provider.start(document.createElement('video'), config())).resolves.toEqual({})

    expect(errors).toEqual([{ code: 'sdk_error', message: 'provider_unavailable' }])
    expect(JSON.stringify(errors)).not.toMatch(VENDOR)
  })
})

describe('guards before the SDK loads', () => {
  it.each([
    ['a missing hrAvatar object', (cfg: StartConfig) => delete cfg.hrAvatar],
    ['an empty sessionToken', (cfg: StartConfig) => (cfg.sessionToken = '')],
    ['an absent sessionToken', (cfg: StartConfig) => delete cfg.sessionToken],
  ])('%s emits sdk_error and never loads the SDK', async (_name, break_) => {
    const { loader, provider, mount, errors } = setup()
    const cfg = config()
    break_(cfg)

    await provider.start(mount, cfg)

    expect(errors).toEqual([{ code: 'sdk_error', message: 'provider_unavailable' }])
    expect(loader).not.toHaveBeenCalled()
  })

  it.each([
    ['endPhrase', { endPhrase: '' }],
    ['finalPhrase', { finalPhrase: '' }],
  ])('an empty %s emits absent_phrase and never loads the SDK', async (_name, overrides) => {
    const { loader, provider, mount, errors } = setup()

    await provider.start(mount, config(overrides))

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'absent_phrase' })
    expect(loader).not.toHaveBeenCalled()
  })
})

describe('connect options', () => {
  it('passes exactly the join inputs, the page video, the phrases and the explicit forward flag', async () => {
    const { connect, provider, mount } = setup()

    await provider.start(mount, config({ audioDeviceId: 'mic-2' }))

    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect.mock.calls[0]![0]).toEqual({
      baseUrl: BASE_URL,
      publishableKey: PUBLISHABLE,
      clientSecret: SECRET,
      mount,
      audioDeviceId: 'mic-2',
      completionPhrases: ['Passiamo alla prossima domanda.', 'Grazie, abbiamo finito.'],
      forwardTranscript: false,
    })
    expect(connect.mock.calls[0]![0]!['mount']).toBe(mount)
  })

  it('omits audioDeviceId when no microphone was selected', async () => {
    const { connect, provider, mount } = setup()

    await provider.start(mount, config())

    expect('audioDeviceId' in connect.mock.calls[0]![0]!).toBe(false)
  })

  it('names one constant for the forward flag, and it is false', () => {
    expect(HR_AVATAR_FORWARD_TRANSCRIPT).toBe(false)
  })

  it('resolves start once the SDK has connected', async () => {
    const { provider, mount } = setup()

    await expect(provider.start(mount, config())).resolves.toEqual({})
  })
})

describe('state mapping', () => {
  it('maps connecting, live, ended to connecting, ready, stopped in order', async () => {
    const { provider, mount, conversation, states } = setup()
    await provider.start(mount, config())

    conversation.setState('live')
    conversation.setState('ended')
    // `stopped` is deferred by one macrotask so a same-tick completion can win.
    expect(states).toEqual(['connecting', 'ready'])
    await vi.advanceTimersByTimeAsync(0)

    expect(states).toEqual(['connecting', 'ready', 'stopped'])
  })

  it('an SDK error state emits an error event', async () => {
    const { provider, mount, conversation, errors } = setup()
    await provider.start(mount, config())

    conversation.setState('error')

    expect(errors).toEqual([{ code: 'sdk_error', message: 'provider_unavailable' }])
  })
})

describe('transcripts', () => {
  it('relays final lines with the existing entry shape and drops interim ones', async () => {
    const { provider, mount, conversation, transcripts } = setup()
    await provider.start(mount, config())

    conversation.emit('transcript', transcriptEntry('avatar', 'Buongiorno'))
    conversation.emit('transcript', transcriptEntry('avatar', 'Buon', false))
    conversation.emit('transcript', transcriptEntry('user', 'Salve'))

    const ts = Date.parse('2026-10-19T12:00:00.000Z')
    expect(transcripts).toEqual([
      { role: 'avatar', text: 'Buongiorno', ts },
      { role: 'user', text: 'Salve', ts },
    ])
  })

  it('falls back to the clock when occurredAt is not a date', async () => {
    const { provider, mount, conversation, transcripts } = setup()
    await provider.start(mount, config())
    vi.setSystemTime(new Date('2026-10-19T13:00:00.000Z'))

    conversation.emit('transcript', { ...transcriptEntry('user', 'Salve'), occurredAt: 'nope' })

    expect(transcripts).toEqual([
      { role: 'user', text: 'Salve', ts: Date.parse('2026-10-19T13:00:00.000Z') },
    ])
  })
})

describe('microphone', () => {
  it('setMicMuted(true) twice then toggleMic() mutes once, then unmutes', async () => {
    const { provider, mount, conversation } = setup()
    await provider.start(mount, config())

    await provider.setMicMuted(true)
    await provider.setMicMuted(true)
    expect(conversation.setMicMuted).toHaveBeenCalledTimes(1)
    expect(conversation.muted).toBe(true)

    await provider.toggleMic()
    expect(conversation.muted).toBe(false)
  })

  it('does nothing before the SDK has connected', async () => {
    const { provider, conversation } = setup()

    await provider.setMicMuted(true)
    await provider.toggleMic()

    expect(conversation.setMicMuted).not.toHaveBeenCalled()
    expect(conversation.toggleMic).not.toHaveBeenCalled()
  })
})

describe('whenAvatarSilent', () => {
  it('resolves no later than maxMs when the SDK never answers, using the shared settle window', async () => {
    const { provider, mount, conversation } = setup()
    await provider.start(mount, config())

    let done = false
    void provider.whenAvatarSilent(2000).then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(1999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(done).toBe(true)
    expect(conversation.whenAvatarSilent).toHaveBeenCalledWith(AVATAR_SETTLE_MS)
    expect(AVATAR_SETTLE_MS).toBe(500)
  })

  it('resolves as soon as the SDK reports silence', async () => {
    const { provider, mount, conversation } = setup()
    await provider.start(mount, config())
    conversation.whenAvatarSilent.mockResolvedValueOnce(undefined)

    await expect(provider.whenAvatarSilent(60_000)).resolves.toBeUndefined()
  })

  it('never rejects, even when the SDK promise does', async () => {
    const { provider, mount, conversation } = setup()
    await provider.start(mount, config())
    conversation.whenAvatarSilent.mockRejectedValueOnce(new Error('boom'))

    await expect(provider.whenAvatarSilent(2000)).resolves.toBeUndefined()
  })

  it('resolves at once before the SDK has connected', async () => {
    const { provider } = setup()

    await expect(provider.whenAvatarSilent(60_000)).resolves.toBeUndefined()
  })
})

describe('stop', () => {
  it('is idempotent and quiet when the SDK end() rejects', async () => {
    const { provider, mount, conversation } = setup()
    await provider.start(mount, config())
    conversation.end.mockRejectedValue(new Error('end failed'))

    await expect(provider.stop()).resolves.toBeUndefined()
    await expect(provider.stop()).resolves.toBeUndefined()

    expect(conversation.end).toHaveBeenCalledTimes(1)
  })

  it('does nothing before the SDK has connected', async () => {
    const { provider } = setup()

    await expect(provider.stop()).resolves.toBeUndefined()
  })

  it('ends a conversation whose connect resolved after stop() was called', async () => {
    const sdk = createFakeSdk()
    let release!: () => void
    sdk.connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(sdk.conversation)
        })
    )
    const provider = new HrAvatarProvider(sdk.loader)
    const starting = provider.start(document.createElement('video'), config())
    await vi.advanceTimersByTimeAsync(0)

    await provider.stop()
    release()
    await starting

    expect(sdk.conversation.end).toHaveBeenCalledTimes(1)
  })
})

describe('opacity', () => {
  it('a rejected connect that names the vendor and the host becomes a bare sdk_error', async () => {
    const { provider, mount, connect, errors } = setup()
    connect.mockRejectedValueOnce(
      Object.assign(new Error(`HR-Avatar rejected ${BASE_URL}/v1/x`), { code: 'whatever' })
    )

    await provider.start(mount, config())

    expect(errors).toEqual([{ code: 'sdk_error', message: 'provider_unavailable' }])
    expect(JSON.stringify(errors)).not.toMatch(VENDOR)
    expect(JSON.stringify(errors)).not.toContain('hra.example.test')
  })

  it('an origin refusal has its own stable code', async () => {
    const { provider, mount, connect, errors } = setup()
    connect.mockRejectedValueOnce(
      Object.assign(new Error('Origin not allowed for HR-Avatar'), { code: 'origin_not_allowed' })
    )

    await provider.start(mount, config())

    expect(errors).toEqual([{ code: 'origin_not_allowed', message: 'provider_unavailable' }])
  })

  it.each([
    ['provider_concurrency_limited', 429],
    ['provider_credential_missing', 422],
    ['provider_error', 502],
  ])('a connect-time refusal %s (status %i) maps to sdk_error', async (code, status) => {
    const { provider, mount, connect, errors } = setup()
    connect.mockRejectedValueOnce(
      Object.assign(new Error(`HR-Avatar says ${code} at ${BASE_URL}`), { code, status })
    )

    await provider.start(mount, config())

    expect(errors).toEqual([{ code: 'sdk_error', message: 'provider_unavailable' }])
    expect(JSON.stringify(errors)).not.toMatch(VENDOR)
  })

  it('never puts the secret or the publishable key in an event, the console or the DOM', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {})
    )
    const failing = setup()
    failing.connect.mockRejectedValueOnce(new Error(`bad ${SECRET} ${PUBLISHABLE}`))
    await failing.provider.start(failing.mount, config())

    const { provider, mount, conversation, states, errors, transcripts } = setup()
    await provider.start(mount, config())
    conversation.setState('live')
    conversation.emit('transcript', transcriptEntry('avatar', 'Buongiorno'))
    conversation.setState('ended')
    await vi.advanceTimersByTimeAsync(0)

    const everything = JSON.stringify([states, errors, transcripts, failing.errors])
    expect(everything).not.toContain(SECRET)
    expect(everything).not.toContain(PUBLISHABLE)
    expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toMatch(
      new RegExp(`${SECRET}|${PUBLISHABLE}`)
    )
    expect(document.body.innerHTML + mount.outerHTML).not.toMatch(
      new RegExp(`${SECRET}|${PUBLISHABLE}`)
    )
  })
})

describe('static neutrality', () => {
  const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8')

  it('the adapter has no static import of the SDK package', () => {
    const importLines = read('app', 'providers', 'hr-avatar.ts')
      .split('\n')
      .filter((line) => /^import\s/.test(line))
      .join('\n')

    expect(importLines).not.toMatch(/@hr-avatar/)
  })

  it.each(['it.json', 'en.json'])('the %s locale file never names the engine', (file) => {
    expect(read('i18n', 'locales', file)).not.toMatch(VENDOR)
  })

  it('the adapter creates no DOM of its own', async () => {
    const { provider, mount, conversation } = setup()
    const before = document.body.innerHTML
    await provider.start(mount, config())
    conversation.setState('live')

    expect(mount.childElementCount).toBe(0)
    expect(document.body.innerHTML).toBe(before)
  })
})
