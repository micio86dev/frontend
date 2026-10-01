<template>
  <main
    v-if="state === 'loading'"
    class="flex min-h-screen flex-col items-center justify-center bg-background p-4"
    aria-live="polite"
    aria-busy="true"
    data-testid="reusable-loading"
  >
    <span class="sr-only">{{ $t('interview.reusable.loading') }}</span>
    <div class="flex flex-col items-center gap-4">
      <Skeleton class="h-48 w-full max-w-2xl rounded-lg" />
      <Skeleton class="h-4 w-48 rounded" />
    </div>
  </main>

  <NoticeShell
    v-else-if="state === 'busy'"
    tone="warning"
    test-id="reusable-busy"
    heading-id="reusable-busy-heading"
    :title="$t('interview.reusable.busy.title')"
    :message="$t('interview.reusable.busy.body')"
  >
    <div>
      <Button size="lg" data-testid="reusable-retry" @click="retry">
        {{ $t('interview.reusable.retry') }}
      </Button>
    </div>
  </NoticeShell>

  <NoticeShell
    v-else
    tone="danger"
    test-id="reusable-failed"
    heading-id="reusable-failed-heading"
    :title="$t('interview.reusable.failed.title')"
    :message="$t('interview.reusable.failed.body')"
  >
    <div>
      <Button size="lg" data-testid="reusable-retry" @click="retry">
        {{ $t('interview.reusable.retry') }}
      </Button>
    </div>
  </NoticeShell>
</template>

