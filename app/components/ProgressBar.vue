<template>
  <div :class="compact ? 'flex items-center gap-2.5' : 'flex flex-col gap-1'">
    <div
      v-if="!compact && !hideCounts"
      class="flex items-center justify-between text-sm text-muted-foreground"
    >
      <span>{{ current }} / {{ total }}</span>
      <span>{{ percentage }}%</span>
    </div>
    <!--
      Fill in primary-ink, not the client colour: `bg-primary` on the light
      track measured 1.0:1 for #ffd400, a bar nobody could read. The ink is the
      brand darkened until it reads on white, so it clears 3:1 on the track for
      any client colour (brand-canvas-contrast.spec.ts).
    -->
    <div
      role="progressbar"
      :aria-valuenow="current"
      :aria-valuemin="0"
      :aria-valuemax="total"
      :aria-valuetext="valueText"
      :aria-label="$t('interview.progress.label')"
      class="h-2 overflow-hidden rounded-full bg-secondary"
      :class="compact ? 'w-24' : 'w-full'"
    >
      <div
        class="h-full rounded-full bg-primary-ink transition-[width] duration-300 motion-reduce:transition-none"
        :style="{ width: `${percentage}%` }"
      />
    </div>
    <span
      v-if="compact && !hideCounts"
      class="text-sm font-medium tabular-nums text-muted-foreground"
    >
      {{ current }} / {{ total }}
    </span>
  </div>
</template>

<script setup lang="ts">
/**
 * ProgressBar — competency progress, from the server's counts.
 *
 * Props:
 *   current — competencies ended so far
 *   total   — total number of competencies
 *   compact — one line (bar + count) for the interview header's status pill;
 *             the default stacks the count and percentage over a full bar for
 *             the scheduled-pause screen.
 *   hideCounts — drop the "n / total" and percentage text, keeping only the bar,
 *             for a caller that states the position in its own sentence (the call
 *             side panel). Default false: the output is unchanged.
 *   valueText — human-readable `aria-valuetext` for the bar, so a screen reader
 *             hears "Domanda 2 di 5" rather than a bare number. Omitted by
 *             default, in which case no attribute is rendered.
 *
 * Always drawn on a white surface (the pause card or the header pill), so the
 * card text tokens apply. Accessible: role="progressbar" with
 * aria-valuenow/min/max. SSR-safe: no browser APIs.
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    current: number
    total: number
    compact?: boolean
    hideCounts?: boolean
    valueText?: string
  }>(),
  { compact: false, hideCounts: false, valueText: undefined }
)

const percentage = computed(() => {
  if (props.total === 0) return 0
  return Math.round((props.current / props.total) * 100)
})
</script>
