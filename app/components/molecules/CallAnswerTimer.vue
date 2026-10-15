<template>
  <div data-testid="call-answer-timer" class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <time
        :datetime="`PT${Math.max(Math.floor(seconds), 0)}S`"
        class="font-mono text-4xl leading-none font-semibold tabular-nums"
        >{{ formatClock(seconds) }}</time
      >
      <Badge
        v-if="phase !== 'idle'"
        data-testid="call-answer-chip"
        variant="secondary"
        class="h-auto px-2.5 py-1 text-xs"
        >{{ $t(STATUS_KEYS[phase]) }}</Badge
      >
    </div>

    <p
      v-if="micMuted"
      data-testid="call-answer-muted"
      class="flex items-start gap-2 text-sm text-muted-foreground"
    >
      <MicOffIcon aria-hidden="true" class="mt-0.5 size-4 shrink-0" />
      <span>{{ $t('interview.call.answer.muted_hint') }}</span>
    </p>

    <template v-if="zones">
      <div
        data-testid="call-answer-bar"
        role="progressbar"
        aria-valuemin="0"
        :aria-valuemax="zones.max"
        :aria-valuenow="zones.elapsed"
        :aria-valuetext="
          $t('interview.call.answer.budget_sr', {
            elapsed: formatBudgetTime(zones.elapsed),
            max: formatBudgetTime(zones.max),
          })
        "
        :aria-label="$t('interview.call.answer.budget_label')"
        class="flex h-2.5 w-full overflow-hidden rounded-full"
      >
        <div
          v-for="(zone, index) in zones.items"
          :key="index"
          data-testid="call-answer-zone"
          class="relative h-full"
          :class="[zone.ideal ? 'bg-primary-ink/30' : 'bg-secondary', index > 0 ? 'ml-0.5' : '']"
          :style="{ width: `${zone.width}%` }"
        >
          <div
            data-testid="call-answer-fill"
            class="h-full bg-primary-ink transition-[width] duration-300 motion-reduce:transition-none"
            :style="{ width: `${zone.fill}%` }"
          />
        </div>
      </div>
      <p data-testid="call-answer-labels" class="text-sm font-medium tabular-nums">
        {{
          $t('interview.call.answer.budget_labels', {
            min: formatBudgetTime(budget!.min),
            from: formatBudgetTime(budget!.idealFrom),
            to: formatBudgetTime(budget!.idealTo),
            max: formatBudgetTime(budget!.max),
          })
        }}
      </p>
      <p data-testid="call-answer-note" class="text-xs text-muted-foreground">
        {{ $t('interview.call.answer.budget_note') }}
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * CallAnswerTimer — the "Tempo di risposta" section of the interview panel
 * (live-interview-call-chrome D14 section 1; DESIGN.md §7.3).
 *
 * Presentational: the page owns `useAnswerTimer` and `answerBudget()` and hands over their
 * values; this component reads no session.
 *
 * Props:
 *   seconds  — the answer time, counted from the moment the interviewer stopped speaking.
 *   phase    — idle / listening / waiting / answering. The chip states it in TEXT; idle has none.
 *   budget   — the suggested answer length in whole seconds, or null (no bar, no labels, no
 *              note). Guidance only: past the max the bar stays full and calm.
 *   micMuted — the candidate's own INTENT (not the visual state): the hint tells them to
 *              unmute, which they cannot do during a handover.
 *
 * NOT A LIVE REGION, NOT A TIMER ROLE. The figure is a plain <time>: announcing every second
 * would bury the question, and the page has exactly one `role="timer"`, the interview-time
 * countdown. The bar is a `progressbar` (spec: it exposes the answer time against the max to
 * assistive technology) whose value is read on demand, never announced; its min / ideal / max
 * are also written as text under it, so colour is never the only carrier.
 *
 * The bar is four zones: [0, min), [min, ideal from), [ideal from, ideal to], (ideal to, max].
 * Each zone fills in turn, so the position reads against the guidance.
 */
import { computed } from 'vue'
import { MicOffIcon } from '@lucide/vue'
import { Badge } from '~/components/ui/badge'
import { formatClock } from '~/app/composables/useInterviewClock'
import { formatBudgetTime, type AnswerBudget } from '~/app/utils/answer-budget'
import type { AnswerPhase } from '~/app/composables/useAnswerTimer'

export interface CallAnswerTimerProps {
  seconds: number
  phase: AnswerPhase
  budget: AnswerBudget | null
  micMuted: boolean
}

const props = defineProps<CallAnswerTimerProps>()

const STATUS_KEYS = {
  listening: 'interview.call.answer.status.listening',
  waiting: 'interview.call.answer.status.waiting',
  answering: 'interview.call.answer.status.answering',
} as const

/** Zone widths as a share of the max and how much of each zone the answer has filled. */
const zones = computed(() => {
  const budget = props.budget
  if (budget === null) return null

  const elapsed = Math.min(Math.max(Math.floor(props.seconds), 0), budget.max)
  const bounds = [0, budget.min, budget.idealFrom, budget.idealTo, budget.max]

  const items = [0, 1, 2, 3].map((index) => {
    const from = bounds[index]!
    const to = bounds[index + 1]!
    const length = to - from

    return {
      ideal: index === 2,
      width: (length * 100) / budget.max,
      fill:
        length === 0
          ? elapsed >= to
            ? 100
            : 0
          : (Math.min(Math.max(elapsed - from, 0), length) * 100) / length,
    }
  })

  return { items, elapsed, max: budget.max }
})
</script>
