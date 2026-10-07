<template>
  <!--
    Out of flow (`fixed`, no size): the interview's flex column puts a gap between
    its children, and an empty live region must not cost the layout one. The
    toasts themselves are fixed to the viewport by vue-sonner.

    `z-[500]` (--z-toast, DESIGN.md §3.6) sits HERE, not only on the toaster: a
    fixed box is a stacking context of its own, so a z-index inside it cannot rise
    above the avatar panel that follows it in the DOM — it did, and the avatar
    covered the toast.
  -->
  <div data-testid="integrity-toaster" class="fixed z-[500] size-0">
    <Toaster
      position="top-right"
      :offset="OFFSET"
      :mobile-offset="OFFSET"
      :visible-toasts="3"
      close-button
      :container-aria-label="$t('interview.integrity_toast.region_label')"
      :toast-options="{ closeButtonAriaLabel: $t('interview.integrity_toast.close') }"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * The candidate interview's one Toaster: where IntegrityToast's notices appear.
 *
 * Top right, under the header. Every other edge holds something the candidate
 * needs: the bottom is the live dock (caption on the left, the Pause control on
 * the right) and, before a decision, the analytics consent banner; the header's
 * right end is the status pill with the timer. Under the header the toast can
 * only overlap a corner of the avatar video, never a control or a reading.
 *
 * The offsets add the safe-area insets, so a notched display never clips it.
 * Announced politely by vue-sonner's `aria-live="polite"` region (DESIGN.md §9.3)
 * and never focused: a toast is information, not an interruption.
 */
import { Toaster } from '~/components/ui/sonner'

/**
 * Top: the header's 1.5rem padding + the 2.75rem status pill, then a 1rem gap.
 * Right: flush with the header's column (`max-w-6xl` = 72rem, `lg:px-10`), so the
 * toast lines up under the status pill instead of hugging the viewport edge.
 */
const OFFSET = {
  top: 'calc(5.25rem + env(safe-area-inset-top, 0px))',
  right: 'calc(max(1rem, (100vw - 72rem) / 2 + 2.5rem) + env(safe-area-inset-right, 0px))',
  bottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
  left: 'calc(1rem + env(safe-area-inset-left, 0px))',
} as const
</script>
