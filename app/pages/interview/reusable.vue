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

  <!--
    The identity step. Rendered in the shell's default slot so the form is the page's
    first non-terminal state (DESIGN.md 16.19); the heading and intro are the shell's
    title and message.
  -->
  <NoticeShell
    v-else-if="state === 'identity'"
    tone="info"
    test-id="reusable-identity"
    heading-id="reusable-identity-heading"
    :title="$t('interview.reusable.identity.title')"
    :message="$t('interview.reusable.identity.intro')"
  >
    <ReusableIdentityForm
      :submitting="submitting"
      :server-errors="serverErrors"
      :initial-display-name="initialValue('displayName')"
      :initial-email="initialValue('email')"
      @submit="onIdentitySubmit"
    />
  </NoticeShell>

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
 * (reusable-interview-links AD-16; reusable-link-visitor-identity VD-12).
 *
 * `/interview/reusable#beai_rl_<43>` is the URL of a reusable link: ONE url, many
 * people (demos, trade-fair kiosks, testing). A visitor gives a name and an email
 * on this page, and each submit creates a NEW visitor in the link's project and
 * ends on the ordinary interview session route. The token is a live, non-expiring
 * credential and the identity is personal data, so this page is mostly a list of
 * places neither may end up. On mount, in order:
 *
 *   1. The fragment is stripped from the address bar (`history.replaceState`, no
 *      new entry, no navigation) BEFORE anything else. The early client plugin has
 *      normally done it already and left the token in module memory; doing it here
 *      too means the page does not depend on the plugin's timing.
 *   2. If a fragment was present, any stored session is cleared FIRST: a kiosk is
 *      not the previous person, and a link never resumes anyone. A fragment that is
 *      not a well-formed token is the terminal `link_invalid`, with no form and no
 *      request. Otherwise the identity form is shown and NO request is made. One
 *      `POST /api/reusable-links/redeem` runs per submit (token, name and email in
 *      the JSON body, through `useReusableLinkRedeem`); the returned candidate JWT
 *      is stored with `entry: 'reusable'` and the visitor is sent to the
 *      token-free session route.
 *   3. With NO fragment (a reload after the strip) the page resumes ONLY a stored,
 *      unexpired session that this route itself stored. Otherwise, if the
 *      non-secret "form shown" flag is set, the token was lost with the reload and
 *      the visitor is told to open the link again (`link_reopen`); with no flag it
 *      is `link_invalid`. There is no token left to redeem, by design.
 *
 * Outcomes: 404 is `link_invalid` (unknown, malformed and disabled links are one
 * answer, so there is no retry); 403 is handled exactly as the single-use route
 * handles an exchange 403 (a validated https `redirect_url`, else the generic
 * terminal) so no gate is ever disclosed; 422 and 409 keep the visitor on the form
 * with the app's own message on the field (the token is kept, the visitor corrects
 * and submits again); 429, a 5xx and a dropped connection are RETRYABLE and never
 * claim the link is bad. Retry re-posts the token and the identity held in this
 * component's memory. `/interview/error` cannot do that: it goes `router.back()` to
 * a URL that no longer carries the token.
 *
 * The token and the typed identity live in plain variables and nowhere else: not a
 * ref (so neither is part of any reactive state), not storage, not the URL, not the
 * router, not the DOM beyond the inputs the visitor is typing into, not a log line
 * — and are dropped as soon as the outcome is final or the page is left.
 *
 * LEAVING THE PAGE. `leaveTo` uses `router.replace`, not `navigateTo`. Inside an
 * in-flight router navigation (a pasted fragment fires popstate before hashchange,
 * so the router is mid-navigation when the redeem answer returns) Nuxt treats a
 * `navigateTo` as a middleware redirect: it RETURNS a route object instead of
 * navigating, and a caller that ignores the return value strands the visitor on
 * this page. `router.replace` is the supported call that supersedes a pending
 * navigation, and awaiting it keeps the form disabled until the router has left.
 *
 * The browser gate (a phone or Firefox must not redeem, because that would create
 * a visitor nobody can interview) is the global route middleware: it redirects to
 * `/unsupported` before this page ever mounts, so the form is never shown there.
 *
 * noindex + no-referrer: session-gated, and the address bar briefly held a
 * credential.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import NoticeShell from '~/components/molecules/NoticeShell.vue'
import ReusableIdentityForm from '~/components/molecules/ReusableIdentityForm.vue'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'
import { useCandidateSession } from '~/app/composables/useCandidateSession'
import {
  useReusableLinkRedeem,
  type RedeemInvalidField,
  type VisitorIdentityInput,
} from '~/app/composables/useReusableLinkRedeem'
import {
  clearIdentityPending,
  consumeIdentityPending,
  markIdentityPending,
} from '~/app/utils/reusable-identity-pending'
import { safeExternalRedirect } from '~/app/utils/safe-redirect'
import {
  captureReusableLinkFragment,
  takeReusableLinkToken,
} from '~/app/utils/reusable-link-fragment'
import type { IdentityErrorKey } from '~/app/utils/visitor-identity'

type ViewState = 'loading' | 'identity' | 'busy' | 'failed'
type FieldErrors = Partial<Record<'displayName' | 'email', IdentityErrorKey>>

definePageMeta({ ssr: false })

const { t } = useI18n()

