<template>
  <div class="flex flex-col gap-1">
    <div class="flex items-center justify-between text-sm text-muted-foreground">
      <span>{{ current }} / {{ total }}</span>
      <span>{{ percentage }}%</span>
    </div>
    <div
      role="progressbar"
      :aria-valuenow="current"
      :aria-valuemin="0"
      :aria-valuemax="total"
      :aria-label="$t ? $t('interview.end_of_question.title') : 'Progress'"
      class="h-2 w-full overflow-hidden rounded-full bg-secondary"
    >
      <div
        class="h-full rounded-full bg-primary transition-all duration-300"
        :style="{ width: `${percentage}%` }"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * ProgressBar — competency progress indicator for the End of Question screen.
 *
 * Props:
 *   current — current competency index (1-based for display)
 *   total   — total number of competencies
 *
 * Accessible: role="progressbar" with aria-valuenow/min/max.
 * SSR-safe: no browser APIs.
 */
import { computed } from 'vue'

const props = defineProps<{
  current: number
  total: number
}>()

const percentage = computed(() => {
  if (props.total === 0) return 0
  return Math.round((props.current / props.total) * 100)
})
</script>
