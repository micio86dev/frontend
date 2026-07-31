<template>
  <main
    class="flex min-h-screen flex-col items-center justify-center bg-background p-4"
    data-testid="done-page"
  >
    <section
      class="flex max-w-lg flex-col gap-6 rounded-xl border border-border bg-card p-8 shadow-md"
      aria-labelledby="done-page-heading"
    >
      <h1 id="done-page-heading" class="text-2xl font-semibold text-foreground">
        {{ $t('interview.done.title') }}
      </h1>
      <Separator />
      <p class="text-sm text-muted-foreground">{{ $t('interview.done.body') }}</p>
    </section>
  </main>
</template>

<script setup lang="ts">
/**
 * Done page — shown when all competency sessions are completed.
 *
 * No further API calls are made from this page.
 * noindex: session-gated page.
 */
import { Separator } from '~/components/ui/separator'

definePageMeta({ ssr: false })
useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow' }] })
</script>
