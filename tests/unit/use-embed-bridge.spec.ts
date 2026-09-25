/**
 * useEmbedBridge — unit tests (public-api SPEC §4.3/§4.4).
 *
 * Simulates running inside an iframe by overriding `window.parent` with a
 * distinct fake object (so `window.parent !== window`) and dispatching
 * `message` events whose `source` is that same object — the structural check
 * `handleMessage()` makes, mirroring `@beai/embed`'s own
 * `event.source !== this.iframe?.contentWindow` check from the host side.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useEmbedBridge } from '~/app/composables/useEmbedBridge'

const REAL_WINDOW = window
let fakeParent: { postMessage: ReturnType<typeof vi.fn> }

function setInIframe(): void {
  fakeParent = { postMessage: vi.fn() }
  Object.defineProperty(window, 'parent', { value: fakeParent, configurable: true })
}

function setTopLevel(): void {
  Object.defineProperty(window, 'parent', { value: REAL_WINDOW, configurable: true })
}

function dispatchHostMessage(data: unknown, origin: string, source: unknown = fakeParent): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: source as Window }))
}

const VALID_START = { source: 'beai-embed', version: 1, type: 'start' }

describe('useEmbedBridge', () => {
  beforeEach(() => {
    setInIframe()
  })

  afterEach(() => {
    setTopLevel()
  })

  describe('post()', () => {
    it('is a no-op when not running inside an iframe (window.parent === window)', () => {
      setTopLevel()
      const bridge = useEmbedBridge({ getAllowedOrigins: () => [] })

      bridge.post('ready')

      expect(fakeParent.postMessage).not.toHaveBeenCalled()
    })

    it('posts the first message with targetOrigin "*" before any host message was received', () => {
      const bridge = useEmbedBridge({ getAllowedOrigins: () => ['acme.example'] })

      bridge.post('ready')

      expect(fakeParent.postMessage).toHaveBeenCalledWith(
        { source: 'beai-embed', version: 1, type: 'ready', payload: undefined },
        '*'
      )
    })

    it('carries the protocol envelope and payload for a typed event', () => {
      const bridge = useEmbedBridge({ getAllowedOrigins: () => [] })

      bridge.post('completed', { interviewId: 'int_123' })

      expect(fakeParent.postMessage).toHaveBeenCalledWith(
        {
          source: 'beai-embed',
          version: 1,
          type: 'completed',
          payload: { interviewId: 'int_123' },
        },
        '*'
      )
    })

    it('targets the CONFIRMED host origin once a validated inbound message has been received', () => {
      const bridge = useEmbedBridge({ getAllowedOrigins: () => ['acme.example'] })
      bridge.attach()

      dispatchHostMessage(VALID_START, 'https://acme.example')
      bridge.post('started')

      expect(fakeParent.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'started' }),
        'https://acme.example'
      )

      bridge.detach()
    })
  })

  describe('attach() / inbound message validation', () => {
    it('calls onStart for a validated start message from an allowed origin', () => {
      const onStart = vi.fn()
      const bridge = useEmbedBridge({ getAllowedOrigins: () => ['acme.example'], onStart })
      bridge.attach()

      dispatchHostMessage(VALID_START, 'https://acme.example')

      expect(onStart).toHaveBeenCalledTimes(1)
      bridge.detach()
    })

    it('ignores a message from an origin not in the allow-list', () => {
      const onStart = vi.fn()
      const bridge = useEmbedBridge({ getAllowedOrigins: () => ['acme.example'], onStart })
      bridge.attach()

      dispatchHostMessage(VALID_START, 'https://attacker.example')

      expect(onStart).not.toHaveBeenCalled()
      bridge.detach()
    })

    it('ignores a message whose event.source is not window.parent (structural spoof check)', () => {
      const onStart = vi.fn()
      const bridge = useEmbedBridge({ getAllowedOrigins: () => ['acme.example'], onStart })
      bridge.attach()

      dispatchHostMessage(VALID_START, 'https://acme.example', {})

      expect(onStart).not.toHaveBeenCalled()
      bridge.detach()
    })

    it('ignores a message with the wrong envelope source', () => {
      const onStart = vi.fn()
      const bridge = useEmbedBridge({ getAllowedOrigins: () => ['acme.example'], onStart })
      bridge.attach()

      dispatchHostMessage(
        { source: 'someone-else', version: 1, type: 'start' },
        'https://acme.example'
      )

      expect(onStart).not.toHaveBeenCalled()
      bridge.detach()
    })

    it('ignores a message with the wrong envelope version', () => {
      const onStart = vi.fn()
      const bridge = useEmbedBridge({ getAllowedOrigins: () => ['acme.example'], onStart })
      bridge.attach()

      dispatchHostMessage(
        { source: 'beai-embed', version: 2, type: 'start' },
        'https://acme.example'
      )

      expect(onStart).not.toHaveBeenCalled()
      bridge.detach()
    })

    it('ignores a malformed (non-object) message payload', () => {
      const onStart = vi.fn()
      const bridge = useEmbedBridge({ getAllowedOrigins: () => ['acme.example'], onStart })
      bridge.attach()

      dispatchHostMessage('not an object', 'https://acme.example')

      expect(onStart).not.toHaveBeenCalled()
      bridge.detach()
    })

    it('ignores every message before attach() has been called', () => {
      const onStart = vi.fn()
      useEmbedBridge({ getAllowedOrigins: () => ['acme.example'], onStart })

      dispatchHostMessage(VALID_START, 'https://acme.example')

      expect(onStart).not.toHaveBeenCalled()
    })

    it('detach() stops handling further messages', () => {
      const onStart = vi.fn()
      const bridge = useEmbedBridge({ getAllowedOrigins: () => ['acme.example'], onStart })
      bridge.attach()
      bridge.detach()

      dispatchHostMessage(VALID_START, 'https://acme.example')

      expect(onStart).not.toHaveBeenCalled()
    })

    it('never gates onStart on consent/device-check having run — it is informational only', () => {
      // SPEC §4.4: "start() before consent is queued, not executed." This
      // bridge has no consent/device-check state of its own to gate on; the
      // guarantee lives entirely in InterviewSession.vue's existing state
      // machine, which never reads a "host said start" flag to skip anything.
      const onStart = vi.fn()
      const bridge = useEmbedBridge({ getAllowedOrigins: () => ['acme.example'], onStart })
      bridge.attach()

      dispatchHostMessage(VALID_START, 'https://acme.example')

      expect(onStart).toHaveBeenCalledTimes(1)
      bridge.detach()
    })
  })
})
