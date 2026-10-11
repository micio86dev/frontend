<template>
  <!--
    The call layout. Whatever `live` is, this element and the layer slot inside it
    are the same ones: the player layer is rendered into it from the first
    `connecting` frame to the last, and only classes change (D3). That is what
    keeps each `AvatarPlayer` mounted once and `stop()`ped once; moving the layer
    to another parent would unmount a player and tear down the session that just
    won a handover.

    Not live it has no box of its own (`contents`), so the layer lays out exactly as
    it did before the stage existed. Live it is a grid: the layer and the question
    band stacked in the first column, the panel beside them from `xl`, under the
    question band as a strip below it.
  -->
  <div
    data-slot="call-layout"
    :data-live="live ? 'true' : 'false'"
    :data-embedded="embedded ? 'true' : 'false'"
    :class="layoutClasses"
  >
    <slot name="layer" :live="live" />

    <template v-if="live">
      <div data-slot="call-stage-question" class="min-w-0 [grid-area:question]">
        <slot name="question" />
      </div>
      <div data-slot="call-stage-panel" class="min-w-0 [grid-area:panel] xl:self-start">
        <slot name="panel" />
      </div>
      <!--
        The candidate's own tile shares the layer's grid cell, bottom right. A
        percentage width resolves against that cell, so the tile scales with the
        interviewer tile and is clamped to 9-14rem. Inert: it must never take a
        click or the focus.
      -->
      <div
        v-if="$slots.self"
        data-slot="call-stage-self"
        class="pointer-events-none relative z-10 m-3 w-[clamp(9rem,18%,14rem)] place-self-end [grid-area:layer]"
      >
        <slot name="self" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * CallStage — the layout of the candidate call screen
 * (candidate-interview-call-ui D2, D3, D13; DESIGN.md §7.3).
 *
 * Presentational: it places what it is given and owns no signal.
 *
 * Props:
 *   live     — the interview is live and its avatar is mounted. The question band,
 *              the side panel and the own tile exist only then.
 *   embedded — rendered inside the host's iframe. The stage is then width-driven
 *              only: no viewport-height unit (`vh`, `dvh`, `svh`) appears anywhere,
 *              because the host sizes the iframe from the height we report, and a
 *              height that depends on the iframe's own height never settles.
 *
 * Slots:
 *   layer    — the player mount layer, scoped with `{ live }` so the layer can swap
 *              its classes. It MUST be rendered into this slot in every state.
 *   question, panel, self — the stage parts, rendered while `live`.
 *
 * Hosted, the stage's width is capped so the whole stage fits the viewport height
 * (no vertical scroll at 1280x800, 1440x900 or 1920x1080): the tile is 16:9, so its
 * width follows from the height left after the chrome (`--call-chrome` in D2:
 * 16rem beside the panel, 21rem when the panel is a strip), plus the panel and gap.
 * The floor of 30rem keeps a very short window from shrinking the tile to nothing.
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    live: boolean
    embedded?: boolean
  }>(),
  { embedded: false }
)

/** Hosted only. The one place a viewport-height unit may appear in the call components. */
const HOSTED_HEIGHT_CAP = [
  'max-w-[min(100%,max(30rem,calc((100dvh_-_21rem)*16/9)))]',
  'xl:max-w-[min(100%,max(30rem,calc((100dvh_-_16rem)*16/9_+_var(--spacing-call-panel)_+_1.5rem)))]',
]

const LIVE_GRID = [
  'mx-auto grid w-full gap-x-6 gap-y-4',
  "grid-cols-[minmax(0,1fr)] [grid-template-areas:'layer'_'question'_'panel']",
  'xl:grid-cols-[minmax(0,1fr)_var(--spacing-call-panel)] xl:grid-rows-[auto_auto_1fr]',
  "xl:[grid-template-areas:'layer_panel'_'question_panel'_'rest_panel']",
]

const layoutClasses = computed(() =>
  props.live ? [...LIVE_GRID, ...(props.embedded ? [] : HOSTED_HEIGHT_CAP)] : ['contents']
)
</script>
