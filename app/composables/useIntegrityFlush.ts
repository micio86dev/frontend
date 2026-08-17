/**
 * useIntegrityFlush — Integrity event flush composable (Task 3.4 GREEN;
 * migrated onto the single authenticated transport by Task 1.7/1.8 —
 * candidate-session-auth D-B, D-C)
 *
 * Manages a batch of integrity events and provides two flush paths:
 *   1. flush()           — POST /integrity via candidateFetch (normal flush, every 10s)
 *   2. flushViaBeacon()  — delegates to the shared `flushIntegrityKeepalive`
 *                           transport (fetch + keepalive + Authorization header;
 *                           used on pagehide and resize-triggered navigation)
 *
 * `navigator.sendBeacon` cannot carry an `Authorization` header, so it was
 * replaced by `fetch(..., { keepalive: true })` (D-C). That transport is
 * fire-and-forget by construction — its promise will not settle before the
 * page dies — so `flushPendingViaBeacon()` acknowledges (clears) the pending
 * batch ON DISPATCH, not on settlement.
 *
 * Verification warning, stated plainly rather than left implicit: acknowledging
 * on dispatch means a flush that is dispatched but never actually DELIVERED
 * (network refusal, the keepalive body exceeding its ~64 KiB practical cap, the
 * request racing the page's teardown and losing) drops that batch of
 * proctoring events SILENTLY from the candidate's evidence trail — the only
 * trace is `console.warn('[candidate-api] keepalive flush failed:', err)`
 * inside `flushIntegrityKeepalive`, logged to a browser console that is
 * closing at the exact moment the warning fires and that nothing server-side
 * ever reads. This is the same practical ceiling `sendBeacon` already had
 * (best-effort, no delivery guarantee) — not a regression — but it was never
 * written down before. There is no delivery-confirmation channel available
 * within this proposal's backend-unchanged, frontend-only scope; closing this
 * gap for real (e.g. a durable client-side retry queue, or a server-side
 * "did the last N seconds of proctoring evidence arrive" check) is a
 * candidate for the same follow-up track as the operator-visible stalled-
 * candidate alert (see tasks.md 5.3) — not solved here.
 *
 * Type → kind mapping: internal IntegrityEventInternal uses field `type`;
 * the C7a API contract uses field `kind`. All payload construction maps type → kind.
 *
 * SSR invariant: NO browser globals at module scope. navigator/window access is
 * inside function bodies only, not at module evaluation.
 *
 * Design refs: D-B, D-C (keepalive + type→kind), spec Coverage Note (sendBeacon via Playwright)
 */

import { getCurrentScope, onScopeDispose, ref } from 'vue'
import type { IntegrityEventInternal } from '~/app/utils/proctor-config'
import { candidateFetch, flushIntegrityKeepalive } from '~/app/utils/candidate-api'

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

  function addEvent(event: IntegrityEventInternal): void {
    pendingEvents.value = [...pendingEvents.value, event]
  }

  async function flush(events: IntegrityEventInternal[]): Promise<void> {
    if (events.length === 0) return

    await candidateFetch('/candidate/interview/integrity', {
      method: 'POST',
      body: {
        session_id: sessionId,
        events: events.map(toApiPayload),
      },
    })
  }

  /**
   * Delegates to the shared `flushIntegrityKeepalive` transport (D-C) instead
   * of `navigator.sendBeacon` — sendBeacon cannot carry the Authorization
   * header a candidate-scoped request requires.
   */
  function flushViaBeacon(events: IntegrityEventInternal[]): void {
    flushIntegrityKeepalive({
      session_id: sessionId,
      events: events.map(toApiPayload),
    })
  }

  /**
   * Dispatches the pending batch via the keepalive transport and clears it
   * immediately — acknowledge on dispatch (D-C). `fetch(..., { keepalive: true })`
   * returns a promise that will not settle before the page dies, so there is
   * no synchronous success signal left to gate the clear on.
   *
   * Evidence-loss ceiling: if the dispatched request never actually lands
   * (refused, oversized, or racing page teardown), this batch of proctoring
   * events is gone — cleared here, and the failure surfaces only as a
   * `console.warn` from a closing page. See the module docblock above.
   */
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
