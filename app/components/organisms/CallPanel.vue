<template>
  <aside
    data-testid="call-panel"
    aria-labelledby="call-panel-title"
    class="brand-canvas__surface flex flex-row flex-wrap items-center gap-x-8 gap-y-4 rounded-surface bg-card p-6 text-card-foreground shadow-surface xl:flex-col xl:flex-nowrap xl:items-stretch xl:gap-5"
  >
    <p
      id="call-panel-title"
      data-testid="call-panel-title"
      class="basis-full text-lg font-semibold"
    >
      {{ $t('interview.call.panel_label') }}
    </p>

    <!--
      Percorso: where the candidate is in the interview. The sentence and bar state the server's
      total; the storyboard under them names the outline's competencies. A <p> label, not a
      heading, so the page's heading outline is unchanged.
    -->
    <section
      v-if="hasTotal || hasStoryboard"
      data-testid="call-panel-path"
      aria-labelledby="call-panel-path-label"
      class="flex min-h-0 min-w-56 flex-1 flex-col gap-3 xl:flex-1"
    >
      <p
        id="call-panel-path-label"
        class="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
      >
        {{ $t('interview.call.path.label') }}
      </p>
      <div v-if="hasTotal" data-testid="call-panel-progress" class="flex flex-col gap-2">
        <p data-testid="call-panel-progress-text" class="text-base font-semibold">
          {{ $t('interview.call.path.progress', progress) }}
        </p>
        <ProgressBar
          :current="endedCount"
          :total="totalCount"
          hide-counts
          :value-text="$t('interview.call.path.progress', progress)"
        />
      </div>
      <CallStoryboard v-if="hasStoryboard" :items="storyboard!" :primary-index="primaryIndex" />
    </section>

    <!--
      The visible figure is hidden from assistive technology and the sentence that
      states the MAXIMUM is read instead: "03:12 / 25:00" alone does not say that
      25:00 is a ceiling.
    -->
    <p v-if="hasTotal" data-testid="call-panel-duration" class="flex flex-col gap-1">
      <span class="text-sm text-muted-foreground">{{ $t('interview.call.duration_label') }}</span>
      <span
        data-testid="call-panel-duration-value"
        aria-hidden="true"
        class="font-mono text-base font-semibold tabular-nums"
      >
        {{ $t('interview.call.duration_value', duration) }}
      </span>
      <span data-testid="call-panel-duration-sr" class="sr-only">{{
        $t('interview.call.duration_sr', duration)
      }}</span>
    </p>

    <InterviewTimer
      v-if="questionSeconds !== undefined"
      :key="timerKey ?? undefined"
      :seconds="questionSeconds"
      :label="$t('interview.call.question_timer_label')"
      @tick="emit('tick', $event)"
      @expired="emit('expired')"
    />

    <div class="flex flex-wrap items-center gap-x-6 gap-y-3 xl:flex-col xl:items-stretch">
      <slot name="help" />
    </div>
  </aside>
</template>

<script setup lang="ts">
/**
 * CallPanel — the side panel of the candidate call screen
 * (candidate-interview-call-ui D7, D8; DESIGN.md §7.3).
 *
 * Titled "Intervista". Top to bottom: the "Percorso" section ("Competenza 2 di 5", a thin
 * bar, and the named storyboard), how long it has taken against the stated maximum
 * ("03:12 / 25:00"), the interview countdown, then the help link. Exit lives in the call
 * header.
 *
 * NAMES, NEVER A CODE (reversed from "numbers only", live-interview-call-chrome). The
 * storyboard shows the outline's competency NAMES, handed in already localized with a
 * generic fallback. The panel imports no session and has no prop that could carry a code, so
 * no element, attribute or accessible name can reveal one. A unit test holds that line,
 * including against a store that does carry one.
 *
 * Props:
 *   ended            — competencies ended so far; null before the first /end counts as 0.
 *   total            — the server's total; null or 0 hides progress and duration (the
 *                      figure is not known until the first /end, and a bar "of nothing"
 *                      would be a lie). The panel itself, the counter, Exit and help
 *                      are NEVER hidden (Exit is in the call header, so a candidate can leave
 *                      during the first question).
 *   elapsedSeconds   — from `useInterviewClock()`; owned by the caller.
 *   questionSeconds  — what the per-question counter starts from. Omitted: no counter.
 *                      The caller owns the remaining time (see InterviewTimer) and
 *                      re-keys this component's counter on a new competency session.
 *   timerKey         — identifies the competency session the counter belongs to. The
 *                      counter only reads `questionSeconds` when it is created, so a new
 *                      session (which can keep the screen live: a handover never leaves
 *                      it) needs a new counter to start from the full limit. Not shown.
 *   storyboard       — the outline as `{ name, ordinal, status, primaryTotal }` items. Missing or
 *                      empty: no storyboard and no empty frame; the rest of the panel renders.
 *   primaryIndex     — the number of primary questions asked in the current competency session
 *                      (null when unknown); only the storyboard reads it.
 *   maxSeconds       — the interview's real limit (the avatar template's, `interview_max_seconds`).
 *                      It is the stated maximum whenever the server sent one.
 *   secondsPerQuestion — only when `maxSeconds` is absent (an older API): the maximum is then
 *                      derived as total x this limit. Default 300.
 *
 * Emits: tick / expired — forwarded unchanged from the counter.
 *
 * Slots: help.
 */
import { computed } from 'vue'
import InterviewTimer from '~/app/components/InterviewTimer.vue'
import ProgressBar from '~/app/components/ProgressBar.vue'
import CallStoryboard, { type StoryboardItem } from '~/app/components/molecules/CallStoryboard.vue'
import { formatClock } from '~/app/composables/useInterviewClock'

const props = withDefaults(
  defineProps<{
    ended: number | null
    total: number | null
    elapsedSeconds: number
    questionSeconds?: number
    timerKey?: number | null
    maxSeconds?: number | null
    secondsPerQuestion?: number
    storyboard?: StoryboardItem[] | null
    primaryIndex?: number | null
  }>(),
  {
    questionSeconds: undefined,
    timerKey: null,
    maxSeconds: null,
    secondsPerQuestion: 300,
    storyboard: null,
    primaryIndex: null,
  }
)

const emit = defineEmits<{
  tick: [remaining: number]
  expired: []
}>()

const totalCount = computed(() => (props.total !== null && props.total > 0 ? props.total : 0))
const hasTotal = computed(() => totalCount.value > 0)
const hasStoryboard = computed(() => (props.storyboard?.length ?? 0) > 0)

/** Competencies ended, kept inside [0, total] so a server overshoot never reads as progress past the end. */
const endedCount = computed(() => Math.min(Math.max(props.ended ?? 0, 0), totalCount.value))

/** 1-based position of the current question, never above the total. */
const position = computed(() => Math.min(endedCount.value + 1, totalCount.value))

/** The `{n}` / `{total}` the progress sentence is built from; the bar's valuetext is the same string. */
const progress = computed(() => ({ n: position.value, total: totalCount.value }))

/** The `{elapsed}` / `{total}` the duration texts are built from; `total` is a stated maximum. */
const duration = computed(() => ({
  elapsed: formatClock(props.elapsedSeconds),
  total: formatClock(
    props.maxSeconds !== null && Number.isFinite(props.maxSeconds) && props.maxSeconds > 0
      ? props.maxSeconds
      : totalCount.value * props.secondsPerQuestion
  ),
}))
</script>
