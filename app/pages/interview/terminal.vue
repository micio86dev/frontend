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
 * Terminal page — no exit, no retry.
 *
 * Props (via query param):
 *   reason — '403' (authorization expired/closed), 'spent_link' (sso-link
 *     jti already consumed — exchange 401), 'session_expired' (stored
 *     candidate session absent/expired — candidate-session middleware gate,
 *     D-E), or 'absent_phrase' (service unavailable, fallback default).
 *
 * Reached from two places:
 *   1. The entry route (`[token].vue`) on an exchange 401/403 — D1.
 *   2. `middleware/candidate-session.ts` on `/interview/session` when no
 *      valid stored session exists — D-E.
 *
 * Shows DISTINCT localized messages per reason. `session_expired` and
 * `spent_link` are honest, non-generic copy — see D-D/D-F: nothing here
 * ever implies a new link will resolve an expired session.
 *
 * noindex: session-gated page.
 */
import { computed } from 'vue'

definePageMeta({ ssr: false })
useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow' }] })

const route = useRoute()

type TerminalReason = '403' | 'absent_phrase' | 'session_expired' | 'spent_link'

// Reason can be passed as a route query or param
const reason = computed<TerminalReason>(() => {
  const r = route.query['reason'] ?? route.params['reason']
  if (r === '403' || r === 'absent_phrase' || r === 'session_expired' || r === 'spent_link') {
    return r
  }
  return '403' // Safe default
})
</script>
