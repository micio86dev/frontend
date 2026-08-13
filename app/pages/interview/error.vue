<template>
  <NoticeShell
    tone="danger"
    test-id="error-page"
    heading-id="error-page-heading"
    :title="$t('interview.error.title')"
    :message="$t('interview.error.body')"
  >
    <div>
      <Button size="lg" data-testid="retry-button" @click="handleRetry">
        {{ $t('interview.error.retry') }}
      </Button>
    </div>
  </NoticeShell>
</template>

<script setup lang="ts">
/**
 * Error page — retryable error screen.
 *
 * Shown on 502, network failure, or 3x provider_busy.
 * Retry resets the attempt counter via useInterviewSession.retry().
 * noindex: session-gated page.
 *
 * The retry button is wrapped so it sizes to its own content instead of
 * stretching across the shell's column.
 */
import NoticeShell from '~/components/molecules/NoticeShell.vue'
import { Button } from '~/components/ui/button'

definePageMeta({ ssr: false })
useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow' }] })

const router = useRouter()

function handleRetry(): void {
  // Navigate back to the interview token route which will re-init the session
  router.back()
}
</script>
