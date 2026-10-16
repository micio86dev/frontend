<template>
  <ol
    data-testid="interview-steps"
    :aria-label="$t('interview.steps.label')"
    class="flex items-center gap-2 text-sm"
  >
    <!--
      Drawn straight on the brand canvas, so on-canvas tokens only (DESIGN.md
      §3.1 rule 1). The current step is the primary accent: a solid primary
      disc with the numeral in on-primary (>= 4.5:1 for any client colour),
      edged with the canvas guard (§3.1 rule 3). Steps ahead are muted, steps
      behind carry a check and a hidden "done" for screen readers.
    -->
    <li
      v-for="(step, index) in STEPS"
      :key="step"
      :aria-current="step === current ? 'step' : undefined"
      class="flex items-center gap-2"
      :class="index > currentIndex ? 'text-on-canvas-muted' : 'text-on-canvas'"
    >
      <span
        aria-hidden="true"
        class="interview-steps__disc flex size-6 shrink-0 items-center justify-center rounded-full border border-current text-xs font-semibold"
        :class="{ 'interview-steps__disc--current': step === current }"
      >
        <svg
          v-if="index < currentIndex"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="size-3.5"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
        <template v-else>{{ index + 1 }}</template>
      </span>
      <span :class="step === current ? 'font-semibold' : 'font-medium'">
        {{ $t(`interview.steps.${step}`) }}
        <span v-if="index < currentIndex" class="sr-only">({{ $t('interview.steps.done') }})</span>
      </span>
      <span
        v-if="index < STEPS.length - 1"
        aria-hidden="true"
        class="mx-1 h-px w-6 bg-current opacity-50"
      />
    </li>
  </ol>
</template>

<script setup lang="ts">
/**
 * Where the candidate is on the way into the interview: consent, then the
 * device check, then the interview itself. Shown in the canvas header on the
 * two pre-interview screens, where a candidate meeting a second card after the
 * first otherwise has no way to tell how many more are coming.
 *
 * Three steps, not the session's state machine: `connecting`, `paused` and the
 * rest are mechanics the candidate never needs named.
 */
import { computed } from 'vue'

const STEPS = ['consent', 'device_check', 'interview'] as const

const props = defineProps<{
  current: (typeof STEPS)[number]
}>()

const currentIndex = computed(() => STEPS.indexOf(props.current))
</script>

<style scoped>
/*
 * The current step: a primary disc with the numeral in on-primary. Written
 * here rather than as `bg-primary` so no template carries a bare primary fill
 * on the canvas: the disc is edged with `--color-primary-edge`, which is the
 * on-canvas colour while the primary is under 3:1 against the canvas
 * (DESIGN.md §3.1 rule 3) and the primary itself otherwise.
 */
.interview-steps__disc--current {
  background: var(--color-primary);
  border-color: var(--color-primary-edge);
  color: var(--color-on-primary);
}
</style>
