<template>
  <main
    v-if="exchangeState === 'exchanging'"
    class="flex min-h-screen flex-col items-center justify-center bg-background p-4"
    aria-live="polite"
    aria-busy="true"
  >
    <div class="flex flex-col items-center gap-4">
      <Skeleton class="h-48 w-full max-w-2xl rounded-lg" />
      <Skeleton class="h-4 w-48 rounded" />
    </div>
  </main>

  <!--
    Exchange failed — rendered INLINE on this SAME `/embed/{token}` route
    rather than `navigateTo`'d to `/interview/terminal` the way the hosted
    `/i/{token}` flow does on the equivalent failure. Navigating away would
    leave the org-scoped `frame-ancestors` CSP this route's own
    `server/middleware/embed-csp.ts` sets behind: `/interview/terminal` has no
    such override and inherits the blanket `/**` rule's `X-Frame-Options: DENY`
    (`nuxt.config.ts`), which would make the candidate's error screen refuse
    to render inside the host's iframe at all.
  -->
  <main
    v-else-if="exchangeState === 'error'"
    class="flex min-h-screen flex-col items-center justify-center bg-background p-4"
  >
    <section
      class="flex max-w-lg flex-col gap-6 rounded-xl border border-border bg-card p-8 shadow-md"
      aria-labelledby="embed-error-heading"
      data-testid="embed-error-screen"
    >
      <h1 id="embed-error-heading" class="text-2xl font-semibold text-foreground">
        {{ $t(`interview.terminal.${exchangeErrorReason}.title`) }}
      </h1>
      <p class="text-sm text-muted-foreground">
        {{ $t(`interview.terminal.${exchangeErrorReason}.body`) }}
      </p>
    </section>
  </main>

  <InterviewSession v-else ref="interviewRef" />
</template>

<script setup lang="ts">
/**
 * Embed entry route — `/embed/{token}` (public-api step 10, SPEC.md §4.4).
 *
 * The iframe-side counterpart to the hosted `/i/{token}` route
 * (`app/pages/i/[token].vue`): same `GET /api/embed/exchange` session-token
 * exchange, same single-use/refresh-safety concerns — but renders
 * `InterviewSession.vue` DIRECTLY on THIS route once the exchange succeeds,
 * rather than `navigateTo`'ing to the token-free `/interview/session` route.
 * Staying on `/embed/{token}` matters here specifically: it is the ONLY path
 * `server/middleware/embed-csp.ts` sets the organization-scoped
 * `frame-ancestors` header for, and it is the URL the host's iframe `src`
 * actually points at — navigating away would either break framing (a route
 * with no CSP override) or silently drop the iframe out of the host's
 * control entirely.
 *
 * Also owns the `@beai/embed` postMessage bridge (`useEmbedBridge`) — see
 * that composable's own doc for the wire-level protocol this page speaks
 * from the iframe side, mirroring `embed/src/embed.ts`'s host-side
 * `BeaiEmbed` class.
 *
 * PROVIDER-CONNECTION RETRY (SPEC §4.4: "provider connection failure (retry
 * ×3 then error{recoverable:false})"): `useInterviewSession`'s own `/start`
 * handling already retries a `429 provider_busy` up to its own
 * `MAX_ATTEMPTS`/`RETRY_DELAY_MS` internally and lands on its `error` state
 * for that and every other `/start` failure. This page adds ONE more layer
 * on top, scoped to what the embed contract specifically promises the HOST:
 * on `error`, it calls the EXISTING `session.retry()` up to
 * `AUTO_RETRY_MAX_ATTEMPTS` times with `AUTO_RETRY_DELAY_MS` backoff — the
 * SAME cadence `useInterviewSession`'s own constants use — and only once
 * those are exhausted (still `error`) or the machine reaches a non-retryable
 * `terminal` does it tell the host `error{recoverable:false}`. Nothing here
 * modifies `useInterviewSession.ts` itself.
 *
 * noindex: this route is session-gated and must never be indexed.
 */
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { $fetch } from 'ofetch'
import { Skeleton } from '~/components/ui/skeleton'
import InterviewSession from '~/components/InterviewSession.vue'
import { apiUrl } from '~/app/utils/api-url'
import { decodeJwtPayload } from '~/app/utils/jwt-decode'
import { useCandidateSession, type CandidateSession } from '~/app/composables/useCandidateSession'
import { useEmbedBridge } from '~/app/composables/useEmbedBridge'
import type { operations } from '~~/types/api'

