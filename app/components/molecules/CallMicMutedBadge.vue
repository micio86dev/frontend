<template>
  <!--
    The live region is persistent and only its content comes and goes, so the appearance of the
    badge is announced. Colour is never the only cue: the text states what is wrong and the action
    states how to fix it.
  -->
  <div role="status" aria-live="polite" class="pointer-events-none flex justify-center">
    <Transition
      enter-active-class="motion-safe:transition motion-safe:duration-200 motion-safe:ease-out"
      enter-from-class="motion-safe:-translate-y-2 motion-safe:scale-95 motion-safe:opacity-0"
      leave-active-class="motion-safe:transition motion-safe:duration-150 motion-safe:ease-in"
      leave-to-class="motion-safe:-translate-y-2 motion-safe:scale-95 motion-safe:opacity-0"
    >
      <div
        v-if="visible"
        data-testid="call-mic-muted-badge"
        class="pointer-events-auto flex max-w-full items-center gap-3 rounded-full bg-error-dark py-1.5 pr-1.5 pl-4 text-sm font-medium text-white shadow-surface"
      >
        <span>{{ $t('interview.call.mic_muted.text') }}</span>
        <Button
          data-testid="call-mic-muted-unmute"
          variant="outline"
          size="sm"
          class="h-8 shrink-0 rounded-full border-transparent bg-card px-4 text-error-dark transition-colors hover:bg-error-light hover:text-error-dark"
          @click="emit('unmute')"
        >
          {{ $t('interview.call.mic_muted.action') }}
        </Button>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
/**
 * CallMicMutedBadge — tells the candidate the interviewer cannot hear them and offers the fix.
 *
 * Presentational. Shown while the candidate's own microphone is off; the page decides when.
 *
 * Props:   visible — whether the badge is shown.
 * Emits:   unmute  — the action was pressed (the page turns the microphone back on).
 */
import { Button } from '~/components/ui/button'

defineProps<{ visible: boolean }>()
const emit = defineEmits<{ unmute: [] }>()
</script>
