/**
 * candidate-api — the single authenticated transport for every candidate-scoped
 * request (D-B).
 *
 * One `ofetch.create()` instance backs `candidateFetch`. Its `onRequest`
 * attaches `Authorization: Bearer <token>`; its `onResponseError` maps a `401`
 * to clearing the stored session and throwing a typed, terminal
 * `CandidateUnauthorizedError` — a candidate has no refresh endpoint and no
 * login page, so `401` is never retried and never silently swallowed.
 *
 * A missing or expired stored session prevents the call from being attempted
 * at all: `candidateFetch` rejects BEFORE the underlying instance is invoked,
 * so no candidate request is ever sent unauthenticated (spec: "Every
 * candidate request is authenticated").
 *
 * `flushIntegrityKeepalive` is the `navigator.sendBeacon` replacement (D-C).
 * `sendBeacon` cannot set headers, so the pagehide integrity flush needs its
 * own transport: `fetch(..., { keepalive: true })` carrying the same
 * Authorization header. It is fire-and-forget by construction — the promise
 * will not settle before the page dies, so callers acknowledge on dispatch,
 * not on settlement.
 *
 * Guard: `tests/unit/candidate-fetch-guard.spec.ts` asserts no other file
 * under `frontend/app/` reaches a `/candidate/` URL outside this module.
 */

import { ofetch, type FetchOptions } from 'ofetch'
import { apiUrl } from './api-url'
import { useCandidateSession } from '~/app/composables/useCandidateSession'

export class CandidateUnauthorizedError extends Error {
  constructor(message = 'Candidate session unauthorized') {
    super(message)
    this.name = 'CandidateUnauthorizedError'
  }
}

const candidateInstance = ofetch.create({
  async onRequest({ options }) {
    const session = useCandidateSession().read()
    if (!session) return

    const headers = new Headers(options.headers as HeadersInit | undefined)
    headers.set('Authorization', `Bearer ${session.accessToken}`)
    options.headers = headers
  },
  async onResponseError({ response }) {
    if (response.status === 401) {
      useCandidateSession().clear()
      throw new CandidateUnauthorizedError()
    }
  },
})

/**
 * Every candidate-scoped request MUST go through this function — the five
 * interview endpoints (`/start`, `/utterance`, `/integrity`, `/snapshot`,
 * `/end`) and `GET /api/candidate/session`.
 */
export function candidateFetch<T>(path: string, options: FetchOptions<'json'> = {}): Promise<T> {
  const session = useCandidateSession().read()
  if (!session) {
    return Promise.reject(new CandidateUnauthorizedError('No candidate session available'))
  }

  return candidateInstance<T>(apiUrl(path), options)
}

/**
 * Fire-and-forget replacement for `navigator.sendBeacon` on the pagehide
 * integrity flush. No stored session → nothing to authenticate with; the
 * attempt is refused (never sent unauthenticated) and the refusal is logged
 * so a failed flush is never silently indistinguishable from a successful one.
 *
 * Evidence-loss ceiling, stated plainly: callers (`useIntegrityFlush`,
 * `useInterviewSession`'s resize handler) acknowledge the flushed events
 * on DISPATCH, not on delivery, because a keepalive fetch's promise will not
 * settle before the page dies. If the underlying `fetch` below never actually
 * reaches the server — refused, oversized, or racing teardown — those
 * proctoring events are already gone from the pending buffer, and the only
 * trace of the loss is the `console.warn` calls below, logged from a page
 * that is in the process of closing. This is the same practical ceiling
 * `sendBeacon` already had; it is written down here because it was not
 * before.
 */
export function flushIntegrityKeepalive(payload: unknown): void {
  const session = useCandidateSession().read()
  if (!session) {
    console.warn(
      '[candidate-api] keepalive flush skipped — no candidate session (refused, not sent unauthenticated)'
    )
    return
  }

  try {
    fetch(apiUrl('/candidate/interview/integrity'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch((err: unknown) => {
      console.warn('[candidate-api] keepalive flush failed:', err)
    })
  } catch (err) {
    // Replaces the old `if (!sent) console.warn(...)` check — fetch offers no
    // synchronous success signal, so a synchronous throw is the only thing a
    // try/catch here can still guard against.
    console.warn('[candidate-api] keepalive flush threw synchronously:', err)
  }
}
