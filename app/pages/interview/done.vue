<template>
  <NoticeShell
    tone="success"
    test-id="done-page"
    heading-id="done-page-heading"
    :title="$t('interview.done.title')"
    :message="$t('interview.done.body')"
  />
</template>

<script setup lang="ts">
/**
 * Done page — shown when all competency sessions are completed.
 *
 * No further API calls are made from this page, and it offers no action: the
 * candidate's next step belongs to whoever invited them, and the project's
 * `exit_redirect_url` has already had its chance to fire.
 * noindex: session-gated page.
 */
import NoticeShell from '~/components/molecules/NoticeShell.vue'

definePageMeta({ ssr: false })
useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow' }] })
</script>
