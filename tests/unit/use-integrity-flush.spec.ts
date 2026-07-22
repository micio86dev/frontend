/**
 * useIntegrityFlush — unit tests (Task 3.3 RED)
 *
 * Coverage:
 *  - flush([...events]) calls $fetch POST /integrity with events mapped type → kind
 *  - flushViaBeacon uses absolute URL from runtimeConfig.public.apiBase
 *  - flushViaBeacon sends Blob with type 'application/json'
 *  - sendBeacon returns false → warning logged (64 KB Safari cap guard)
 *  - type → kind field mapping
 *  - pagehide handler calls flushViaBeacon with pending batch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { IntegrityEventInternal } from '~/app/utils/proctor-config'

// Import after mocks are established
import { useIntegrityFlush } from '~/app/composables/useIntegrityFlush'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockFlushFetch } = vi.hoisted(() => ({
  mockFlushFetch: vi.fn(),
}))

vi.mock('ofetch', () => ({
  $fetch: mockFlushFetch,
}))

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const mockSendBeacon = vi.fn(() => true)

beforeEach(() => {
  vi.clearAllMocks()
  mockSendBeacon.mockReturnValue(true)
  vi.stubGlobal('navigator', { sendBeacon: mockSendBeacon })
  // Re-stub after clearAllMocks resets the setup.ts stub
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
  describe('flush() — POST /integrity via $fetch', () => {
    it('calls $fetch with /candidate/interview/integrity endpoint', async () => {
      const { flush } = useIntegrityFlush({ sessionId: 99 })
      mockFlushFetch.mockResolvedValueOnce(undefined)

      await flush(sampleEvents)

      expect(mockFlushFetch).toHaveBeenCalledWith(
        expect.stringContaining('/candidate/interview/integrity'),
        expect.any(Object)
      )
    })

    it('maps internal event type → kind field in the API payload', async () => {
      const { flush } = useIntegrityFlush({ sessionId: 99 })
      mockFlushFetch.mockResolvedValueOnce(undefined)

      await flush(sampleEvents)

      const call = mockFlushFetch.mock.calls[0]
      const body = (call[1] as { body: { events: { kind: string; ts: string }[] } }).body

      expect(body.events).toHaveLength(3)
      expect(body.events[0]).toMatchObject({ kind: 'tab_hidden', ts: '2025-01-01T00:00:00Z' })
      expect(body.events[1]).toMatchObject({ kind: 'focus_lost', ts: '2025-01-01T00:00:01Z' })
      expect(body.events[2]).toMatchObject({ kind: 'face_absent', ts: '2025-01-01T00:00:02Z' })
    })

    it('includes session_id in the payload', async () => {
      const { flush } = useIntegrityFlush({ sessionId: 42 })
      mockFlushFetch.mockResolvedValueOnce(undefined)

      await flush(sampleEvents)

      const body = (mockFlushFetch.mock.calls[0][1] as { body: { session_id: number } }).body
      expect(body.session_id).toBe(42)
    })

    it('does NOT include "type" field — only "kind" in event payload', async () => {
      const { flush } = useIntegrityFlush({ sessionId: 99 })
      mockFlushFetch.mockResolvedValueOnce(undefined)

      await flush(sampleEvents)

      const body = (
        mockFlushFetch.mock.calls[0][1] as { body: { events: Record<string, unknown>[] } }
      ).body
      for (const event of body.events) {
        expect(event).not.toHaveProperty('type')
        expect(event).toHaveProperty('kind')
      }
    })

    it('flush([]) → no-op; $fetch is NOT called (early return guard)', async () => {
      const { flush } = useIntegrityFlush({ sessionId: 99 })

      await flush([])

      expect(mockFlushFetch).not.toHaveBeenCalled()
    })
  })

  describe('flushViaBeacon() — navigator.sendBeacon', () => {
    it('uses absolute URL built from runtimeConfig.public.apiBase', () => {
      const { flushViaBeacon } = useIntegrityFlush({ sessionId: 99 })

      flushViaBeacon(sampleEvents)

      const [url] = mockSendBeacon.mock.calls[0] as [string, Blob]
      expect(url).toMatch(/^https?:\/\//)
      expect(url).toContain('/candidate/interview/integrity')
    })

    it('sends a Blob with type application/json', () => {
      const { flushViaBeacon } = useIntegrityFlush({ sessionId: 99 })

      flushViaBeacon(sampleEvents)

      const [, blob] = mockSendBeacon.mock.calls[0] as [string, Blob]
      expect(blob).toBeInstanceOf(Blob)
      expect(blob.type).toBe('application/json')
    })

    it('maps type → kind in the beacon payload', async () => {
      const { flushViaBeacon } = useIntegrityFlush({ sessionId: 99 })

      flushViaBeacon(sampleEvents)

      const [, blob] = mockSendBeacon.mock.calls[0] as [string, Blob]
      const text = await blob.text()
      const parsed = JSON.parse(text) as { events: { kind: string }[] }

      expect(parsed.events[0].kind).toBe('tab_hidden')
      expect(parsed.events).toHaveLength(3)
    })

    it('logs a warning when sendBeacon returns false (64 KB Safari cap)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockSendBeacon.mockReturnValue(false)

      const { flushViaBeacon } = useIntegrityFlush({ sessionId: 99 })
      flushViaBeacon(sampleEvents)

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sendBeacon'), expect.anything())
      warnSpy.mockRestore()
    })

    it('includes session_id in the beacon payload body (not in URL)', async () => {
      const { flushViaBeacon } = useIntegrityFlush({ sessionId: 55 })

      flushViaBeacon(sampleEvents)

      const [url, blob] = mockSendBeacon.mock.calls[0] as [string, Blob]
      const text = await blob.text()
      const parsed = JSON.parse(text) as { session_id: number }

      expect(parsed.session_id).toBe(55)
      // URL itself should not embed session_id
      expect(url).not.toContain('session_id')
    })
  })

  describe('pagehide integration', () => {
    it('registers a pagehide listener', () => {
      const addSpy = vi.spyOn(window, 'addEventListener')

      useIntegrityFlush({ sessionId: 99 })

      expect(addSpy).toHaveBeenCalledWith('pagehide', expect.any(Function))
      addSpy.mockRestore()
    })

    it('pagehide handler flushes pending events via sendBeacon', () => {
      let pagehideHandler: (() => void) | null = null
      vi.spyOn(window, 'addEventListener').mockImplementation((evt, handler) => {
        if (evt === 'pagehide') pagehideHandler = handler as () => void
      })

      const { addEvent } = useIntegrityFlush({ sessionId: 99 })

      addEvent({ type: 'tab_hidden', ts: '2025-01-01T00:00:00Z', meta: null })

      pagehideHandler?.()

      expect(mockSendBeacon).toHaveBeenCalled()
      const [url] = mockSendBeacon.mock.calls[0] as [string, Blob]
      expect(url).toContain('/candidate/interview/integrity')
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
