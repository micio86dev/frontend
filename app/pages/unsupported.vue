<template>
  <div data-testid="unsupported-gate" role="main" aria-labelledby="unsupported-title">
    <h1 id="unsupported-title">{{ $t('unsupported.title') }}</h1>
    <p>{{ $t('unsupported.message') }}</p>
  </div>
</template>

<script setup lang="ts">
definePageMeta({
  name: 'unsupported',
})

useHead({
  // WCAG 2.4.2 (Page Titled): non-empty <title> required.
  title: 'Unsupported browser',
  meta: [{ name: 'robots', content: 'noindex, nofollow' }],
})
</script>
