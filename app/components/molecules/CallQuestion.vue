<template>
  <!--
    ONE persistent live region: it never unmounts, and the hint and the question
    swap inside it, so a screen reader announces each new question as a whole.
    The visible overlay IS that region, so the text is announced once, never twice.

    Captions on, it is the overlay over the bottom of the interviewer's video: opaque
    `bg-avatar-bg` (any translucency would composite against unknown video and void the
    contrast guarantee), inset on the right by the own tile's width plus a gap and above the
    name chip, so it covers neither. `tabindex="0"` because it scrolls (a scrollable region
    must be keyboard reachable) and because it is the programmatic focus target at a
    competency boundary.

    Captions off, it is `sr-only` with no tabindex: no visible question text anywhere, but
    the text is still written here, so a screen reader keeps hearing every question.
  -->
  <div
    ref="band"
    data-testid="call-question"
    role="region"
    :tabindex="visible ? 0 : undefined"
    aria-live="polite"
    aria-atomic="true"
    :aria-label="$t('interview.call.question_region')"
    :class="visible ? OVERLAY_CLASSES : 'sr-only'"
  >
    <p v-if="text" class="text-xl leading-8 font-medium text-white">
      <span data-testid="call-question-speaker" class="font-semibold text-primary-caption">{{
        `${speakerName}:`
      }}</span>
      {{ ' ' }}
      <span data-testid="call-question-text">{{ text }}</span>
    </p>
    <p v-else data-testid="call-question-hint" class="text-base leading-7 text-white/80">
      {{ $t('interview.live.listen_hint') }}
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * CallQuestion — the captions overlay on the interviewer's video
 * (candidate-interview-call-ui D6; live-interview-call-chrome D8; DESIGN.md §7.3, §9.2).
 *
 * Props:
 *   text        — the avatar's latest utterance. Empty shows the listen hint. The text
 *                 is kept until the parent replaces it; this component never fades or
 *                 clears it on its own.
 *   speakerName — the interviewer's name, shown before each caption in the 4.5:1 caption
 *                 colour. Already localized, rendered as text only.
 *   visible     — captions on (default). Off, nothing is visible and the region is
 *                 `sr-only` without a tabindex, but it stays mounted and keeps receiving
 *                 the text.
 *
 * Exposed:
 *   focusOnBoundary() — moves focus to the overlay. The parent calls it ONCE per
 *          competency boundary. It is deliberately not tied to `text`: focus
 *          that follows every utterance would drag a keyboard user back to the
 *          overlay mid-answer. It does nothing while a dialog is open, so the exit
 *          dialog is never robbed of its focus, and nothing while captions are off
 *          (there is no visible surface to focus).
 *
 * SSR-safe: `document` is only touched inside `focusOnBoundary`.
 */
import { ref } from 'vue'

const props = withDefaults(
  defineProps<{
    text: string
    speakerName: string
    visible?: boolean
  }>(),
  { visible: true }
)

const band = ref<HTMLElement | null>(null)

/** Bottom of the video, left of the own tile: 9-14rem wide plus its 0.75rem margin and a gap. */
const OVERLAY_CLASSES = [
  'absolute bottom-11 left-3 z-20 right-[calc(clamp(9rem,18%,14rem)+1.5rem)]',
  'max-h-[6rem] overflow-y-auto rounded-md bg-avatar-bg px-4 py-2 text-white',
  'outline-none focus-visible:ring-3 focus-visible:ring-white/70',
]

/** Reka's dialogs mount their content only while open; `data-state` guards a forced-mounted one. */
const OPEN_DIALOG =
  '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])'

function focusOnBoundary(): void {
  if (!props.visible) return
  if (document.querySelector(OPEN_DIALOG)) return

  band.value?.focus()
}

defineExpose({ focusOnBoundary })
</script>