<script setup lang="ts">
/**
 * Reusable interview entry route — ssr:false container
 * (reusable-interview-links, AD-16).
 *
 * `/interview/reusable#beai_rl_<43>` is the URL of a reusable link: ONE url, many
 * people (demos, trade-fair kiosks, testing). Every visit creates a NEW anonymous
 * visitor in the link's project and ends on the ordinary interview session route.
 * The token is a live, non-expiring credential, so this page is mostly a list of
 * places it must not end up. On mount, in order:
 *
 *   1. The fragment is stripped from the address bar (`history.replaceState`, no
 *      new entry, no navigation) BEFORE any network call. The early client
 *      plugin has normally done it already and left the token in module memory;
 *      doing it here too means the page does not depend on the plugin's timing.
 *   2. If a fragment was present, any stored session is cleared FIRST: a kiosk is
 *      not the previous person, and a link never resumes anyone. A fragment that
 *      is not a well-formed token is the terminal `link_invalid`, with no request.
 *      Otherwise `POST /api/reusable-links/redeem` runs exactly once per mount
 *      (token in the JSON body, through `useReusableLinkRedeem`), the returned
 *      candidate JWT is stored with `entry: 'reusable'`, and the visitor is sent
 *      to the token-free session route with `replace: true`.
 *   3. With NO fragment (a reload after the strip) the page resumes ONLY a stored,
 *      unexpired session that this route itself stored. Anything else — a
 *      single-use session, a hosted session, nothing — is `link_invalid`, with no
 *      request: there is no token left to redeem, and that is by design.
 *
 * Outcomes: 404 is `link_invalid` (unknown, malformed and disabled links are one
 * answer, so there is no retry); 403 is handled exactly as the single-use route
 * handles an exchange 403 (a validated https `redirect_url`, else the generic
 * terminal) so no gate is ever disclosed; 429, a 5xx and a dropped connection are
 * RETRYABLE and never claim the link is bad. Retry re-posts the token held in this
 * component's memory. `/interview/error` cannot do that: it goes `router.back()`
 * to a URL that no longer carries the token.
 *
 * The token lives in one plain variable and nowhere else — not a ref (so it is
 * not part of any reactive state), not storage, not the URL, not the router, not
 * the DOM, not a log line — and is dropped as soon as the outcome is final.
 *
 * The browser gate (a phone or Firefox must not redeem, because that would create
 * a visitor nobody can interview) is the global route middleware: it redirects to
 * `/unsupported` before this page ever mounts.
 *
 * noindex + no-referrer: session-gated, and the address bar briefly held a
 * credential.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import NoticeShell from '~/components/molecules/NoticeShell.vue'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'
import { useCandidateSession } from '~/app/composables/useCandidateSession'
import {
  useReusableLinkRedeem,
  type VisitorIdentityInput,
} from '~/app/composables/useReusableLinkRedeem'
import { safeExternalRedirect } from '~/app/utils/safe-redirect'
import {
  captureReusableLinkFragment,
  takeReusableLinkToken,
} from '~/app/utils/reusable-link-fragment'

type ViewState = 'loading' | 'busy' | 'failed'

definePageMeta({ ssr: false })

const { t } = useI18n()

useHead({
  // WCAG 2.4.2 (Page Titled): this page is what a visitor sees first, in the
  // loading, busy and failed states, and an untitled document is a Level A
  // failure that axe reports on exactly those states.
  title: t('interview.document_title'),
  meta: [
    { name: 'robots', content: 'noindex, nofollow' },
    { name: 'referrer', content: 'no-referrer' },
  ],
})

const localePath = useLocalePath()
const session = useCandidateSession()
const { redeem } = useReusableLinkRedeem()

const state = ref<ViewState>('loading')

// INTERIM (reusable-link-visitor-identity fe-2a): the composable now requires the
// visitor's name and email, but the identity form is wired into this page by the
// next slice (fe-2b). Until then the page keeps its automatic redeem and sends an
// empty identity, which the api refuses with a 422; nothing is released in between.
const IDENTITY_NOT_COLLECTED_YET: VisitorIdentityInput = { displayName: '', email: '' }

// Plain variables on purpose: not reactive, so nothing can render or serialise
// them. `heldToken` is only ever non-null while a retry could still be needed.
let heldToken: string | null = null
let started = false
let inFlight = false

async function leaveTo(path: string): Promise<void> {
  await navigateTo(localePath(path), { replace: true })
}

async function redeemHeldToken(): Promise<void> {
  const token = heldToken

  // One request at a time: a second click while one is in flight is a no-op.
  if (token === null || inFlight) {
    return
  }

  inFlight = true
  state.value = 'loading'

  try {
    const outcome = await redeem(token, IDENTITY_NOT_COLLECTED_YET)

    switch (outcome.kind) {
      case 'ok': {
        session.store(outcome.accessToken, { entry: 'reusable' })

        // `store()` writes nothing for a token it cannot decode. Navigating on
        // would put the visitor in front of the session route's guard with no
        // session; staying here with a Retry is the honest outcome.
        if (session.read() === null) {
          state.value = 'failed'
          return
        }

        heldToken = null
        await leaveTo('/interview/session')
        return
      }
      case 'not_found':
        heldToken = null
        await leaveTo('/interview/terminal?reason=link_invalid')
        return
      case 'forbidden':
        heldToken = null

        // Same rule as the single-use route: a validated https `redirect_url`
        // navigates away; a missing or refused one falls back to the generic
        // terminal. Nothing here says which gate fired.
        if (safeExternalRedirect(outcome.redirectUrl, 'redirect_url')) {
          return
        }

        await leaveTo('/interview/terminal?reason=403')
        return
      case 'busy':
        state.value = 'busy'
        return
      // INTERIM (fe-2b maps these onto the identity form's fields): until the form
      // exists they are shown as the retryable failed state, so a 422 or a 409 can
      // never leave the visitor on a loading skeleton that does not end.
      case 'invalid':
      case 'duplicate':
      case 'failed':
        state.value = 'failed'
        return
      default: {
        // A new outcome kind must be handled above: this stops compiling without it.
        const unhandled: never = outcome
        return unhandled
      }
    }
  } finally {
    inFlight = false
  }
}

function retry(): void {
  void redeemHeldToken()
}

function start(): void {
  // At most once per mount, whatever re-renders or re-runs follow.
  if (started) {
    return
  }

  started = true

  captureReusableLinkFragment(window)

  const { present, token } = takeReusableLinkToken()

  if (present) {
    // A link was opened: a new visitor, never the previous one.
    session.clear()

    if (token === null) {
      void leaveTo('/interview/terminal?reason=link_invalid')
      return
    }

    heldToken = token
    void redeemHeldToken()
    return
  }

  // A reload: the fragment is gone, so there is nothing to redeem. Resume only
  // what this route stored itself.
  if (session.read()?.entry === 'reusable') {
    void leaveTo('/interview/session')
    return
  }

  void leaveTo('/interview/terminal?reason=link_invalid')
}

onMounted(start)

onBeforeUnmount(() => {
  heldToken = null
})
</script>
