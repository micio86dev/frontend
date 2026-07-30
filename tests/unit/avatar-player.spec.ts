/**
 * AvatarPlayer.client.vue — audio channel ownership.
 *
 * The <video> in this component carries the INTERVIEWER's audio. It used to bind
 * `:muted="micMuted"`, where micMuted is the CANDIDATE's microphone state — two
 * unrelated channels. A candidate who muted their mic stopped hearing the interview.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
  }
}

async function mountPlayer(provider: InterviewProvider, extraProps: Record<string, unknown> = {}) {
  const { default: AvatarPlayer } = await import('~/app/components/AvatarPlayer.client.vue')
  const wrapper = mount(AvatarPlayer, {
    props: { provider, config: CONFIG, ...extraProps },
    global: { mocks: { $t: (key: string) => key }, stubs: { Skeleton: true } },
  })
  await nextTick()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AvatarPlayer.client.vue', () => {
  it('renders the avatar video UNMUTED even when the candidate mic is reported muted', async () => {
    // `micMuted: true` is passed deliberately. Reinstating the `micMuted` prop and the
    // `:muted="micMuted"` binding on the <video> makes this fail, which is the point:
    // the candidate's microphone state must never gate the interviewer's audio.
    const wrapper = await mountPlayer(makeProvider(), { micMuted: true })

    const video = wrapper.find('video').element as HTMLVideoElement
    expect(video.muted).toBe(false)
    expect(wrapper.find('video').attributes('muted')).toBeUndefined()
  })

  it("declares no micMuted prop — the candidate mic is not this component's concern", async () => {
    const { default: AvatarPlayer } = await import('~/app/components/AvatarPlayer.client.vue')
    const declaredProps = (AvatarPlayer as unknown as { props?: Record<string, unknown> }).props

    expect(Object.keys(declaredProps ?? {})).toEqual(['provider', 'config'])
  })

  it('starts the provider against the <video> element, not a detached node', async () => {
    // provider.start() attaches media ONLY when the mount element is an
    // HTMLMediaElement; anything else silently attaches nothing.
    const provider = makeProvider()
    const wrapper = await mountPlayer(provider)

    expect(provider.start).toHaveBeenCalledTimes(1)
    const [mountEl, config] = (provider.start as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect((mountEl as HTMLElement).tagName).toBe('VIDEO')
    expect(mountEl).toBe(wrapper.find('video').element)
    expect(config).toStrictEqual(CONFIG)
  })

  it('stops the provider on unmount', async () => {
    const provider = makeProvider()
    const wrapper = await mountPlayer(provider)

    wrapper.unmount()
    await nextTick()

    expect(provider.stop).toHaveBeenCalled()
  })
})
