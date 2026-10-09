<template>
  <!--
    One notice, keyed by reason, on the brand canvas. The per-reason copy
    contracts are recorded beside `TONE` below and pinned by
    tests/unit/terminal-page.spec.ts and i18n-interview-keys.spec.ts.
  -->
  <NoticeShell
    :tone="TONE[reason]"
    test-id="terminal-page"
    heading-id="terminal-page-heading"
    :title="$t(`interview.terminal.${reason}.title`)"
    :message="$t(`interview.terminal.${reason}.body`)"
  >
    <!--
      Only the service-unavailable terminal offers a way out. Brand ink, not
      `text-primary`: the raw client colour can be invisible on the white
      surface (DESIGN.md §3.1 rule 3). Every other terminal has no link, no
      button and no form: there is nothing to retry from here.
    -->
    <a
      v-if="reason === 'absent_phrase'"
      :href="supportUrl"
      class="inline-flex min-h-(--spacing-control) items-center text-base font-semibold text-primary-ink underline decoration-2 underline-offset-4 hover:decoration-4"
      data-testid="terminal-contact"
    >
      {{ $t('interview.terminal.absent_phrase.contact') }}
    </a>
  </NoticeShell>
</template>

<script setup lang="ts">
/**
 * Terminal page: no exit, no retry. The reason comes from `?reason=` (or a
 * route param of the same name).
 *
 * Who navigates here, and with what:
 *   - `interview/[token].vue` (sso-link exchange): `spent_link` on a 401, `403`
 *     on a 403 without a usable `redirect_url` and on any other failure.
 *   - `i/[token].vue` (hosted entry, `/api/embed/exchange`): `link_used` on a
 *     410, `link_invalid` on a 401, `403` on any other failure.
 *   - `interview/reusable.vue`: `link_invalid` on a redeem 404, on a malformed
 *     fragment, and when there is no fragment, no stored reusable session and no
 *     "identity form shown" flag; `link_reopen` when that flag is set (a reload
 *     while the form was on screen); `403` on a 403 without a usable
 *     `redirect_url`.
 *   - `middleware/candidate-session.ts`: `session_expired` when no valid stored
 *     session exists.
 * `absent_phrase` has no navigating caller in `app/`; it renders only when the
 * query carries it. A missing or unrecognised reason renders as `403`.
 *
 * Copy: `session_expired` never suggests a new link will help (pinned by
 * `tests/unit/i18n-interview-keys.spec.ts`); `link_used` and `link_invalid` do
 * ask for a new one.
 *
 * noindex: the page sets `robots: noindex, nofollow`.
 */
import { computed } from 'vue'
import NoticeShell from '~/components/molecules/NoticeShell.vue'
import { useSupportUrl } from '~/composables/useSupportUrl'

definePageMeta({ ssr: false })

const supportUrl = useSupportUrl()

const route = useRoute()
const { t } = useI18n()

type TerminalReason =
  | '403'
  | 'absent_phrase'
  | 'session_expired'
  | 'spent_link'
  | 'link_used'
  | 'link_invalid'
  | 'link_reopen'

const KNOWN_REASONS: readonly TerminalReason[] = [
  '403',
  'absent_phrase',
  'session_expired',
  'spent_link',
  'link_used',
  'link_invalid',
  'link_reopen',
]

// Reason can be passed as a route query or param
/**
 * The chip tone per reason (DESIGN.md §7.0: tone changes the chip and nothing
 * else).
 *   - `403`: the session authorization closed; nothing broke on the candidate's
 *     side, so `info`.
 *   - `spent_link`: the sso-link's jti was already consumed (exchange 401).
 *   - `link_used`: the hosted link's exchange answered 410 `token_consumed`
 *     (used, revoked by a later mint, or the interview is no longer pending);
 *     its copy asks for a new link without implying a paused interview.
 *   - `link_invalid`: not valid or no longer active. A reusable link has no
 *     expiry, so the copy must not claim one. `embed/[token].vue` shows these
 *     strings inline instead of navigating here (its frame policy).
 *   - `link_reopen`: a reload while the reusable identity form was on screen
 *     lost the in-memory token; the link itself is fine.
 *   - `session_expired`: honest by design, a paused candidate whose session
 *     expired has NO self-serve way back, so the copy never suggests a new
 *     link will help.
 * The link and session reasons are `warning`: the candidate can act on them
 * through whoever invited them, and nothing failed. `absent_phrase` (the
 * service itself is unavailable) is the one `danger`.
 */
const TONE: Record<TerminalReason, 'info' | 'warning' | 'danger'> = {
  '403': 'info',
  spent_link: 'warning',
  link_used: 'warning',
  link_invalid: 'warning',
  link_reopen: 'warning',
  session_expired: 'warning',
  absent_phrase: 'danger',
}

const reason = computed<TerminalReason>(() => {
  const r = route.query['reason'] ?? route.params['reason']
  if ((KNOWN_REASONS as readonly string[]).includes(r as string)) {
    return r as TerminalReason
  }
  return '403' // Safe default
})

useHead({
  // WCAG 2.4.2 (Page Titled). Every reason carries its own localized title: the
  // page is often loaded directly (e.g. after a 410 on the hosted link), and an
  // untitled document is a Level A failure.
  title: computed(() => t(`interview.terminal.${reason.value}.title`)),
  meta: [{ name: 'robots', content: 'noindex, nofollow' }],
})
</script>
