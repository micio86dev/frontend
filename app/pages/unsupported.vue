<template>
  <NoticeShell
    tone="warning"
    test-id="unsupported-gate"
    heading-id="unsupported-title"
    :title="$t('unsupported.title')"
    :message="$t('unsupported.message')"
  />
</template>

<script setup lang="ts">
/**
 * SA-11 device / browser gate.
 *
 * `warning`, not `danger`: nothing has failed and the candidate has done
 * nothing wrong — they are on a device this product does not support, and the
 * fix is entirely in their hands. An error tone here would read as "your
 * assessment broke".
 *
 * This is the one route the browser gate does NOT redirect away from, so it is
 * also the only BEAI page a phone visitor ever sees. `NoticeShell` collapses to
 * a single column below `lg`, which is exactly that case.
 */
import NoticeShell from '~/components/molecules/NoticeShell.vue'

definePageMeta({
  name: 'unsupported',
})

useHead({
  // WCAG 2.4.2 (Page Titled): non-empty <title> required.
  title: 'Unsupported browser',
  meta: [{ name: 'robots', content: 'noindex, nofollow' }],
})
</script>