type ExchangeResponse =
  operations['exchange.exchange']['responses'][200]['content']['application/json']

type FramePolicyResponse =
  operations['exchange.framePolicy']['responses'][200]['content']['application/json']

definePageMeta({ ssr: false })
useHead({
  meta: [
    { name: 'robots', content: 'noindex, nofollow' },
    { name: 'referrer', content: 'no-referrer' },
  ],
})

/** Matches useInterviewSession's own MAX_ATTEMPTS for /start retries — see this file's top doc. */
const AUTO_RETRY_MAX_ATTEMPTS = 3
/** Matches useInterviewSession's own RETRY_DELAY_MS for /start retries. */
const AUTO_RETRY_DELAY_MS = 3_000

const route = useRoute()

type ExchangeState = 'exchanging' | 'ready' | 'error'
const exchangeState = ref<ExchangeState>('exchanging')
type ExchangeErrorReason = 'link_used' | 'link_invalid' | '403' | 'unavailable'
const exchangeErrorReason = ref<ExchangeErrorReason>('403')
const allowedOrigins = ref<string[]>([])
const interviewRef = ref<InstanceType<typeof InterviewSession> | null>(null)

function readErrorStatus(err: unknown): unknown {
  return (err as Record<string, unknown>)?.status ?? (err as Record<string, unknown>)?.statusCode
}

/**
 * Maps a failed `/embed/exchange` status to the candidate-visible reason and
 * whether the host may treat the failure as transient. Only statuses that
 * genuinely mean "this link will never work" are non-recoverable; a network
 * failure (no status), 429 or 5xx is an outage, never a permission problem.
 */
function mapExchangeError(status: unknown): {
  reason: ExchangeErrorReason
  recoverable: boolean
} {
  if (status === 410) return { reason: 'link_used', recoverable: false }
  if (status === 401 || status === 404) {
    return { reason: 'link_invalid', recoverable: false }
  }
  if (status === 403) return { reason: '403', recoverable: false }
  return { reason: 'unavailable', recoverable: true }
}

function storedSessionMatchesSessionToken(
  stored: CandidateSession | null,
  sessionTokenClaims: Record<string, unknown> | null
): boolean {
  if (!stored?.interviewId || !sessionTokenClaims) return false
  return stored.interviewId === sessionTokenClaims['sub']
}

async function fetchAllowedOrigins(token: string): Promise<void> {
  try {
    const response = await $fetch<FramePolicyResponse>(apiUrl('/embed/frame-policy'), {
      method: 'GET',
      params: { token },
    })
    allowedOrigins.value = Array.isArray(response.allowed_domains) ? response.allowed_domains : []
  } catch {
    // Fails safe to an empty list — the bridge then accepts no inbound host
    // message at all (`isHostnameAllowed` refuses everything against []),
    // the same fail-closed posture the CSP header takes on the same failure.
    allowedOrigins.value = []
  }
}

// ---------------------------------------------------------------------------
// postMessage bridge (SPEC §4.3/§4.4)
// ---------------------------------------------------------------------------

const bridge = useEmbedBridge({
  getAllowedOrigins: () => allowedOrigins.value,
  // SPEC §4.4: "start() before consent is queued, not executed." Nothing
  // here needs to act on it — InterviewSession.vue's own state machine
  // already requires consent + device-check before any provider connection,
  // regardless of whether or when `start` arrives, so there is no bypass to
  // guard against. No-op kept explicit (rather than omitting `onStart`
  // entirely) so the intent reads at the call site.
  onStart: () => {},
})

async function exchangeAndMount(): Promise<void> {
  const token = String(route.params['token'] ?? '')
  const session = useCandidateSession()
  const stored = session.read()
  const sessionTokenClaims = decodeJwtPayload(token)

  void fetchAllowedOrigins(token) // independent of the exchange; runs in parallel

  if (storedSessionMatchesSessionToken(stored, sessionTokenClaims)) {
    exchangeState.value = 'ready'
    return
  }

  try {
    const response = await $fetch<ExchangeResponse>(apiUrl('/embed/exchange'), {
      method: 'GET',
      params: { token },
    })
    const interviewId =
      typeof sessionTokenClaims?.['sub'] === 'string' ? sessionTokenClaims['sub'] : undefined
    session.store(response.access_token, { interviewId })
    exchangeState.value = 'ready'
  } catch (err) {
    const { reason, recoverable } = mapExchangeError(readErrorStatus(err))
    exchangeErrorReason.value = reason
    exchangeState.value = 'error'
    bridge.post('error', {
      code: reason,
      message: 'The embed session token could not be exchanged for a candidate session.',
      recoverable,
    })
  }
}

