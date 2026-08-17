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
 * Interview entry route — ssr:false container (D-A, D1).
 *
 * Renders NOTHING durable. On mount, in order:
 *   1. Read the stored candidate session. If it exists, is unexpired, and its
 *      candidate_ref + project_id claims match the sso-link's own claims, the
 *      exchange is SKIPPED entirely — the link stays unspent — and the
 *      candidate is navigated straight to the token-free session route.
 *   2. Otherwise, `GET /api/sso/exchange?token=…` EXACTLY ONCE. The sso-link
 *      is single-use and its `jti` is consumed BEFORE any gate is evaluated
 *      (SsoExchangeController.php:44) — re-exchanging on every mount would
 *      burn the link on the candidate's first refresh, which is exactly what
 *      someone does when a page looks stuck.
 *   3. Persist the returned candidate JWT, then `navigateTo` the session
 *      route with `replace: true`. `replace: true` removes the token URL
 *      from the history entry, so neither Back nor a refresh can land on the
 *      exchange again — refresh-safety is structural, not a flag someone
 *      must remember to check.
 *
 * `useInterviewSession` is NOT imported here — this route never reads the
 * candidate JWT into the interview session machine; it only stores it and
 * hands off. (There is no composable in this file that reads the route token
 * "internally" either — the previous claim to that effect, at this file's
 * old line 245, was false; the composable never called `useRoute()` at all.)
 *
 * noindex: this route is session-gated and must never be indexed.
 */
import { onMounted } from 'vue'
import { $fetch } from 'ofetch'
import { Skeleton } from '~/components/ui/skeleton'
import { apiUrl } from '~/app/utils/api-url'
import { decodeJwtPayload } from '~/app/utils/jwt-decode'
import { useCandidateSession, type CandidateSession } from '~/app/composables/useCandidateSession'

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
 * Compare the stored candidate session's unverified claims against the
 * sso-link's own claims. This is safe here: the decision is only "may I
 * reuse what I already hold" — the server re-validates everything on the
 * next call. No client-side claim is ever trusted for tenant scoping.
 */
function storedSessionMatchesLink(
  stored: CandidateSession | null,
  ssoClaims: Record<string, unknown> | null
): boolean {
  if (!stored || !ssoClaims) return false
  return (
    stored.candidateRef === ssoClaims['candidate_ref'] &&
    stored.projectId === ssoClaims['project_id']
  )
}

async function exchangeAndRedirect(): Promise<void> {
  const token = String(route.params['token'] ?? '')
  const session = useCandidateSession()
  const stored = session.read()
  const ssoClaims = decodeJwtPayload(token)

  if (storedSessionMatchesLink(stored, ssoClaims)) {
    // A valid stored session already answers "who is this candidate" — skip
    // the exchange entirely so the link stays unspent.
    await navigateTo(localePath('/interview/session'), { replace: true })
    return
  }

  try {
    const response = await $fetch<{ access_token: string }>(apiUrl('/sso/exchange'), {
      method: 'GET',
      params: { token },
    })
    session.store(response.access_token)
    await navigateTo(localePath('/interview/session'), { replace: true })
  } catch (err) {
    const status = readErrorStatus(err)

    if (status === 401) {
      // Spent link, no stored session — retry cannot succeed.
      await navigateTo(localePath('/interview/terminal?reason=spent_link'), { replace: true })
      return
    }

    // 403 (gate/status refusal) and any other unexpected failure fall back
    // to the existing generic terminal — no gate detail is ever disclosed.
    await navigateTo(localePath('/interview/terminal?reason=403'), { replace: true })
  }
}

onMounted(() => {
  void exchangeAndRedirect()
})
</script>
