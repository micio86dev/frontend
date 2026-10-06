<template>
  <ol
    data-testid="interview-steps"
    :aria-label="$t('interview.steps.label')"
    class="flex items-center gap-2 text-sm"
  >
    <!--
      Drawn straight on the brand canvas, so on-primary tokens only (DESIGN.md
      §3.1 rule 1). The current step is a solid on-primary disc with the
      numeral in the canvas colour: that pair is the canvas pair itself,
      >= 4.5:1 for any client colour. Steps ahead are muted, steps behind
      carry a check and a hidden "done" for screen readers.
    -->
    <li
      v-for="(step, index) in STEPS"
      :key="step"
      :aria-current="step === current ? 'step' : undefined"
      class="flex items-center gap-2"
      :class="index > currentIndex ? 'text-on-primary-muted' : 'text-on-primary'"
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
 * The current step: an on-primary disc with the numeral in the canvas colour.
 * Written here rather than as `text-primary` so no template ever carries the
 * class that is invisible on the canvas; the pair is the canvas pair itself.
 */
.interview-steps__disc--current {
  background: var(--color-on-primary);
  border-color: var(--color-on-primary);
  color: var(--color-primary);
}
</style>
