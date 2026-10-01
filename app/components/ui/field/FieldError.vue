<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { computed } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{
  class?: HTMLAttributes['class']
  errors?: Array<string | { message: string | undefined } | undefined>
}>()

/**
 * The distinct, non-empty messages, in order. Reading the message FIRST and dropping
 * the falsy ones afterwards means an `errors` array whose entries carry nothing
 * (`[undefined]`, `['']`, `[{ message: undefined }]`) yields no messages at all,
 * so nothing is rendered: an empty `role="alert"` with an empty list is noise to a
 * screen reader. De-duplicating by message also gives each list item a unique key.
 */
const messages = computed(() => {
  const seen = new Set<string>()

  for (const error of props.errors ?? []) {
    const message = typeof error === 'string' ? error : error?.message
    if (message) seen.add(message)
  }

  return [...seen]
})
</script>

<template>
  <div
    v-if="$slots.default || messages.length > 0"
    role="alert"
    data-slot="field-error"
    :class="cn('text-destructive text-sm font-normal', props.class)"
  >
    <slot v-if="$slots.default" />

    <template v-else-if="messages.length === 1">
      {{ messages[0] }}
    </template>

    <ul v-else class="ml-4 flex list-disc flex-col gap-1">
      <li v-for="message in messages" :key="message">
        {{ message }}
      </li>
    </ul>
  </div>
</template>
