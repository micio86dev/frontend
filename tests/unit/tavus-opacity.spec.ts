/**
 * The candidate must not be able to tell which provider is behind the face
 * (C14 PR1).
 *
 * Two defects, both shipped, both fixed here.
 *
 * The provider used Daily's `createFrame`, which embeds a VISIBLE daily.co
 * iframe carrying the vendor's own chrome into the interview page. That is not
 * a subtle network-level tell — it is the vendor's UI, on screen, in front of
 * the candidate. No amount of configuration fixes it; the media path has to
 * change.
 *
 * And completion was detected only through a `conversation.tool_call` app
 * message naming `end_interview`. That tool is never registered, so the message
 * never arrives, and a Tavus interview runs until it times out rather than
 * finishing. A session that never completes is never scored.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TavusProvider } from '~/app/providers/tavus'

interface MockCallObject {
  on: ReturnType<typeof vi.fn>
  join: ReturnType<typeof vi.fn>
  leave: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  setLocalAudio: ReturnType<typeof vi.fn>
  localAudio: ReturnType<typeof vi.fn>
  _emit: (eventName: string, data: unknown) => void
}

function createMockCallObject(): MockCallObject {
  const handlers = new Map<string, ((data: unknown) => void)[]>()
  let micOn = true

  return {
    on: vi.fn((event: string, cb: (data: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), cb])
    }),
    join: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    setLocalAudio: vi.fn((v: boolean) => {
      micOn = v
    }),
    localAudio: vi.fn(() => micOn),
    _emit: (eventName: string, data: unknown) => {
      for (const cb of handlers.get(eventName) ?? []) {
        cb(data)
      }
    },
  }
}

const PHRASES = {
  endPhrase: 'Passiamo alla prossima domanda.',
  finalPhrase: 'Grazie per il tuo tempo.',
}

const CONVERSATION_URL = 'https://tavus.daily.co/fake-room-id'

describe('TavusProvider — provider opacity', () => {
  let call: MockCallObject
  let states: string[]
  let transcripts: unknown[]

  beforeEach(() => {
    call = createMockCallObject()
    states = []
    transcripts = []
  })

  function makeProvider() {
    const provider = new TavusProvider(vi.fn().mockResolvedValue(call))
    provider.on('state', (s) => states.push(s as string))
    provider.on('transcript', (t) => transcripts.push(t))
    return provider
  }

  it("renders into the app's own <video>, never a vendor iframe", async () => {
    const mount = document.createElement('div')
    const video = document.createElement('video')
    mount.appendChild(video)

    await makeProvider().start(mount, {
      dbSessionId: 1,
      conversationUrl: CONVERSATION_URL,
      ...PHRASES,
    })

    // The whole requirement in one assertion. An <iframe> here means the
    // candidate is looking at daily.co's page inside ours, complete with its
    // branding — and every DOM inspection, right-click and devtools glance
    // names the vendor.
    expect(mount.querySelector('iframe')).toBeNull()
  })

  it('joins with the camera off and audio on', async () => {
    const mount = document.createElement('div')
    mount.appendChild(document.createElement('video'))

    await makeProvider().start(mount, {
      dbSessionId: 1,
      conversationUrl: CONVERSATION_URL,
      ...PHRASES,
    })

    // The candidate's camera belongs to the proctoring layer, which owns its
    // own stream. Handing it to the conversation SDK as well would mean two
    // consumers of one device — and on several browsers the second one fails.
    const joinArgs = call.join.mock.calls[0]?.[0] as Record<string, unknown>
    expect(joinArgs.url).toBe(CONVERSATION_URL)
    expect(joinArgs.startVideoOff).toBe(true)
  })

  it('attaches remote tracks to the video element itself', async () => {
    const mount = document.createElement('div')
    const video = document.createElement('video')
    mount.appendChild(video)

    await makeProvider().start(mount, {
      dbSessionId: 1,
      conversationUrl: CONVERSATION_URL,
      ...PHRASES,
    })

    const track = { kind: 'video' } as MediaStreamTrack
    call._emit('track-started', { participant: { local: false }, track })

    // Piping tracks into our own element is what makes the iframe unnecessary.
    // Asserted through the public effect rather than an internal flag: the
    // element ends up with a srcObject, or the candidate sees nothing.
    expect(video.srcObject).not.toBeNull()
  })

  it("ignores the LOCAL participant's tracks", async () => {
    const mount = document.createElement('div')
    const video = document.createElement('video')
    mount.appendChild(video)

    await makeProvider().start(mount, {
      dbSessionId: 1,
      conversationUrl: CONVERSATION_URL,
      ...PHRASES,
    })

    call._emit('track-started', {
      participant: { local: true },
      track: { kind: 'audio' } as MediaStreamTrack,
    })

    // Piping the candidate's own microphone into the avatar's element would
    // play their voice back at them on a delay — the single most disorienting
    // thing you can do to somebody being interviewed.
    expect(video.srcObject).toBeNull()
  })
})

describe('TavusProvider — completion actually fires', () => {
  let call: MockCallObject
  let states: string[]

  beforeEach(() => {
    call = createMockCallObject()
    states = []
  })

  function makeProvider() {
    const provider = new TavusProvider(vi.fn().mockResolvedValue(call))
    provider.on('state', (s) => states.push(s as string))
    return provider
  }

  async function started() {
    const provider = makeProvider()
    const mount = document.createElement('div')
    mount.appendChild(document.createElement('video'))
    await provider.start(mount, {
      dbSessionId: 1,
      conversationUrl: CONVERSATION_URL,
      ...PHRASES,
    })
    return provider
  }

  it('completes on the spoken end phrase', async () => {
    await started()

    call._emit('app-message', {
      data: {
        event_type: 'conversation.utterance',
        properties: { role: 'replica', speech: `Va bene. ${PHRASES.endPhrase}` },
      },
    })

    // The phrase the avatar SAYS is the signal, exactly as it is for HeyGen.
    // Relying on a tool call meant relying on a message that is never sent —
    // so the interview simply never ended, and an interview that never ends is
    // never scored.
    expect(states).toContain('complete')
  })

  it('completes on the final phrase too', async () => {
    await started()

    call._emit('app-message', {
      data: {
        event_type: 'conversation.utterance',
        properties: { role: 'replica', speech: PHRASES.finalPhrase },
      },
    })

    expect(states).toContain('complete')
  })

  it('does NOT complete on the candidate saying the phrase', async () => {
    await started()

    call._emit('app-message', {
      data: {
        event_type: 'conversation.utterance',
        properties: { role: 'user', speech: PHRASES.finalPhrase },
      },
    })

    // A candidate who reads the closing line aloud — or is simply polite —
    // must not be able to end their own assessment early.
    expect(states).not.toContain('complete')
  })

  it('still honours the tool call, if it ever arrives', async () => {
    await started()

    call._emit('app-message', {
      data: { type: 'conversation.tool_call', name: 'end_interview' },
    })

    // Kept as a second path rather than replaced. It costs three lines, and if
    // Tavus ever does register the tool the signal is more precise than
    // matching text.
    expect(states).toContain('complete')
  })
})

describe('TavusProvider — microphone', () => {
  it('toggleMic actually toggles the microphone', async () => {
    const call = createMockCallObject()
    const provider = new TavusProvider(vi.fn().mockResolvedValue(call))
    const mount = document.createElement('div')
    mount.appendChild(document.createElement('video'))

    await provider.start(mount, {
      dbSessionId: 1,
      conversationUrl: CONVERSATION_URL,
      ...PHRASES,
    })

    await provider.toggleMic()

    // It was an empty no-op with a comment saying the component handled it.
    // Nothing did. A candidate pressing mute stayed live — which on an
    // assessment recording is a promise broken silently.
    expect(call.setLocalAudio).toHaveBeenCalledWith(false)
  })
})
