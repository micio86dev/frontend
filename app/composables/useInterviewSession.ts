/**
 * useInterviewSession — Interview session state machine composable (Task 3.2 GREEN)
 *
 * Orchestrates the per-competency interview loop:
 *   POST /start → POST /utterance → POST /integrity → POST /end
 *
 * POST /snapshot is NOT owned here: the periodic proctoring snapshot is captured
 * from the camera video element, which only `useProctor` holds. `useProctor.takeSnapshot()`
 * is the single authoritative snapshot path; this composable supplies it with the
 * session id via the `sessionId` ref.
 *
 * State machine:
 *   idle → device_check → connecting → live → end_of_question → paused → done | error | terminal
 *
 * Provider ownership: this composable CREATES the provider and wires its events, then
 * publishes it via `activeProvider`/`activeConfig`. `AvatarPlayer` mounts it and calls
 * `provider.start(videoEl, config)` — the provider must be attached to the real <video>
 * element, which does not exist until the page renders the player. Starting the provider
 * here against a detached element left the interviewer's media unattached.
 *
 * SSR invariant: NO module-scope browser globals. All window/navigator access is inside
 * functions guarded by import.meta.client or callback context.
 *
 * Design refs: D3, D4, D5 (resize listener ownership), D10 (testing strategy)
 */

import { ref, shallowRef, type ShallowRef } from 'vue'
import { createProvider } from '~/app/providers/factory'
import type { InterviewProvider, StartConfig } from '~/app/types/interview-provider'
import type { IntegrityEventInternal } from '~/app/utils/proctor-config'
import {
  candidateFetch,
  flushIntegrityKeepalive,
  CandidateUnauthorizedError,
} from '~/app/utils/candidate-api'
import { useCandidateSession } from '~/app/composables/useCandidateSession'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionState =
  | 'idle'
  | 'device_check'
  | 'connecting'
  | 'live'
  | 'end_of_question'
  | 'paused'
  | 'done'
  | 'error'
  | 'terminal'

export type TerminalReason = '403' | 'absent_phrase' | 'session_expired' | 'malformed_response'

/** Reason passed to POST /end when the candidate (or the timer) cuts a question short. */
export type EndQuestionReason = 'timeout' | 'skipped'

export interface UseInterviewSessionOptions {
  /** Ordered list of competency codes from C6 bootstrap (used for last-competency detection). */
  competencies: string[]
  /** Pending integrity events for sendBeacon flush on resize. Managed externally by useProctor. */
  getPendingIntegrityEvents?: () => IntegrityEventInternal[]
  /**
   * Called with the exact events that were successfully handed to sendBeacon, so the
   * owner of the buffer can acknowledge (drop) them. NOT called when the beacon fails —
   * unacknowledged events stay pending rather than being silently lost.
   */

  onIntegrityEventsFlushed?: (events: IntegrityEventInternal[]) => void
}

export interface UseInterviewSessionReturn {
  state: ReturnType<typeof ref<SessionState>>
  retryAttemptCount: ReturnType<typeof ref<number>>
  currentCompetencyIndex: ReturnType<typeof ref<number>>
  terminalReason: ReturnType<typeof ref<TerminalReason | null>>
  /** DB session id from the latest /start response — null until the first /start succeeds. */
  sessionId: ReturnType<typeof ref<number | null>>
  /**
   * Provider awaiting mount by AvatarPlayer; null whenever no question is in flight.
   * shallowRef, not ref: providers hold SDK/WebRTC handles that must never be wrapped
   * in a reactive proxy.
   */
  activeProvider: ShallowRef<InterviewProvider | null>
  /** StartConfig for `activeProvider`; published together with it, never separately. */
  activeConfig: ShallowRef<StartConfig | null>
  acceptConsent: () => void
  confirmDevices: () => void
  pause: () => void
  resume: () => void
  retry: () => void
  nextCompetency: () => void
  /** End the current question early (5-minute timer expiry, or the candidate skipping). */

