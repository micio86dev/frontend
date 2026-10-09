<template>
  <!--
    ONE persistent live region: it never unmounts, and the hint and the question
    swap inside it, so a screen reader announces each new question as a whole.
    `tabindex="0"` because the band scrolls (a scrollable region must be
    keyboard reachable) and because it is the programmatic focus target at a
    competency boundary.
  -->
  <div
    ref="band"
    data-testid="call-question"
    role="region"
    tabindex="0"
    aria-live="polite"
    aria-atomic="true"
    :aria-label="$t('interview.call.question_region')"
    class="brand-canvas__surface max-h-44 min-h-24 overflow-y-auto rounded-surface bg-card px-6 py-4 text-card-foreground shadow-surface outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
  >
    <p v-if="text" class="text-xl leading-8 font-medium text-card-foreground">{{ text }}</p>
    <p v-else data-testid="call-question-hint" class="text-sm leading-7 text-muted-foreground">
      {{ $t('interview.live.listen_hint') }}
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * CallQuestion — the written question band under the interviewer tile
 * (candidate-interview-call-ui D6; DESIGN.md §7.3, §9.2).
 *
 * Props:
 *   text — the avatar's latest utterance. Empty shows the listen hint. The text
 *          is kept until the parent replaces it; this component never fades or
 *          clears it on its own.
 *
 * Exposed:
 *   focusOnBoundary() — moves focus to the band. The parent calls it ONCE per
 *          competency boundary. It is deliberately not tied to `text`: focus
 *          that follows every utterance would drag a keyboard user back to the
 *          band mid-answer. It does nothing while a dialog is open, so the exit
 *          dialog is never robbed of its focus.
 *
 * SSR-safe: `document` is only touched inside `focusOnBoundary`.
 */
import { ref } from 'vue'

defineProps<{
  text: string
}>()

const band = ref<HTMLElement | null>(null)

/** Reka's dialogs mount their content only while open; `data-state` guards a forced-mounted one. */
const OPEN_DIALOG =
  '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])'

function focusOnBoundary(): void {
  if (document.querySelector(OPEN_DIALOG)) return

  band.value?.focus()
}

defineExpose({ focusOnBoundary })
</script>
