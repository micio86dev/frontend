<template>
  <p
    class="min-h-[1.75rem] text-base leading-7 font-medium text-card-foreground transition-opacity motion-reduce:transition-none"
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
 * Set in card text: it sits on the white live dock under the avatar, never on
 * the bare brand canvas (DESIGN.md §7.2).
 *
 * SSR-safe: no browser APIs.
 * Accessible: aria-live="polite" for screen reader announcements.
 */
defineProps<{
  text: string
}>()
</script>
