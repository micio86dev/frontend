<template>
  <main
    class="flex min-h-screen flex-col items-center justify-center bg-background p-4"
    data-testid="terminal-page"
  >
    <section
      class="flex max-w-lg flex-col gap-6 rounded-xl border border-border bg-card p-8 shadow-md"
      aria-labelledby="terminal-page-heading"
    >
      <!-- 403 terminal: session authorization closed -->
      <template v-if="reason === '403'">
        <h1 id="terminal-page-heading" class="text-2xl font-semibold text-foreground">
          {{ $t('interview.terminal.403.title') }}
        </h1>
        <p class="text-sm text-muted-foreground">{{ $t('interview.terminal.403.body') }}</p>
      </template>

      <!-- Spent-link terminal: the sso-link's jti was already consumed (401 from exchange) -->
      <template v-else-if="reason === 'spent_link'">
        <h1 id="terminal-page-heading" class="text-2xl font-semibold text-foreground">
          {{ $t('interview.terminal.spent_link.title') }}
        </h1>
        <p class="text-sm text-muted-foreground">{{ $t('interview.terminal.spent_link.body') }}</p>
      </template>

      <!--
        Hosted-entry (`/i/{token}`) terminal — `GET /api/embed/exchange` 410
        `token_consumed`: the session token was already used, revoked by a
        later mint, or the interview is no longer `pending` (G-32). Distinct
        from `spent_link` (the sso-link flow's own 401): the copy here is
        scoped to the public-api hosted link and asks for a new one, without
        implying anything about a paused interview.
      -->
      <template v-else-if="reason === 'link_used'">
        <h1 id="terminal-page-heading" class="text-2xl font-semibold text-foreground">
          {{ $t('interview.terminal.link_used.title') }}
        </h1>
        <p class="text-sm text-muted-foreground">{{ $t('interview.terminal.link_used.body') }}</p>
      </template>

      <!--
        `link_invalid`: the link is not valid or is no longer active. Reached
        from `i/[token].vue` (exchange 401) and `interview/reusable.vue` (redeem
        404, a malformed fragment, or no fragment and no stored reusable
        session). A reusable link has no expiry, so the copy must not claim one.
        `embed/[token].vue` shows these same strings inline on 401 and 404; it
        does not navigate here.
      -->
      <template v-else-if="reason === 'link_invalid'">
        <h1 id="terminal-page-heading" class="text-2xl font-semibold text-foreground">
          {{ $t('interview.terminal.link_invalid.title') }}
        </h1>
        <p class="text-sm text-muted-foreground">
          {{ $t('interview.terminal.link_invalid.body') }}
        </p>
      </template>

      <!--
        Expired-session terminal: the stored candidate session is absent or
        expired (candidate-session middleware gate, D-E), or a candidate call
        returned 401 mid-session (D-D/D-F). Honest by design: a paused
        candidate whose session has expired has NO self-serve path back in —
        a fresh sso-link is refused at the exchange pre-flight read for any
        status other than in_attesa (SsoExchangeController.php:118-126) — so
        this copy MUST NOT suggest requesting or using a new link will help.
      -->
      <template v-else-if="reason === 'session_expired'">
        <h1 id="terminal-page-heading" class="text-2xl font-semibold text-foreground">
          {{ $t('interview.terminal.session_expired.title') }}
        </h1>
        <p class="text-sm text-muted-foreground">
          {{ $t('interview.terminal.session_expired.body') }}
        </p>
      </template>

      <!-- Absent phrase terminal: service unavailable, contact support -->
      <template v-else>
        <h1 id="terminal-page-heading" class="text-2xl font-semibold text-foreground">
          {{ $t('interview.terminal.absent_phrase.title') }}
        </h1>
        <p class="text-sm text-muted-foreground">
          {{ $t('interview.terminal.absent_phrase.body') }}
        </p>
        <a
          href="mailto:support@beai.app"
          class="text-sm text-primary underline underline-offset-4 hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="terminal-contact"
        >
          {{ $t('interview.terminal.absent_phrase.contact') }}
        </a>
      </template>
    </section>
  </main>
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
 *     fragment, and when there is no fragment and no stored reusable session;
 *     `403` on a 403 without a usable `redirect_url`.
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

definePageMeta({ ssr: false })
useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow' }] })

const route = useRoute()

type TerminalReason =
  '403' | 'absent_phrase' | 'session_expired' | 'spent_link' | 'link_used' | 'link_invalid'

const KNOWN_REASONS: readonly TerminalReason[] = [
  '403',
  'absent_phrase',
  'session_expired',
  'spent_link',
  'link_used',
  'link_invalid',
]

// Reason can be passed as a route query or param
const reason = computed<TerminalReason>(() => {
  const r = route.query['reason'] ?? route.params['reason']
  if ((KNOWN_REASONS as readonly string[]).includes(r as string)) {
    return r as TerminalReason
  }
  return '403' // Safe default
})
</script>
