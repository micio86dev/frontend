<template>
  <aside
    data-testid="call-panel"
    aria-labelledby="call-panel-title"
    class="brand-canvas__surface flex flex-row flex-wrap items-center gap-x-8 gap-y-4 rounded-surface bg-card p-6 text-card-foreground shadow-surface xl:min-h-0 xl:flex-1 xl:flex-col xl:flex-nowrap xl:items-stretch xl:gap-5"
  >
    <p
      id="call-panel-title"
      data-testid="call-panel-title"
      class="basis-full text-lg font-semibold xl:basis-auto"
    >
      {{ $t('interview.call.panel_label') }}
    </p>

    <!--
      Tempo di risposta: how long the current answer has been running, with the suggested-length
      bar when a budget exists. Always present (the figure reads 00:00 until the interviewer has
      spoken); guidance only, it never ends an answer.
    -->
    <section
      data-testid="call-panel-answer"
      aria-labelledby="call-panel-answer-label"
      class="flex min-w-56 flex-1 flex-col gap-3 xl:flex-none"
    >
      <p
        id="call-panel-answer-label"
        class="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
      >
        {{ $t('interview.call.answer.label') }}
      </p>
      <CallAnswerTimer
        :seconds="answerSeconds"
        :phase="answerPhase"
        :budget="budget"
        :mic-muted="micMuted"
      />
    </section>

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
      Durata dell'intervista. The heading, the figure, the bar and the sentence appear only once
      the SERVER has stated `interview_max_seconds`: the 300 s fallback seed of the countdown is
      never a maximum. The countdown itself is the interview's ONLY timeout enforcement (`tick` /
      `expired`), so it is never hidden: without a stated maximum the section shows that exact
      figure alone, and an enforcing timeout is never invisible to the candidate.

      The visible figure is hidden from assistive technology and the sentence that states the
      MAXIMUM is read instead: "03:12 / 20:00" alone does not say that 20:00 is a ceiling.
    -->
    <section
      data-testid="call-panel-duration"
      :aria-labelledby="hasMax ? 'call-panel-duration-label' : undefined"
      class="flex min-w-56 flex-1 flex-col gap-3 xl:flex-none"
    >
      <p
        v-if="hasMax"
        id="call-panel-duration-label"
        class="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
      >
        {{ $t('interview.call.duration.label') }}
      </p>
      <template v-if="hasMax">
        <p
          data-testid="call-panel-duration-value"
          aria-hidden="true"
          class="font-mono text-base font-semibold tabular-nums"
        >
          {{ $t('interview.call.duration.value', duration) }}
        </p>
        <span data-testid="call-panel-duration-sr" class="sr-only">{{
          $t('interview.call.duration.sr', duration)
        }}</span>
        <ProgressBar
          :current="elapsedClamped"
          :total="maxCount"
          hide-counts
          :label="$t('interview.call.duration.label')"
          :value-text="$t('interview.call.duration.sr', duration)"
        />
      </template>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
        <p
          v-if="hasMax && minutesLeft > 0"
          data-testid="call-panel-remaining"
          class="text-sm text-muted-foreground"
        >
          {{ $t('interview.call.duration.remaining', minutesLeft) }}
        </p>
        <InterviewTimer
          v-if="questionSeconds !== undefined"
          :key="timerKey ?? undefined"
          :seconds="questionSeconds"
          :label="$t('interview.call.remaining_label')"
          @tick="emit('tick', $event)"
          @expired="emit('expired')"
        />
      </div>
    </section>

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
 * Titled "Intervista". Top to bottom: "Tempo di risposta" (the answer timer, its chip and the
 * suggested-length bar), the "Percorso" section ("Competenza 2 di 5", a thin
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
 *   questionSeconds  — what the interview countdown starts from (the seconds LEFT in the whole interview).
 *                      Omitted: no countdown. It also feeds "Restano circa N minuti".
 *                      The caller owns the remaining time (see InterviewTimer) and
 *                      re-keys this component's counter on a new competency session
 *                      (the countdown itself is the WHOLE interview's, so the key changes only
 *                      its mount, never the time left).
 *   timerKey         — identifies the competency session the counter belongs to. The
 *                      counter only reads `questionSeconds` when it is created, so a new
 *                      session (which can keep the screen live: a handover never leaves
 *                      it) needs a new counter to start from the full limit. Not shown.
 *   storyboard       — the outline as `{ name, ordinal, status, primaryTotal }` items. Missing or
 *                      empty: no storyboard and no empty frame; the rest of the panel renders.
 *   primaryIndex     — the number of primary questions asked in the current competency session
 *                      (null when unknown); only the storyboard reads it.
 *   answerSeconds    — the answer timer (`useAnswerTimer`), owned by the page.
 *   answerPhase      — idle / listening / waiting / answering: the chip beside the timer.
 *   micMuted         — the candidate's own mute INTENT, for the hint (not the forced-mute state).
 *   budget           — the suggested answer length (`answerBudget()`), or null for no bar.
 *   maxSeconds       — the interview's real limit (the avatar template's, `interview_max_seconds`).
 *                      The duration section is shown ONLY once the server has stated it; the
 *                      client's 300 s fallback is never presented as a maximum.
 *
 * Emits: tick / expired — forwarded unchanged from the counter.
 *
 * Slots: help.
 */
import { computed } from 'vue'
import InterviewTimer from '~/components/InterviewTimer.vue'
import ProgressBar from '~/components/ProgressBar.vue'
import CallAnswerTimer, {
  type CallAnswerTimerProps,
} from '~/components/molecules/CallAnswerTimer.vue'
import CallStoryboard, { type StoryboardItem } from '~/components/molecules/CallStoryboard.vue'
import { formatClock } from '~/app/composables/useInterviewClock'

const props = withDefaults(
  defineProps<{
    ended: number | null
    total: number | null
    elapsedSeconds: number
    questionSeconds?: number
    timerKey?: number | null
    maxSeconds?: number | null
    storyboard?: StoryboardItem[] | null
    primaryIndex?: number | null
    answerSeconds?: number
    answerPhase?: CallAnswerTimerProps['phase']
    micMuted?: boolean
    budget?: CallAnswerTimerProps['budget']
  }>(),
  {
    questionSeconds: undefined,
    timerKey: null,
    maxSeconds: null,
    storyboard: null,
    primaryIndex: null,
    answerSeconds: 0,
    answerPhase: 'idle',
    micMuted: false,
    budget: null,
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

/** The server's maximum when it is a usable number, else 0: the section stays hidden. */
const maxCount = computed(() =>
  props.maxSeconds !== null && Number.isFinite(props.maxSeconds) && props.maxSeconds > 0
    ? props.maxSeconds
    : 0
)
const hasMax = computed(() => maxCount.value > 0)

/** Elapsed time kept inside [0, max]: past the maximum the bar and the text stay full and calm. */
const elapsedClamped = computed(() => Math.min(Math.max(props.elapsedSeconds, 0), maxCount.value))

/** The `{elapsed}` / `{total}` the duration texts are built from; `total` is a stated maximum. */
const duration = computed(() => ({
  elapsed: formatClock(elapsedClamped.value),
  total: formatClock(maxCount.value),
}))

/** "About N minutes left": the ceiling of the countdown the page owns; 0 hides the sentence. */
const minutesLeft = computed(() =>
  props.questionSeconds === undefined ? 0 : Math.max(Math.ceil(props.questionSeconds / 60), 0)
)
</script>
