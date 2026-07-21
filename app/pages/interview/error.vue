<template>
  <main
    class="flex min-h-screen flex-col items-center justify-center bg-background p-4"
    role="main"
    data-testid="error-page"
  >
    <section
      class="flex max-w-lg flex-col gap-6 rounded-xl border border-border bg-card p-8 shadow-md"
      aria-labelledby="error-page-heading"
    >
      <Alert variant="destructive">
        <AlertTitle id="error-page-heading">{{ $t('interview.error.title') }}</AlertTitle>
      </Alert>
      <Button data-testid="retry-button" @click="handleRetry">
        {{ $t('interview.error.retry') }}
      </Button>
    </section>
  </main>
</template>

<script setup lang="ts">
/**
 * Error page — retryable error screen.
 *
 * Shown on 502, network failure, or 3x provider_busy.
 * Retry resets the attempt counter via useInterviewSession.retry().
 * noindex: session-gated page.
 */
import { Alert, AlertTitle } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'

definePageMeta({ ssr: false })
useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow' }] })

const router = useRouter()

function handleRetry(): void {
  // Navigate back to the interview token route which will re-init the session
  router.back()
}
</script>