  endQuestion: (reason: EndQuestionReason) => Promise<void>
  teardown: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 3000

// ---------------------------------------------------------------------------
// Provider error normalisation
// ---------------------------------------------------------------------------

/**
 * Extract the machine-readable error code from a provider 'error' payload.
 *
 * Providers emit `{ code, message }` objects (heygen.ts / tavus.ts); the mock and
 * some tests emit a bare string. Reading the payload as a string unconditionally
 * meant `absent_phrase` was never matched against a real provider, and the state
 * fallback below silently absorbed every other failure under the same reason.
 */
function providerErrorCode(payload: unknown): string | null {
  if (typeof payload === 'string') return payload
  if (payload && typeof payload === 'object') {
    const code = (payload as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}

// ---------------------------------------------------------------------------
// /start response shape guard
// ---------------------------------------------------------------------------

/**
 * Explicit shape guard for the `/start` response, checked BEFORE
 * `question_context.end_phrase` is ever read.
 *
 * Without this, an unguarded destructure throws inside the try block on a
 * bad body; `status` is undefined on a plain TypeError, so it used to land in
 * the retryable `error` state — retrying forever against a server that will
 * answer identically. That is the same defect class the 401 fix addresses:
 * retry cannot fix a contract violation, so this is a non-retryable terminal.
 */
function isValidStartResponse(response: unknown): response is {
  session_id: string
  provider: string
  provider_token: string | null
  conversation_url: string | null
  question_context: {
    competency_code: string
    question_index: string
    end_phrase: string
    final_phrase: string
  }
} {
  if (!response || typeof response !== 'object') return false
  const r = response as Record<string, unknown>

  if (typeof r['session_id'] !== 'string' && typeof r['session_id'] !== 'number') return false
  if (typeof r['provider'] !== 'string' || r['provider'].length === 0) return false

  const questionContext = r['question_context']
  if (!questionContext || typeof questionContext !== 'object') return false
  const q = questionContext as Record<string, unknown>

  if (typeof q['end_phrase'] !== 'string' || q['end_phrase'].length === 0) return false
  if (typeof q['final_phrase'] !== 'string' || q['final_phrase'].length === 0) return false
  if (q['question_index'] === undefined || q['question_index'] === null) return false

  return true
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export function useInterviewSession(
  options: UseInterviewSessionOptions
): UseInterviewSessionReturn {
  const { competencies } = options

  // ---- State ---------------------------------------------------------------
  const state = ref<SessionState>('idle')
  const retryAttemptCount = ref(0)
  const currentCompetencyIndex = ref(0)
  const terminalReason = ref<TerminalReason | null>(null)
  const sessionId = ref<number | null>(null)
  const activeProvider = shallowRef<InterviewProvider | null>(null)
  const activeConfig = shallowRef<StartConfig | null>(null)

  // ---- Internal refs -------------------------------------------------------
  let provider: InterviewProvider | null = null
  let currentSessionId: number | null = null
  let currentQuestionIndex: number = 0
  let isResuming = false
  let resizeListener: (() => void) | null = null

  // ---- Helpers -------------------------------------------------------------

  function isMock(): boolean {
    const config = useRuntimeConfig()
    const value = (config.public as Record<string, unknown>).interviewProviderMock
    // C10 PR7 regression: Nuxt/Nitro coerces NUXT_PUBLIC_* env values via destr at
    // runtime, so a real deployment exposes the BOOLEAN `true`, not the string
    // 'true' — despite the string default ('') suggesting otherwise. A strict
    // `=== 'true'` comparison silently never activated the mock provider outside
    // of Vitest (which stubs useRuntimeConfig with literal strings).
    return value === true || value === 'true'
  }

  function transitionTo(next: SessionState) {
    state.value = next

    // Remove resize listener on terminal states
    if (next === 'done' || next === 'terminal' || next === 'error') {
      removeResizeListener()
    }

    // The provider only exists for the duration of a question. Unpublishing it here
    // unmounts AvatarPlayer, which releases the media session on its way out.
    if (next === 'end_of_question' || next === 'done' || next === 'error' || next === 'terminal') {
      clearActiveProvider()
    }

    // Verification Finding #1: the candidate session MUST be cleared on
    // EVERY `done`/`terminal` transition — not only on a live 401 (which
    // candidateFetch already clears internally, redundantly-but-harmlessly
    // re-cleared here too). Centralized here, not scattered per catch block,
    // so 403, absent_phrase, malformed_response, session_expired, and any
    // future terminal reason all go through the SAME line — a per-branch
    // patch is exactly the shape of fix the next new reason could forget.
    // `error` is deliberately excluded: it is retryable and the session may
    // still be valid (a 502/429 is an infrastructure failure, not an auth one).
    if (next === 'done' || next === 'terminal') {
      useCandidateSession().clear()
    }
  }

  function clearActiveProvider() {
    activeProvider.value = null
    activeConfig.value = null
  }

  function removeResizeListener() {
    if (resizeListener && typeof window !== 'undefined') {
      window.removeEventListener('resize', resizeListener)
      resizeListener = null
    }
  }

  function attachResizeListener() {
    if (typeof window === 'undefined') return

    resizeListener = () => {
      if (window.innerWidth < 1024) {
        // Flush integrity before navigating away, via the shared keepalive
        // transport (D-C) — replaces the hand-built `navigator.sendBeacon`
        // duplicate that used to live here (a second copy was a second chance
        // to miss the Authorization header). `fetch(..., { keepalive: true })`
        // returns a promise that will not settle before navigation completes,
        // so acknowledgement happens on dispatch, not on settlement — and if
        // the request never actually lands (refused, oversized, or racing the
        // navigation it precedes), these events are already acknowledged and
        // gone from the pending buffer, with only a console.warn (from a page
        // that is about to navigate away) marking the loss. Same ceiling
        // sendBeacon already had; written down here because it was not before.
        const pending = options.getPendingIntegrityEvents?.() ?? []
        if (pending.length > 0) {
          const payload = {
            session_id: currentSessionId,
            events: pending.map((e) => ({ kind: e.type, ts: e.ts, payload: e.meta ?? null })),
          }
          flushIntegrityKeepalive(payload)
          options.onIntegrityEventsFlushed?.(pending)
        }

        // Stop provider before navigating (suppress errors — non-fatal during teardown)
        if (provider) {
          provider.stop().catch(() => {})
        }

        removeResizeListener()
        navigateTo('/unsupported')
      }
    }

    window.addEventListener('resize', resizeListener)
  }

  async function sendUtterance(text: string, speaker: 'candidate' | 'avatar') {
    if (!currentSessionId) return
    try {
      await candidateFetch('/candidate/interview/utterance', {
        method: 'POST',
        body: {
          session_id: currentSessionId,
          speaker,
          text,
          ts: new Date().toISOString(),
        },
      })
    } catch (err) {
      // 401 → the stored session has already expired or been cleared
      // (candidateFetch clears it before throwing). Distinct, non-retryable
      // terminal — never falls into the "non-fatal, keep going" path below.
      if (err instanceof CandidateUnauthorizedError) {
        terminalReason.value = 'session_expired'
        transitionTo('terminal')
        return
      }

      // 409 = silently dropped; any other error is also non-fatal for utterance
      const status =
        (err as Record<string, unknown>)?.status ?? (err as Record<string, unknown>)?.statusCode
      if (status !== 409) {
        console.warn('[useInterviewSession] /utterance error (non-fatal):', err)
      }
    }
  }

  async function callEnd(endedReason: 'completed' | EndQuestionReason) {
    if (!currentSessionId) return

    try {
      await candidateFetch('/candidate/interview/end', {
        method: 'POST',
        body: {
          session_id: currentSessionId,
          ended_reason: endedReason,
        },
      })
    } catch (err) {
      // 401 → distinct, non-retryable terminal — checked BEFORE 403 so a
      // cleared/expired session is never mistaken for a gate refusal.
      if (err instanceof CandidateUnauthorizedError) {
        terminalReason.value = 'session_expired'
        transitionTo('terminal')
        return
      }

      const status =
        (err as Record<string, unknown>)?.status ?? (err as Record<string, unknown>)?.statusCode
      if (status === 409) {
        // 409 = successful no-op (race condition: both avatar-complete and timer fired)
        return
      }
      if (status === 403) {
        terminalReason.value = '403'
        transitionTo('terminal')
        return
      }
      // Other errors on /end — log but don't block the transition
      console.warn('[useInterviewSession] /end unexpected error:', err)
    }
  }

  function wireProviderEvents() {
    if (!provider) return

    provider.on('state', (payload) => {
      const providerState = payload as string

      if (providerState === 'ready' || providerState === 'listening') {
        if (state.value === 'connecting') {
          transitionTo('live')
          attachResizeListener()
        }
      }

      if (providerState === 'complete') {
        handleProviderComplete()
      }
    })

    provider.on('transcript', (payload) => {
      const entry = payload as { role: 'user' | 'avatar'; text: string; ts: number }
      const speaker = entry.role === 'user' ? 'candidate' : 'avatar'
      sendUtterance(entry.text, speaker).catch(() => {})
    })

    provider.on('error', (payload) => {
      const code = providerErrorCode(payload)

      // `absent_phrase` is a DOMAIN verdict: the avatar never spoke the configured
      // end/final phrase, so the interview's validity is in question. It is terminal
      // and NOT retryable. Every other provider failure (WebRTC drop, SDK error,
      // provider timeout) is an infrastructure failure — it gets the retryable error
      // screen. Reporting those as `absent_phrase` told candidates they had failed a
      // presence check when the connection had simply died.
      if (code === 'absent_phrase') {
        terminalReason.value = 'absent_phrase'
        transitionTo('terminal')
        stopProvider()
        return
      }

      if (state.value === 'live' || state.value === 'connecting') {
        transitionTo('error')
        stopProvider()
      }
    })
  }

  function stopProvider() {
    if (provider) {
      provider.stop().catch(() => {})
    }
  }

  /** Transition out of a finished question: done on the last competency, else end_of_question. */
  function advanceAfterQuestion() {
    // Check current state — it may have been set to terminal by a 403 from /end
    if (state.value === 'terminal') return

    // Last-competency detection: question_index is 0-based
    const isLastCompetency = currentQuestionIndex + 1 >= competencies.length
    transitionTo(isLastCompetency ? 'done' : 'end_of_question')
  }

  function handleProviderComplete() {
    // Avatar signalled completion → call /end with 'completed'
    callEnd('completed')
      .then(advanceAfterQuestion)
      .catch(() => {})
  }

  async function startSession(attemptNumber = 0) {
    transitionTo('connecting')

    try {
      const response = await candidateFetch<{
        session_id: string
        provider: string
        provider_token: string | null
        conversation_url: string | null
        question_context: {
          competency_code: string
          question_index: string
          end_phrase: string
          final_phrase: string
        }
      }>('/candidate/interview/start', {
        method: 'POST',
      })

      if (!isValidStartResponse(response)) {
        isResuming = false
        terminalReason.value = 'malformed_response'
        transitionTo('terminal')
        return
      }

      // D4: end_phrase and final_phrase come from NESTED question_context — NOT top-level
      const { end_phrase, final_phrase } = response.question_context
      currentSessionId = Number(response.session_id)
      sessionId.value = currentSessionId
      currentQuestionIndex = Number(response.question_context.question_index)

      // Create provider
      provider = createProvider(response.provider as 'heygen' | 'tavus', isMock())

      // Wire BEFORE publishing: AvatarPlayer mounts and starts the provider as soon as
      // activeProvider/activeConfig are set, and the very first event it can emit
      // (absent_phrase) must already have a listener.
      wireProviderEvents()

      const startConfig: StartConfig = {
        dbSessionId: currentSessionId,
        sessionToken: response.provider_token ?? undefined,
        conversationUrl: response.conversation_url ?? undefined,
        endPhrase: end_phrase,
        finalPhrase: final_phrase,
      }

      // Publish for AvatarPlayer. provider.start() is deliberately NOT called here:
      // it must receive the real <video> element the player owns.
      activeConfig.value = startConfig
      activeProvider.value = provider
    } catch (err) {
      isResuming = false

      // 401 → distinct, non-retryable terminal. Checked BEFORE any status
      // inspection: CandidateUnauthorizedError carries no .status/.statusCode
      // (it is thrown by candidateFetch's onResponseError, or synchronously
      // when the stored session had already expired before the call was
      // attempted), so it would otherwise fall through to the generic
      // "any other error → retryable" branch below — retrying forever
      // against a session that can never re-authenticate itself.
      if (err instanceof CandidateUnauthorizedError) {
        terminalReason.value = 'session_expired'
        transitionTo('terminal')
        return
      }

      const status =
        (err as Record<string, unknown>)?.status ?? (err as Record<string, unknown>)?.statusCode

      if (status === 403) {
        terminalReason.value = '403'
        transitionTo('terminal')
        return
      }

      if (status === 429) {
        // provider_busy: retry with backoff (max MAX_ATTEMPTS total)
        const nextAttempt = attemptNumber + 1
        if (nextAttempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
          await startSession(nextAttempt)
        } else {
          // Exhausted all attempts → retryable error
          retryAttemptCount.value = 0
          transitionTo('error')
        }
        return
      }

      // 502 or any other error → retryable error
      transitionTo('error')
    } finally {
      isResuming = false
    }
  }

  // ---- Public API ----------------------------------------------------------

  function acceptConsent() {
    transitionTo('device_check')
  }

  function confirmDevices() {
    if (isResuming) return
    isResuming = true

    // If there's an existing provider, stop it (resume-on-remount guard)
    if (provider) {
      provider.stop().catch(() => {})
      provider = null
    }
    clearActiveProvider()

    startSession(0)
  }

  function pause() {
    if (state.value === 'end_of_question') {
      state.value = 'paused'
    }
  }

  function resume() {
    if (state.value === 'paused') {
      state.value = 'end_of_question'
    }
  }

  function retry() {
    retryAttemptCount.value = 0
    confirmDevices()
  }

  function nextCompetency() {
    if (state.value === 'end_of_question') {
      currentCompetencyIndex.value += 1
      confirmDevices()
    }
  }

  /**
   * End the current question early — the 5-minute timer expired, or the candidate
   * pressed Skip. Both were previously inert affordances on the interview page.
   *
   * Unlike the `completed` path (the avatar signalled its own completion), the
   * provider is cut off mid-turn here, so it is stopped explicitly.
   */
  async function endQuestion(reason: EndQuestionReason): Promise<void> {
    if (state.value !== 'live') return

    await callEnd(reason)
    stopProvider()
    advanceAfterQuestion()
  }

  async function teardown() {
    removeResizeListener()
    clearActiveProvider()
    if (provider) {
      await provider.stop().catch(() => {})
      provider = null
    }
  }

  return {
    state,
    retryAttemptCount,
    currentCompetencyIndex,
    terminalReason,
    sessionId,
    activeProvider,
    activeConfig,
    acceptConsent,
    confirmDevices,
    pause,
    resume,
    retry,
    nextCompetency,
    endQuestion,
    teardown,
  }
}