// ---------------------------------------------------------------------------
// Session state → protocol event mapping. Reads the InterviewSession child's
// EXPOSED `session` (InterviewSession.vue's own `defineExpose({ session })`)
// rather than re-instantiating useInterviewSession() here — a second call
// would create a SECOND, independent state machine racing the real one.
// ---------------------------------------------------------------------------

function clearRetryTimer(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

let stopWatchers: Array<() => void> = []
let autoRetryAttempts = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null
let interviewIdForCompletion: string | undefined
let permissionsWatched = false

function watchInterviewSession(): void {
  const instance = interviewRef.value
  if (!instance) return

  const session = instance.session
  interviewIdForCompletion = useCandidateSession().read()?.interviewId

  stopWatchers.push(
    watch(
      () => session.state.value,
      (state, previousState) => {
        if (state === 'device_check' && previousState === 'idle') {
          bridge.post('consent:granted')
        }

        if (state === 'live') {
          // A recovered session gets a fresh auto-retry budget.
          autoRetryAttempts = 0
          if (previousState !== 'live') bridge.post('started')
        }

        if (state === 'done') {
          bridge.post('completed', { interviewId: interviewIdForCompletion ?? '' })
        }

        if (state === 'error') {
          handleErrorState()
        }

        if (state === 'terminal') {
          autoRetryAttempts = 0
          bridge.post('error', {
            code: session.terminalReason.value ?? 'unknown',
            message: 'The interview could not continue and cannot be retried.',
            recoverable: false,
          })
        }
      }
    )
  )

  stopWatchers.push(
    watch(
      () => session.sessionId.value,
      (sessionId, previousSessionId) => {
        if (sessionId === null || sessionId === previousSessionId) return
        bridge.post('question:changed', {
          index: session.endedCompetencies.value ?? 0,
          total: session.totalCompetencies.value ?? 0,
        })
      }
    )
  )

  function handleErrorState(): void {
    if (autoRetryAttempts < AUTO_RETRY_MAX_ATTEMPTS) {
      autoRetryAttempts += 1
      clearRetryTimer()
      retryTimer = setTimeout(() => {
        retryTimer = null
        // The session may have moved on (candidate navigated away, or a manual
        // retry already happened) while this backoff was in flight.
        if (session.state.value === 'error') {
          session.retry()
        }
      }, AUTO_RETRY_DELAY_MS)
      return
    }

    autoRetryAttempts = 0
    bridge.post('error', {
      code: 'provider_connection_failed',
      message: 'The avatar provider connection failed after multiple retries.',
      recoverable: false,
    })
  }
}

/**
 * Best-effort camera/microphone permission-denied signal, independent of
 * `DeviceCheck`'s own internal state (that composable is instantiated INSIDE
 * `InterviewSession.vue`'s own child tree and shares nothing with a second
 * call from here). The Permissions API's `'camera'`/`'microphone'` query
 * names are not universally supported (notably Safari) — every step here is
 * wrapped so an unsupported browser degrades to simply never emitting this
 * one event, never to a thrown error.
 */
function watchPermissions(): void {
  if (permissionsWatched || typeof navigator === 'undefined' || !navigator.permissions) return
  permissionsWatched = true

  for (const name of ['camera', 'microphone'] as const) {
    navigator.permissions
      .query({ name: name as PermissionName })
      .then((status) => {
        if (status.state === 'denied') bridge.post('permissions:denied')
        status.onchange = () => {
          if (status.state === 'denied') bridge.post('permissions:denied')
        }
      })
      .catch(() => {
        // Unsupported permission name (Safari/Firefox) — no signal from this
        // source; DeviceCheck's own in-flow error UI still covers the
        // candidate-visible side of a denial.
      })
  }
}

watch(interviewRef, (instance) => {
  if (instance) {
    watchInterviewSession()
    watchPermissions()
    bridge.post('ready')
  }
})

onMounted(() => {
  bridge.attach()
  void exchangeAndMount()
})

onUnmounted(() => {
  clearRetryTimer()
  bridge.detach()
  for (const stop of stopWatchers) stop()
  stopWatchers = []
})
</script>
