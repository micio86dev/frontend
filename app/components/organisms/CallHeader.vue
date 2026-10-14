<template>
  <div data-testid="call-header" class="flex w-full min-w-0 items-center gap-4">
    <p
      data-testid="call-header-title"
      class="mr-auto line-clamp-2 min-w-0 text-base font-semibold text-on-primary"
    >
      {{ title }}
    </p>

    <!--
      An accessible name, but NOT a live region and NOT role="timer": it must not announce each
      second, and the page has exactly one timer role (the interview-time-remaining countdown).
    -->
    <p
      data-testid="call-header-clock"
      class="shrink-0 font-mono text-base font-semibold text-on-primary tabular-nums"
    >
      <span class="sr-only">{{ $t('interview.call.header.elapsed_sr') }}</span>
      {{ ' ' }}
      <time>{{ formatClock(elapsedSeconds) }}</time>
    </p>

    <div class="flex shrink-0 items-center gap-2">
      <Button
        data-testid="call-header-captions"
        variant="outline"
        :aria-pressed="captionsEnabled ? 'true' : 'false'"
        class="h-(--spacing-control) gap-2 px-4"
        @click="emit('toggle-captions')"
      >
        <CaptionsIcon v-if="captionsEnabled" data-icon="captions" aria-hidden="true" />
        <CaptionsOffIcon v-else data-icon="captions-off" aria-hidden="true" />
        {{ $t('interview.call.header.captions') }}
      </Button>

      <!--
        `aria-disabled`, not `disabled`: while the boundary or a handover holds the microphone
        shut the control stays focusable and its state is still announced.
      -->
      <Button
        data-testid="call-header-mic"
        variant="outline"
        :aria-pressed="micMuted ? 'false' : 'true'"
        :aria-disabled="micDisabled ? 'true' : undefined"
        class="h-(--spacing-control) gap-2 px-4 aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        @click="onToggleMic"
      >
        <MicOffIcon v-if="micMuted" data-icon="mic-off" aria-hidden="true" />
        <MicIcon v-else data-icon="mic" aria-hidden="true" />
        {{ $t('interview.call.header.microphone') }}
      </Button>

      <slot name="exit" />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * CallHeader — the live call's top bar content (live-interview-call-chrome, D13;
 * DESIGN.md §7.0.1, §7.3).
 *
 * Presentational only. It sits in `BrandCanvas`'s `header-end` slot, which spans the row:
 * the already-localized title, the elapsed clock, then Sottotitoli, Microfono and the Exit
 * slot in this DOM and tab order. There is no Camera, "Ripeti domanda" or Pause control.
 *
 * Props:
 *   title           — already localized by the page.
 *   elapsedSeconds  — the live clock (`useInterviewClock`), owned by the caller.
 *   captionsEnabled — the stored preference; pressed means captions are on.
 *   micMuted        — the VISUAL state: the candidate's choice, or an interview-owned mute.
 *   micDisabled     — an interview-owned mute is in force (boundary or handover).
 *
 * Emits: toggle-captions, toggle-mic (never while the microphone is disabled).
 *
 * Slot: exit (the page puts `CallExitDialog` there).
 */
import { CaptionsIcon, CaptionsOffIcon, MicIcon, MicOffIcon } from '@lucide/vue'
import { Button } from '~/components/ui/button'
import { formatClock } from '~/app/composables/useInterviewClock'

const props = defineProps<{
  title: string
  elapsedSeconds: number
  captionsEnabled: boolean
  micMuted: boolean
  micDisabled: boolean
}>()

const emit = defineEmits<{
  'toggle-captions': []
  'toggle-mic': []
}>()

function onToggleMic(): void {
  if (!props.micDisabled) emit('toggle-mic')
}
</script>
