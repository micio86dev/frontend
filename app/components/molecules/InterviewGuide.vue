<template>
  <section
    class="flex flex-col gap-3"
    data-testid="interview-guide"
    aria-labelledby="guide-heading"
  >
    <h2 id="guide-heading" class="text-sm font-semibold text-foreground">
      {{ $t('interview.guide.title') }}
    </h2>

    <!--
      Numbered, because this is the order the next few minutes happen in. A
      candidate reads this once, before consenting, and never gets to re-read it
      mid-answer — so it says what will happen and what cannot be undone, and
      nothing else.
    -->
    <ol class="flex flex-col gap-2.5">
      <li v-for="(stepKey, index) in STEP_KEYS" :key="stepKey" class="flex gap-3">
        <span
          aria-hidden="true"
          class="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
        >
          {{ index + 1 }}
        </span>
        <span class="text-sm leading-6 text-muted-foreground">{{ $t(stepKey) }}</span>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
/**
 * "How this works", shown on the consent screen.
 *
 * Placed before consent on purpose: this is the only moment a candidate can
 * still read at their own pace. Once the avatar starts speaking, anything they
 * have not understood becomes a question they cannot ask — there is no operator
 * on the other side, and pausing to re-read costs them answering time.
 *
 * Deliberately five short lines. A longer explainer on a screen someone reaches
 * while nervous is a screen nobody reads.
 */
const STEP_KEYS = [
  'interview.guide.steps.0',
  'interview.guide.steps.1',
  'interview.guide.steps.2',
  'interview.guide.steps.3',
  'interview.guide.steps.4',
] as const
</script>
