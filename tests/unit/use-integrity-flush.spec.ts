/**
 * useIntegrityFlush — unit tests (Task 3.3 RED; migrated onto the single
 * authenticated transport by Task 1.7 RED / candidate-session-auth D-B, D-C)
 *
 * Coverage:
 *  - flush([...events]) calls candidateFetch POST /integrity with events mapped type → kind
 *  - flushViaBeacon delegates to the shared flushIntegrityKeepalive transport
 *    (fetch + keepalive + Authorization header — sendBeacon cannot set headers)
 *  - flushViaBeacon's payload carries the mapped type → kind events
 *  - pagehide handler flushes the pending batch AND acknowledges it on dispatch
 *    (D-C: fetch(..., { keepalive: true }) will not settle before the page dies,
 *    so acknowledgement can no longer wait for a synchronous sendBeacon return value)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope } from 'vue'
import type { IntegrityEventInternal } from '~/app/utils/proctor-config'

// ---------------------------------------------------------------------------
// Hoisted mocks — candidate-api.ts is the single authenticated transport;
// useIntegrityFlush no longer talks to ofetch or navigator.sendBeacon directly.
// ---------------------------------------------------------------------------

const { mockCandidateFetch, mockFlushIntegrityKeepalive } = vi.hoisted(() => ({
  mockCandidateFetch: vi.fn(),
  mockFlushIntegrityKeepalive: vi.fn(),
}))

vi.mock('~/app/utils/candidate-api', () => ({
  candidateFetch: mockCandidateFetch,
  flushIntegrityKeepalive: mockFlushIntegrityKeepalive,
}))

// Import after mocks are established
// eslint-disable-next-line import/first
import { useIntegrityFlush } from '~/app/composables/useIntegrityFlush'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal(
    'useRuntimeConfig',
    vi.fn(() => ({
      public: { apiBase: 'https://api.test', interviewProviderMock: 'false' },
    }))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleEvents: IntegrityEventInternal[] = [
  { type: 'tab_hidden', ts: '2025-01-01T00:00:00Z', meta: null },
  { type: 'focus_lost', ts: '2025-01-01T00:00:01Z', meta: null },
  { type: 'face_absent', ts: '2025-01-01T00:00:02Z', meta: { count: 1 } },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useIntegrityFlush', () => {
  describe('flush() — POST /integrity via candidateFetch', () => {
    it('calls candidateFetch with the /candidate/interview/integrity endpoint', async () => {
      const { flush } = useIntegrityFlush({ sessionId: 99 })
      mockCandidateFetch.mockResolvedValueOnce(undefined)

      await flush(sampleEvents)

      // candidateFetch resolves the URL internally (D-B) — the caller passes
      // the API-relative path, not a pre-built absolute URL.
      expect(mockCandidateFetch).toHaveBeenCalledWith(
        '/candidate/interview/integrity',
        expect.any(Object)
      )
    })

    it('maps internal event type → kind field in the API payload', async () => {
      const { flush } = useIntegrityFlush({ sessionId: 99 })
      mockCandidateFetch.mockResolvedValueOnce(undefined)

      await flush(sampleEvents)

      const call = mockCandidateFetch.mock.calls[0]
      const body = (call[1] as { body: { events: { kind: string; ts: string }[] } }).body

      expect(body.events).toHaveLength(3)
      expect(body.events[0]).toMatchObject({ kind: 'tab_hidden', ts: '2025-01-01T00:00:00Z' })
      expect(body.events[1]).toMatchObject({ kind: 'focus_lost', ts: '2025-01-01T00:00:01Z' })
      expect(body.events[2]).toMatchObject({ kind: 'face_absent', ts: '2025-01-01T00:00:02Z' })
    })

    it('includes session_id in the payload', async () => {
      const { flush } = useIntegrityFlush({ sessionId: 42 })
      mockCandidateFetch.mockResolvedValueOnce(undefined)

      await flush(sampleEvents)

      const body = (mockCandidateFetch.mock.calls[0][1] as { body: { session_id: number } }).body
      expect(body.session_id).toBe(42)
    })

    it('does NOT include "type" field — only "kind" in event payload', async () => {
      const { flush } = useIntegrityFlush({ sessionId: 99 })
      mockCandidateFetch.mockResolvedValueOnce(undefined)

      await flush(sampleEvents)

      const body = (
        mockCandidateFetch.mock.calls[0][1] as { body: { events: Record<string, unknown>[] } }
      ).body
      for (const event of body.events) {
        expect(event).not.toHaveProperty('type')
        expect(event).toHaveProperty('kind')
      }
    })

    it('flush([]) → no-op; candidateFetch is NOT called (early return guard)', async () => {
      const { flush } = useIntegrityFlush({ sessionId: 99 })

      await flush([])

      expect(mockCandidateFetch).not.toHaveBeenCalled()
    })
  })

  describe('flushViaBeacon() — delegates to the shared keepalive transport (D-C)', () => {
    it('calls flushIntegrityKeepalive with the mapped type → kind payload', () => {
      const { flushViaBeacon } = useIntegrityFlush({ sessionId: 99 })

      flushViaBeacon(sampleEvents)

      expect(mockFlushIntegrityKeepalive).toHaveBeenCalledWith(
        expect.objectContaining({
          session_id: 99,
          events: [
            expect.objectContaining({ kind: 'tab_hidden' }),
            expect.objectContaining({ kind: 'focus_lost' }),
            expect.objectContaining({ kind: 'face_absent' }),
          ],
        })
      )
    })

    it('does NOT call navigator.sendBeacon directly — sendBeacon cannot carry the Authorization header', () => {
      const sendBeaconSpy = vi.fn()
      vi.stubGlobal('navigator', { sendBeacon: sendBeaconSpy })

      const { flushViaBeacon } = useIntegrityFlush({ sessionId: 99 })
      flushViaBeacon(sampleEvents)

      expect(sendBeaconSpy).not.toHaveBeenCalled()
    })

    it('includes session_id in the delegated payload', () => {
      const { flushViaBeacon } = useIntegrityFlush({ sessionId: 55 })

      flushViaBeacon(sampleEvents)

      const [payload] = mockFlushIntegrityKeepalive.mock.calls[0] as [{ session_id: number }]
      expect(payload.session_id).toBe(55)
    })
  })

  describe('pagehide integration — acknowledge on dispatch (D-C)', () => {
    it('registers a pagehide listener', () => {
      const addSpy = vi.spyOn(window, 'addEventListener')

      useIntegrityFlush({ sessionId: 99 })

      expect(addSpy).toHaveBeenCalledWith('pagehide', expect.any(Function))
      addSpy.mockRestore()
    })

    it('pagehide handler flushes pending events via the shared keepalive transport', () => {
      let pagehideHandler: (() => void) | null = null
      vi.spyOn(window, 'addEventListener').mockImplementation((evt, handler) => {
        if (evt === 'pagehide') pagehideHandler = handler as () => void
      })

      const { addEvent } = useIntegrityFlush({ sessionId: 99 })

      addEvent({ type: 'tab_hidden', ts: '2025-01-01T00:00:00Z', meta: null })

      pagehideHandler?.()

      expect(mockFlushIntegrityKeepalive).toHaveBeenCalled()
    })

    it('clears the pending batch on dispatch, without waiting for the flush to settle', () => {
      // fetch(..., { keepalive: true }) returns a promise that will not settle
      // before the page dies — the old sendBeacon-return-value gate no longer
      // applies. flushIntegrityKeepalive is fire-and-forget by construction.
      let pagehideHandler: (() => void) | null = null
      vi.spyOn(window, 'addEventListener').mockImplementation((evt, handler) => {
        if (evt === 'pagehide') pagehideHandler = handler as () => void
      })

      const { addEvent, pendingEvents } = useIntegrityFlush({ sessionId: 99 })
      addEvent({ type: 'tab_hidden', ts: '2025-01-01T00:00:00Z', meta: null })
      expect(pendingEvents.value).toHaveLength(1)

      pagehideHandler?.()

      expect(pendingEvents.value).toHaveLength(0)
    })
  })

  describe('pagehide listener lifecycle (no leaked listeners)', () => {
    it('dispose() removes the pagehide listener it registered', () => {
      const removeSpy = vi.spyOn(window, 'removeEventListener')

      const { dispose } = useIntegrityFlush({ sessionId: 99 })
      dispose()

      expect(removeSpy).toHaveBeenCalledWith('pagehide', expect.any(Function))
      removeSpy.mockRestore()
    })

    it('dispose() is idempotent — a second call removes nothing further', () => {
      const { dispose } = useIntegrityFlush({ sessionId: 99 })
      dispose()

      const removeSpy = vi.spyOn(window, 'removeEventListener')
      dispose()

      expect(removeSpy).not.toHaveBeenCalled()
      removeSpy.mockRestore()
    })

    it('a disposed instance no longer flushes on pagehide', () => {
      let pagehideHandler: (() => void) | null = null
      vi.spyOn(window, 'addEventListener').mockImplementation((evt, handler) => {
        if (evt === 'pagehide') pagehideHandler = handler as () => void
      })
      const removed: unknown[] = []
      vi.spyOn(window, 'removeEventListener').mockImplementation((evt, handler) => {
        if (evt === 'pagehide' && handler === pagehideHandler) {
          removed.push(handler)
          pagehideHandler = null
        }
      })

      const { addEvent, dispose } = useIntegrityFlush({ sessionId: 99 })
      addEvent({ type: 'tab_hidden', ts: '2025-01-01T00:00:00Z', meta: null })

      dispose()
      expect(removed).toHaveLength(1)

      // The listener is gone, so a pagehide can no longer reach this closure.
      pagehideHandler?.()
      expect(mockFlushIntegrityKeepalive).not.toHaveBeenCalled()
    })

    it('the listener is torn down when the owning effect scope is disposed', () => {
      const removeSpy = vi.spyOn(window, 'removeEventListener')
      const scope = effectScope()

      scope.run(() => {
        useIntegrityFlush({ sessionId: 99 })
      })
      expect(removeSpy).not.toHaveBeenCalledWith('pagehide', expect.any(Function))

      scope.stop()

      // Every call used to add a listener and remove none, leaking one closure each.
      expect(removeSpy).toHaveBeenCalledWith('pagehide', expect.any(Function))
      removeSpy.mockRestore()
    })
  })

  describe('composable isolation', () => {
    it('returns a new object per call (no module singleton)', () => {
      const a = useIntegrityFlush({ sessionId: 1 })
      const b = useIntegrityFlush({ sessionId: 2 })
      expect(a).not.toBe(b)
    })
  })
})
