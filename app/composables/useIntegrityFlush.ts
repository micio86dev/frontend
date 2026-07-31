/**
 * useIntegrityFlush — Integrity event flush composable (Task 3.4 GREEN)
 *
 * Manages a batch of integrity events and provides two flush paths:
 *   1. flush()           — POST /integrity via $fetch (normal flush, every 10s)
 *   2. flushViaBeacon()  — navigator.sendBeacon with absolute URL + Blob('application/json')
 *                           (used on pagehide and resize-triggered navigation)
 *
 * Type → kind mapping: internal IntegrityEventInternal uses field `type`;
 * the C7a API contract uses field `kind`. All payload construction maps type → kind.
 *
 * SSR invariant: NO browser globals at module scope. navigator/window access is
 * inside function bodies only, not at module evaluation.
 *
 * Design refs: D3 (sendBeacon + type→kind), spec Coverage Note (sendBeacon via Playwright)
 */

import { getCurrentScope, onScopeDispose, ref } from 'vue'
import { $fetch } from 'ofetch'
import type { IntegrityEventInternal } from '~/app/utils/proctor-config'
import { apiUrl } from '~/app/utils/api-url'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseIntegrityFlushOptions {
  sessionId: number
}

export interface IntegrityEventPayload {
  kind: string
  ts: string
  payload: Record<string, unknown> | null
}

export interface UseIntegrityFlushReturn {
  /** Add a single integrity event to the pending batch. */
  addEvent: (event: IntegrityEventInternal) => void
  /** Flush a batch of events via POST /integrity using $fetch. */
  flush: (events: IntegrityEventInternal[]) => Promise<void>
  /** Flush events via navigator.sendBeacon (absolute URL, Blob/json). */
  flushViaBeacon: (events: IntegrityEventInternal[]) => void
  /** Flush the pending internal batch via sendBeacon (convenience for pagehide). */
  flushPendingViaBeacon: () => void
  /**
   * Remove the `pagehide` listener registered at construction. Called automatically
   * when the owning effect scope is disposed; exposed for callers created outside one.
   * Idempotent.
   */
  dispose: () => void
  /** The pending event batch (reactive). */
  pendingEvents: ReturnType<typeof ref<IntegrityEventInternal[]>>
}

// ---------------------------------------------------------------------------
// Helper: map internal event to API payload
// ---------------------------------------------------------------------------

function toApiPayload(event: IntegrityEventInternal): IntegrityEventPayload {
  return {
    kind: event.type, // type (internal) → kind (API contract)
    ts: event.ts,
    payload: event.meta ?? null,
  }
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export function useIntegrityFlush(options: UseIntegrityFlushOptions): UseIntegrityFlushReturn {
  const { sessionId } = options
  const pendingEvents = ref<IntegrityEventInternal[]>([])

  function buildBeaconUrl(): string {
    return apiUrl('/candidate/interview/integrity')
  }

  function addEvent(event: IntegrityEventInternal): void {
    pendingEvents.value = [...pendingEvents.value, event]
  }

  async function flush(events: IntegrityEventInternal[]): Promise<void> {
    if (events.length === 0) return

    await $fetch(apiUrl('/candidate/interview/integrity'), {
      method: 'POST',
      body: {
        session_id: sessionId,
        events: events.map(toApiPayload),
      },
    })
  }

  function flushViaBeacon(events: IntegrityEventInternal[]): void {
    const url = buildBeaconUrl()
    const payload = {
      session_id: sessionId,
      events: events.map(toApiPayload),
    }

    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
    const sent = navigator.sendBeacon(url, blob)

    if (!sent) {
      // Safari 64 KB cap exceeded — log degradation warning
      console.warn(
        '[useIntegrityFlush] sendBeacon returned false (payload may exceed 64 KB Safari cap)',
        { url, eventCount: events.length }
      )
    }
  }

  function flushPendingViaBeacon(): void {
    const events = pendingEvents.value
    if (events.length > 0) {
      flushViaBeacon(events)
      pendingEvents.value = []
    }
  }

  // Register pagehide listener to flush pending events on page unload.
  // Every call registered one and removed none, so each invocation leaked a listener
  // holding this whole closure. The teardown is bound to the caller's effect scope.
  let listening = false

  function dispose(): void {
    if (!listening) return
    listening = false
    window.removeEventListener('pagehide', flushPendingViaBeacon)
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushPendingViaBeacon)
    listening = true
    if (getCurrentScope()) onScopeDispose(dispose)
  }

  return {
    addEvent,
    flush,
    flushViaBeacon,
    flushPendingViaBeacon,
    dispose,
    pendingEvents,
  }
}
