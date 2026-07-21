<template>
  <main
    class="flex min-h-screen flex-col items-center justify-center bg-background p-4"
    role="main"
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
 *   reason — '403' (authorization expired/closed) or 'absent_phrase' (service unavailable)
 *
 * Shows TWO DISTINCT localized messages:
 *   403         → session authorization expired/closed
 *   absent_phrase → service temporarily unavailable; contact support affordance required
 *
 * noindex: session-gated page.
 */
import { computed } from 'vue'

definePageMeta({ ssr: false })
useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow' }] })

const route = useRoute()

// Reason can be passed as a route query or param
const reason = computed<'403' | 'absent_phrase'>(() => {
  const r = route.query['reason'] ?? route.params['reason']
  if (r === '403' || r === 'absent_phrase') return r
  return '403' // Safe default
})
</script>