useHead({
  // WCAG 2.4.2 (Page Titled): this page is what a visitor sees first, in the
  // form, loading, busy and failed states, and an untitled document is a Level A
  // failure that axe reports on exactly those states.
  title: t('interview.document_title'),
  meta: [
    { name: 'robots', content: 'noindex, nofollow' },
    { name: 'referrer', content: 'no-referrer' },
  ],
})

const localePath = useLocalePath()
const router = useRouter()
const session = useCandidateSession()
const { redeem } = useReusableLinkRedeem()

const state = ref<ViewState>('loading')
/** True while the form's own request is in flight: the form stays on screen, disabled. */
const submitting = ref(false)
/** What the api refused, as message keys for the form (never server text). */
const serverErrors = ref<FieldErrors>({})

// Plain variables on purpose: not reactive, so nothing can render or serialise
// them. They are only ever non-null while a retry or a correction could still be
// needed.
let heldToken: string | null = null
let heldIdentity: VisitorIdentityInput | null = null
let started = false
let inFlight = false
// Set when the page is unmounted. A redemption already on the wire cannot be cancelled,
// and its continuation holds the token and identity as locals, so dropping the held
// variables is not enough: every continuation checks this before it stores a session or
// navigates anywhere.
let left = false

/** Prefill for a form that is mounted again after a busy or failed state, so nothing is retyped. */
function initialValue(field: 'displayName' | 'email'): string {
  return heldIdentity?.[field] ?? ''
}

function dropHeld(): void {
  heldToken = null
  heldIdentity = null
}

async function leaveTo(path: string): Promise<void> {
  // `router.replace`, never `navigateTo`: see "LEAVING THE PAGE" in the docblock. A
  // navigation that ends in a vue-router failure (superseded by a later one, or
  // aborted by a guard) resolves rather than rejects, and in both cases whoever
  // superseded or refused it owns where the visitor goes next.
  await router.replace(localePath(path))
}

const FIELD_ERROR: Record<RedeemInvalidField, ['displayName' | 'email', IdentityErrorKey]> = {
  display_name: ['displayName', 'nameInvalid'],
  email: ['email', 'emailInvalid'],
}

async function redeemHeld(): Promise<void> {
  const token = heldToken
  const identity = heldIdentity

  // One request at a time: a second click while one is in flight is a no-op.
  if (token === null || identity === null || inFlight) {
    return
  }

  inFlight = true
  serverErrors.value = {}

  // From the form the visitor stays on it (disabled); from a retry the page shows
  // its loading state, as it always has.
  if (state.value === 'identity') {
    submitting.value = true
  } else {
    state.value = 'loading'
  }

  // Whether the page is staying: false once a terminal outcome starts leaving it.
  let staying = true

  try {
    const outcome = await redeem(token, identity)

    // The visitor left while the request was in flight: nobody is looking at this page,
    // so storing the session or navigating would act for a visitor who is gone.
    if (left) {
      return
    }

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

        staying = false
        dropHeld()
        clearIdentityPending()
        await leaveTo('/interview/session')
        return
      }
      case 'not_found':
        staying = false
        dropHeld()
        clearIdentityPending()
        await leaveTo('/interview/terminal?reason=link_invalid')
        return
      case 'forbidden':
        staying = false
        dropHeld()
        clearIdentityPending()

        // Same rule as the single-use route: a validated https `redirect_url`
        // navigates away; a missing or refused one falls back to the generic
        // terminal. Nothing here says which gate fired.
        if (safeExternalRedirect(outcome.redirectUrl, 'redirect_url')) {
          return
        }

        await leaveTo('/interview/terminal?reason=403')
        return
      case 'invalid': {
        // The form stays, with the app's own message on each field the api named.
        const errors: FieldErrors = {}
        for (const field of outcome.fields) {
          const [formField, key] = FIELD_ERROR[field]
          errors[formField] = key
        }
        serverErrors.value = errors
        state.value = 'identity'
        return
      }
      case 'duplicate':
        // The token is kept: the visitor may correct the email and submit again.
        serverErrors.value = { email: 'emailTaken' }
        state.value = 'identity'
        return
      case 'busy':
        state.value = 'busy'
        return
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
    if (staying) {
      submitting.value = false
    }
  }
}

function onIdentitySubmit(identity: VisitorIdentityInput): void {
  if (inFlight || heldToken === null) {
    return
  }

  heldIdentity = identity
  void redeemHeld()
}

function retry(): void {
  void redeemHeld()
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
    // A link was opened: a new visitor, never the previous one, and no stale flag.
    session.clear()
    clearIdentityPending()

    if (token === null) {
      void leaveTo('/interview/terminal?reason=link_invalid')
      return
    }

    // The form, and NO request: one is made per submit.
    heldToken = token
    markIdentityPending()
    state.value = 'identity'
    return
  }

  // A reload: the fragment is gone, so there is nothing to redeem. Resume only
  // what this route stored itself.
  if (session.read()?.entry === 'reusable') {
    clearIdentityPending()
    void leaveTo('/interview/session')
    return
  }

  // The form was on screen: the token went with the reload. Say so truthfully.
  if (consumeIdentityPending()) {
    void leaveTo('/interview/terminal?reason=link_reopen')
    return
  }

  void leaveTo('/interview/terminal?reason=link_invalid')
}

onMounted(start)

onBeforeUnmount(() => {
  left = true
  dropHeld()
  clearIdentityPending()
})
</script>
