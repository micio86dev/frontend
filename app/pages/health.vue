<template>
  <div>
    <p data-testid="health-status">ok</p>
  </div>
</template>

<script setup lang="ts">
definePageMeta({
  name: 'health',
})

// WCAG 2.4.2 (Page Titled): every page needs a non-empty <title>.
useHead({
  title: 'Health',
})
</script>
