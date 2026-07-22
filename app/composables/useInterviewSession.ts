/**
 * useInterviewSession — Interview session state machine composable (Task 3.2 GREEN)
 *
 * Orchestrates the 5-endpoint per-competency interview loop:
 *   POST /start → POST /utterance → POST /integrity → POST /snapshot → POST /end
 *
 * State machine:
 *   idle → device_check → connecting → live → end_of_question → paused → done | error | terminal
 *
 * SSR invariant: NO module-scope browser globals. All window/navigator access is inside
 * functions guarded by import.meta.client or callback context.
 *
 * Design refs: D3, D4, D5 (resize listener ownership), D10 (testing strategy)
 */

import { ref } from 'vue'
import { $fetch } from 'ofetch'
import { createProvider } from '~/app/providers/factory'
import type { InterviewProvider } from '~/app/types/interview-provider'
import type { IntegrityEventInternal } from '~/app/utils/proctor-config'

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

export type TerminalReason = '403' | 'absent_phrase'

export interface UseInterviewSessionOptions {
  /** Ordered list of competency codes from C6 bootstrap (used for last-competency detection). */
  competencies: string[]
  /** Pending integrity events for sendBeacon flush on resize. Managed externally by useProctor. */
  getPendingIntegrityEvents?: () => IntegrityEventInternal[]
}

export interface UseInterviewSessionReturn {
  state: ReturnType<typeof ref<SessionState>>
  retryAttemptCount: ReturnType<typeof ref<number>>
  currentCompetencyIndex: ReturnType<typeof ref<number>>
  terminalReason: ReturnType<typeof ref<TerminalReason | null>>
  acceptConsent: () => void
  confirmDevices: (mountEl?: HTMLElement) => void // eslint-disable-line no-unused-vars
  pause: () => void
  resume: () => void
  retry: () => void
  nextCompetency: (mountEl?: HTMLElement) => void // eslint-disable-line no-unused-vars
  teardown: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 3000
const SNAPSHOT_INTERVAL_MS = 10_000

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

  // ---- Internal refs -------------------------------------------------------
  let provider: InterviewProvider | null = null
  let currentSessionId: number | null = null
  let currentQuestionIndex: number = 0
  let isResuming = false
  let resizeListener: (() => void) | null = null
  let snapshotIntervalId: ReturnType<typeof setInterval> | null = null

  // ---- Helpers -------------------------------------------------------------

  function getApiBase(): string {
    const config = useRuntimeConfig()
    return config.public.apiBase as string
  }

  function isMock(): boolean {
    const config = useRuntimeConfig()
    return (config.public as Record<string, unknown>).interviewProviderMock === 'true'
  }

  function transitionTo(next: SessionState) {
    state.value = next

    // Remove resize listener on terminal states
    if (next === 'done' || next === 'terminal' || next === 'error') {
      removeResizeListener()
      clearSnapshotInterval()
    }
  }

  function removeResizeListener() {
    if (resizeListener && typeof window !== 'undefined') {
      window.removeEventListener('resize', resizeListener)
      resizeListener = null
    }
  }

  function clearSnapshotInterval() {
    if (snapshotIntervalId !== null) {
      clearInterval(snapshotIntervalId)
      snapshotIntervalId = null
    }
  }

