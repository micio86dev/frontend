<template>
  <main
    class="flex min-h-screen flex-col items-center justify-center bg-background p-4"
    aria-live="polite"
    aria-busy="true"
  >
    <div class="flex flex-col items-center gap-4">
      <Skeleton class="h-48 w-full max-w-2xl rounded-lg" />
      <Skeleton class="h-4 w-48 rounded" />
    </div>
  </main>
</template>

<script setup lang="ts">
/**
 * Public-api hosted entry route — `/i/{token}` (public-api step 5, G-32, G-33).
 *
 * The counterpart to `interview/[token].vue`, for candidates who open the
 * link directly (top-level, not the SSO-link flow). Its `token` route param
 * is a PUBLIC-API SESSION token (SPEC §3.5: `iss=beai`, `sub=int_…`,
 * `aud=embed`, single-use, 15-minute TTL) — a different token shape than the
 * sso-link JWT the sibling route consumes.
 *
 * Renders NOTHING durable. On mount, in order:
 *   1. Decode the session token's own claims (unverified — server
 *      re-validates) to read its `sub` (`int_…`, the interview's public id).
 *      If a stored candidate session already carries a matching
 *      `interviewId` (set at step 3 below on a PRIOR visit), the exchange is
 *      SKIPPED — the session token stays unspent — and the candidate is
 *      navigated straight to the token-free session route. This mirrors
 *      `storedSessionMatchesLink` in the sibling route: "may I reuse what I
 *      already hold", never a client-trusted authorization decision.
 *   2. Otherwise, `GET /api/embed/exchange?token=…` EXACTLY ONCE. Per G-32
 *      the api verifies the session token, atomically consumes its `jti`,
 *      and returns the SAME candidate-JWT shape the sso-link exchange
 *      returns — `{ access_token }`, no cookie. Re-exchanging an
 *      already-consumed token 410s, so refresh-safety matters exactly as
 *      much here as it does for the sso-link flow.
 *   3. Persist the returned candidate JWT, tagged with this session token's
 *      `sub` as `interviewId` (step 1's match key), then `navigateTo` the
 *      session route with `replace: true` — removes the token URL from the
 *      history entry so neither Back nor a refresh can land on the exchange
 *      again.
 *
 * Error mapping (G-32 — status code alone disambiguates; the api never
 * returns these two codes for any other reason on this endpoint):
 *   - 410 `token_consumed` → terminal `reason=link_used` (already used or
 *     replaced by a later mint).
 *   - 401 `token_invalid` → terminal `reason=link_invalid` (expired,
 *     mis-signed, or wrong-audience).
 *   - anything else (network error, unexpected status) → the existing
 *     generic terminal (`reason=403`), same fallback `interview/[token].vue`
 *     uses. Unlike the sso-link exchange's 403, `/api/embed/exchange` sends
 *     NO `redirect_url` (G-32 documents no cookie/redirect surface) — there
 *     is nothing to read from the error body here.
 *
 * `useInterviewSession` is NOT imported here, for the same reason it is not
 * imported in `interview/[token].vue`: this route only stores the candidate
 * JWT and hands off.
 *
 * noindex: this route is session-gated and must never be indexed.
 */
import { onMounted } from 'vue'
import { $fetch } from 'ofetch'
import { Skeleton } from '~/components/ui/skeleton'
import { apiUrl } from '~/app/utils/api-url'
import { decodeJwtPayload } from '~/app/utils/jwt-decode'
import { useCandidateSession, type CandidateSession } from '~/app/composables/useCandidateSession'
import type { operations } from '~~/types/api'

// Generated from openapi.json (`bun run codegen`) — never hand-maintained.
type ExchangeResponse =
  operations['exchange.exchange']['responses'][200]['content']['application/json']

definePageMeta({ ssr: false })
useHead({
  meta: [
    { name: 'robots', content: 'noindex, nofollow' },
    { name: 'referrer', content: 'no-referrer' },
  ],
})

const route = useRoute()
const localePath = useLocalePath()

function readErrorStatus(err: unknown): unknown {
  return (err as Record<string, unknown>)?.status ?? (err as Record<string, unknown>)?.statusCode
}

/**
 * Compare the stored candidate session's `interviewId` (captured from a
 * prior exchange of THIS session token's `sub`) against the session token's
 * own `sub` claim, both read unverified — the decision is only "may I reuse
 * what I already hold"; the server re-validates everything on the next call.
 */
function storedSessionMatchesSessionToken(
  stored: CandidateSession | null,
  sessionTokenClaims: Record<string, unknown> | null
): boolean {
  if (!stored?.interviewId || !sessionTokenClaims) return false
  return stored.interviewId === sessionTokenClaims['sub']
}

async function exchangeAndRedirect(): Promise<void> {
  const token = String(route.params['token'] ?? '')
  const session = useCandidateSession()
  const stored = session.read()
  const sessionTokenClaims = decodeJwtPayload(token)

  if (storedSessionMatchesSessionToken(stored, sessionTokenClaims)) {
    // A valid stored session already answers "who is this candidate" — skip
    // the exchange entirely so the single-use session token stays unspent.
    await navigateTo(localePath('/interview/session'), { replace: true })
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
    await navigateTo(localePath('/interview/session'), { replace: true })
  } catch (err) {
    const status = readErrorStatus(err)

    if (status === 410) {
      // Session token already consumed, revoked by a later mint, or the
      // interview is no longer `pending` (G-32) — retry cannot succeed.
      await navigateTo(localePath('/interview/terminal?reason=link_used'), { replace: true })
      return
    }

    if (status === 401) {
      // Expired, mis-signed, or wrong-audience session token (G-32).
      await navigateTo(localePath('/interview/terminal?reason=link_invalid'), { replace: true })
      return
    }

    // Network error or any other unexpected failure — no gate detail to
    // disclose, and `/api/embed/exchange` sends no `redirect_url` (G-32).
    await navigateTo(localePath('/interview/terminal?reason=403'), { replace: true })
  }
}

onMounted(() => {
  void exchangeAndRedirect()
})
</script>
