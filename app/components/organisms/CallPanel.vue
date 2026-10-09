<template>
  <aside
    data-testid="call-panel"
    :aria-label="$t('interview.call.panel_label')"
    class="brand-canvas__surface flex flex-col gap-5 rounded-surface bg-card p-6 text-card-foreground shadow-surface"
  >
    <section v-if="hasTotal" data-testid="call-panel-progress" class="flex flex-col gap-2">
      <p data-testid="call-panel-progress-text" class="text-base font-semibold">
        {{ $t('interview.call.progress', progress) }}
      </p>
      <ProgressBar
        :current="endedCount"
        :total="totalCount"
        hide-counts
        :value-text="$t('interview.call.progress', progress)"
      />
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

    <div class="flex flex-col gap-3">
      <slot name="exit" />
      <slot name="help" />
    </div>
  </aside>
</template>

<script setup lang="ts">
/**
 * CallPanel — the side panel of the candidate call screen
 * (candidate-interview-call-ui D7, D8; DESIGN.md §7.3).
 *
 * Top to bottom: where the candidate is ("Domanda 2 di 5" and a thin bar), how
 * long it has taken against the stated maximum ("03:12 / 25:00"), the per-question
 * counter, then Exit and the help link in that DOM order.
 *
 * PROGRESS AND TIME, NEVER A NAME. The panel is handed numbers and nothing else:
 * it imports no session and has no prop that could carry which competency is being
 * assessed, so no element, attribute or accessible name can reveal it. A unit test
 * holds that line, including against a store that does carry one.
 *
 * Props:
 *   ended            — competencies ended so far; null before the first /end counts as 0.
 *   total            — the server's total; null or 0 hides progress and duration (the
 *                      figure is not known until the first /end, and a bar "of nothing"
 *                      would be a lie). The panel itself, the counter, Exit and help
 *                      are NEVER hidden: a candidate must be able to leave during the
 *                      first question.
 *   elapsedSeconds   — from `useInterviewClock()`; owned by the caller.
 *   questionSeconds  — what the per-question counter starts from. Omitted: no counter.
 *                      The caller owns the remaining time (see InterviewTimer) and
 *                      re-keys this component's counter on a new competency session.
 *   timerKey         — identifies the competency session the counter belongs to. The
 *                      counter only reads `questionSeconds` when it is created, so a new
 *                      session (which can keep the screen live: a handover never leaves
 *                      it) needs a new counter to start from the full limit. Not shown.
 *   secondsPerQuestion — the per-question limit the maximum is derived from. Default 300,
 *                      the same limit the session page arms the counter with.
 *
 * Emits: tick / expired — forwarded unchanged from the counter.
 *
 * Slots: exit, help.
 */
import { computed } from 'vue'
import InterviewTimer from '~/app/components/InterviewTimer.vue'
import ProgressBar from '~/app/components/ProgressBar.vue'
import { formatClock } from '~/app/composables/useInterviewClock'

const props = withDefaults(
  defineProps<{
    ended: number | null
    total: number | null
    elapsedSeconds: number
    questionSeconds?: number
    timerKey?: number | null
    secondsPerQuestion?: number
  }>(),
  { questionSeconds: undefined, timerKey: null, secondsPerQuestion: 300 }
)

const emit = defineEmits<{
  tick: [remaining: number]
  expired: []
}>()

const totalCount = computed(() => (props.total !== null && props.total > 0 ? props.total : 0))
const hasTotal = computed(() => totalCount.value > 0)

/** Competencies ended, kept inside [0, total] so a server overshoot never reads as progress past the end. */
const endedCount = computed(() => Math.min(Math.max(props.ended ?? 0, 0), totalCount.value))

/** 1-based position of the current question, never above the total. */
const position = computed(() => Math.min(endedCount.value + 1, totalCount.value))

/** The `{n}` / `{total}` the progress sentence is built from; the bar's valuetext is the same string. */
const progress = computed(() => ({ n: position.value, total: totalCount.value }))

/** The `{elapsed}` / `{total}` the duration texts are built from; `total` is a stated maximum. */
const duration = computed(() => ({
  elapsed: formatClock(props.elapsedSeconds),
  total: formatClock(totalCount.value * props.secondsPerQuestion),
}))
</script>