  function attachResizeListener() {
    if (typeof window === 'undefined') return

    resizeListener = () => {
      if (window.innerWidth < 1024) {
        // Flush integrity via sendBeacon before navigating
        const pending = options.getPendingIntegrityEvents?.() ?? []
        if (pending.length > 0) {
          const apiBase = getApiBase()
          const url = `${apiBase}/api/candidate/interview/integrity`
          const payload = {
            session_id: currentSessionId,
            events: pending.map((e) => ({ kind: e.type, ts: e.ts, payload: e.meta ?? null })),
          }
          try {
            navigator.sendBeacon(
              url,
              new Blob([JSON.stringify(payload)], { type: 'application/json' })
            )
          } catch {
            // Non-fatal
          }
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
      await $fetch(`${getApiBase()}/api/candidate/interview/utterance`, {
        method: 'POST',
        body: {
          session_id: currentSessionId,
          speaker,
          text,
          ts: new Date().toISOString(),
        },
      })
    } catch (err) {
      // 409 = silently dropped; any other error is also non-fatal for utterance
      const status =
        (err as Record<string, unknown>)?.status ?? (err as Record<string, unknown>)?.statusCode
      if (status !== 409) {
        console.warn('[useInterviewSession] /utterance error (non-fatal):', err)
      }
    }
  }

  async function sendSnapshot() {
    if (!currentSessionId) return
    // In production this would capture a frame from the video element.
    // The composable delegates the actual capture to the caller; here we
    // accept an optional image_base64 from the mount element context.
    // For now we skip if no image source is wired.
  }

  function startSnapshotInterval() {
    clearSnapshotInterval()
    snapshotIntervalId = setInterval(() => {
      sendSnapshot().catch((err) => {
        const status =
          (err as Record<string, unknown>)?.status ?? (err as Record<string, unknown>)?.statusCode
        if (status === 413 || status === 422) {
          console.warn('[useInterviewSession] /snapshot non-fatal error:', status)
        }
      })
    }, SNAPSHOT_INTERVAL_MS)
  }

  async function callEnd(endedReason: 'completed' | 'timeout' | 'skipped') {
    if (!currentSessionId) return

    try {
      await $fetch(`${getApiBase()}/api/candidate/interview/end`, {
        method: 'POST',
        body: {
          session_id: currentSessionId,
          ended_reason: endedReason,
        },
      })
    } catch (err) {
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
          startSnapshotInterval()
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
      const reason = payload as string
      // absent_phrase or any provider error → terminal (not retryable)
      if (reason === 'absent_phrase' || state.value === 'live' || state.value === 'connecting') {
        terminalReason.value = 'absent_phrase'
        transitionTo('terminal')
        if (provider) {
          provider.stop().catch(() => {})
        }
      }
    })
  }

  function handleProviderComplete() {
    // Avatar signalled completion → call /end with 'completed'
    callEnd('completed')
      .then(() => {
        // Check current state — it may have been set to terminal by a 403 from /end
        if (state.value === 'terminal') return

        // Last-competency detection: question_index is 0-based
        const isLastCompetency = currentQuestionIndex + 1 >= competencies.length
        if (isLastCompetency) {
          transitionTo('done')
        } else {
          transitionTo('end_of_question')
        }
      })
      .catch(() => {})
  }

  async function startSession(mountEl?: HTMLElement, attemptNumber = 0) {
    transitionTo('connecting')

    try {
      const response = await $fetch<{
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
      }>(`${getApiBase()}/api/candidate/interview/start`, {
        method: 'POST',
      })

      // D4: end_phrase and final_phrase come from NESTED question_context — NOT top-level
      const { end_phrase, final_phrase } = response.question_context
      currentSessionId = Number(response.session_id)
      currentQuestionIndex = Number(response.question_context.question_index)

      // Create provider
      provider = createProvider(response.provider as 'heygen' | 'tavus', isMock())

      wireProviderEvents()

      const startConfig = {
        dbSessionId: currentSessionId,
        sessionToken: response.provider_token ?? undefined,
        conversationUrl: response.conversation_url ?? undefined,
        endPhrase: end_phrase,
        finalPhrase: final_phrase,
      }

      const el = mountEl ?? document.createElement('div')
      await provider.start(el, startConfig)
    } catch (err) {
      isResuming = false
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
          await startSession(mountEl, nextAttempt)
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

  function confirmDevices(_mountEl?: HTMLElement) {
    if (isResuming) return
    isResuming = true

    // If there's an existing provider, stop it (resume-on-remount guard)
    if (provider) {
      provider.stop().catch(() => {})
      provider = null
    }

    startSession(_mountEl, 0)
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

  function nextCompetency(_mountEl?: HTMLElement) {
    if (state.value === 'end_of_question') {
      currentCompetencyIndex.value += 1
      confirmDevices(_mountEl)
    }
  }

  async function teardown() {
    removeResizeListener()
    clearSnapshotInterval()
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
    acceptConsent,
    confirmDevices,
    pause,
    resume,
    retry,
    nextCompetency,
    teardown,
  }
}
