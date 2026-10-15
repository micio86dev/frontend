/**
 * AvatarPlayer — the candidate's microphone choice reaches the one-time uplink seed
 * (live-interview-call-chrome, D9 rule 3).
 *
 * `muted` is the handover role's downlink control; `micMuted` is the uplink-only
 * choice. The seed after `start()` is `muted || micMuted`, and `micMuted` never
 * silences the interviewer's video.
 */

import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { InterviewProvider, StartConfig } from '~/app/types/interview-provider'

const CONFIG: StartConfig = {
  dbSessionId: 1,
  sessionToken: 'tok',
  endPhrase: 'Passiamo alla prossima domanda.',
  finalPhrase: 'Grazie per il tuo tempo.',
}

function makeProvider(): InterviewProvider {
  return {
    on: vi.fn(),
    start: vi.fn(async () => ({})),
    stop: vi.fn(async () => undefined),
    toggleMic: vi.fn(async () => undefined),
    setMicMuted: vi.fn(async () => undefined),
  }
}

async function mountPlayer(provider: InterviewProvider, props: Record<string, unknown> = {}) {
  const { default: AvatarPlayer } = await import('~/app/components/AvatarPlayer.client.vue')
  const wrapper = mount(AvatarPlayer, {
    props: { provider, config: CONFIG, ...props },
    global: { mocks: { $t: (key: string) => key }, stubs: { Skeleton: true } },
  })
  await nextTick()
  await nextTick()
  return wrapper
}

describe('AvatarPlayer uplink seed', () => {
  it.each([
    ['micMuted only', { micMuted: true, muted: false }, true],
    ['muted only', { muted: true, micMuted: false }, true],
    ['both', { muted: true, micMuted: true }, true],
    ['neither', { muted: false, micMuted: false }, false],
    ['neither (defaults)', {}, false],
  ])('seeds %s', async (_label, props, expected) => {
    const provider = makeProvider()
    await mountPlayer(provider, props)

    expect(provider.setMicMuted).toHaveBeenCalledTimes(1)
    expect(provider.setMicMuted).toHaveBeenCalledWith(expected)
  })

  it('reads the prop once, after start() resolves, and ignores later changes', async () => {
    const provider = makeProvider()
    let finishStart!: () => void
    provider.start = vi.fn(
      () => new Promise<object>((resolve) => (finishStart = () => resolve({})))
    )
    const wrapper = await mountPlayer(provider, { micMuted: false })
    expect(provider.setMicMuted).not.toHaveBeenCalled()

    await wrapper.setProps({ micMuted: true }) // the candidate mutes while the session connects
    finishStart()
    await nextTick()
    await nextTick()
    expect(provider.setMicMuted).toHaveBeenCalledTimes(1)
    expect(provider.setMicMuted).toHaveBeenCalledWith(true)

    await wrapper.setProps({ micMuted: false })
    await nextTick()
    expect(provider.setMicMuted).toHaveBeenCalledTimes(1)
  })

  it('never silences the interviewer video because the candidate muted', async () => {
    const wrapper = await mountPlayer(makeProvider(), { micMuted: true })

    expect((wrapper.find('video').element as HTMLVideoElement).muted).toBe(false)
  })
})
