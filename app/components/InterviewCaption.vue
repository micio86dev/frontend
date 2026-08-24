<template>
  <p
    class="mt-4 min-h-[1.75rem] text-center text-base font-medium text-foreground transition-opacity"
    :class="text ? 'opacity-100' : 'opacity-0'"
    aria-live="polite"
    aria-atomic="true"
  >
    {{ text }}
  </p>
</template>

<script setup lang="ts">
/**
 * Caption — live transcript/caption display for the avatar interview.
 *
 * Props:
 *   text — current caption text (reactive; updates as avatar speaks)
 *
 * SSR-safe: no browser APIs.
 * Accessible: aria-live="polite" for screen reader announcements.
 */
defineProps<{
  text: string
}>()
</script>
