<template>
  <div data-testid="call-header" class="flex w-full min-w-0 items-center gap-4">
    <p
      data-testid="call-header-title"
      class="mr-auto line-clamp-2 min-w-0 text-base font-semibold text-on-canvas"
    >
      {{ title }}
    </p>

    <div class="flex shrink-0 items-center gap-2">
      <!--
        Controls drawn from the CARD tokens, never `bg-background` / `text-foreground`: on the
        brand canvas only the card pair (and the primary surface pair) keeps its measured contrast
        on any colour. The organization's PRIMARY colour is the accent of ACTIVE states: captions
        on and microphone on = primary surface + ink border (the live microphone adds a green
        dot); captions off = neutral card; microphone muted = error-dark on error-light with a
        red dot. Colour is never the only cue: the visible label states the state, the icon
        swaps and `aria-pressed` repeats it. Hover fills are OPAQUE mixes, never a `/NN` alpha of
        the surface: the controls sit on the canvas, which can be dark, and a translucent fill
        over it leaves the dark label on a dark pixel.
      -->
      <Button
        data-testid="call-header-captions"
        variant="outline"
        :aria-pressed="captionsEnabled ? 'true' : 'false'"
        class="h-(--spacing-control) gap-2 px-4 transition-colors"
        :class="
          captionsEnabled
            ? 'border-primary-ink bg-primary-surface text-on-primary-surface hover:bg-[color-mix(in_oklab,var(--color-primary-surface)_70%,white)]'
            : 'bg-card text-card-foreground hover:bg-[color-mix(in_oklab,var(--color-primary-surface)_40%,white)]'
        "
        @click="emit('toggle-captions')"
      >
        <CaptionsIcon v-if="captionsEnabled" data-icon="captions" aria-hidden="true" />
        <CaptionsOffIcon v-else data-icon="captions-off" aria-hidden="true" />
        {{
          $t(
            captionsEnabled
              ? 'interview.call.header.captions_on'
              : 'interview.call.header.captions_off'
          )
        }}
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
        class="h-(--spacing-control) gap-2 px-4 transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        :class="
          micMuted
            ? 'border-error-dark bg-error-light text-error-dark hover:bg-[color-mix(in_oklab,var(--color-error)_22%,white)] hover:text-error-dark'
            : 'border-primary-ink bg-primary-surface text-on-primary-surface hover:bg-[color-mix(in_oklab,var(--color-primary-surface)_70%,white)]'
        "
        @click="onToggleMic"
      >
        <MicOffIcon v-if="micMuted" data-icon="mic-off" aria-hidden="true" />
        <MicIcon v-else data-icon="mic" aria-hidden="true" />
        <span
          v-if="micMuted"
          data-slot="mic-muted-dot"
          aria-hidden="true"
          class="size-2 shrink-0 rounded-full bg-error-dark"
        />
        <span
          v-else
          data-slot="mic-live-dot"
          aria-hidden="true"
          class="size-2 shrink-0 rounded-full bg-success-dark"
        />
        {{
          $t(
            micMuted
              ? 'interview.call.header.microphone_off'
              : 'interview.call.header.microphone_on'
          )
        }}
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
 * the already-localized title, then Sottotitoli, Microfono and the Exit slot in this DOM and
 * tab order. It carries NO clock: the panel's countdown is the interview's one timer. There is no Camera, "Ripeti domanda" or Pause control.
 *
 * Props:
 *   title           — already localized by the page.
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

const props = defineProps<{
  title: string
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
