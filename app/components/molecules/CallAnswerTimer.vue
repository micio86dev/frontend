<template>
  <div data-testid="call-answer-timer" class="flex flex-col gap-3">
    <!-- The row keeps its height while idle, so the chip appearing never pushes the bar down. -->
    <div class="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-2">
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

    <!-- The outer padding keeps an icon at a boundary near either end from clipping. -->
    <div v-if="zones" class="px-2">
      <div class="relative py-0.5">
        <div
          data-testid="call-answer-bar"
          role="progressbar"
          aria-valuemin="0"
          :aria-valuemax="zones.end"
          :aria-valuenow="zones.elapsed"
          :aria-valuetext="
            $t('interview.call.answer.budget_sr', {
              elapsed: formatBudgetTime(zones.elapsed),
              from: formatBudgetTime(budget!.min),
              to: formatBudgetTime(budget!.max),
            })
          "
          :aria-label="$t('interview.call.answer.budget_label')"
          class="flex h-2.5 w-full overflow-hidden rounded-full"
        >
          <div
            v-for="(zone, index) in zones.items"
            :key="zone.name"
            data-testid="call-answer-zone"
            :data-zone="zone.name"
            class="relative h-full"
            :class="[zone.track, index > 0 ? 'ml-0.5' : '']"
            :style="{ width: `${zone.width}%` }"
          >
            <div
              data-testid="call-answer-fill"
              class="h-full transition-[width] duration-300 motion-reduce:transition-none"
              :class="zone.ink"
              :style="{ width: `${zone.fill}%` }"
            />
          </div>
        </div>
        <span
          data-testid="call-answer-min-icon"
          class="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background text-success-dark"
          :style="{ left: `${(budget!.min * 100) / budget!.end}%` }"
        >
          <CircleCheckIcon aria-hidden="true" class="block size-4" />
        </span>
        <span
          data-testid="call-answer-max-icon"
          class="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background text-error-dark"
          :style="{ left: `${(budget!.max * 100) / budget!.end}%` }"
        >
          <AlarmClockIcon aria-hidden="true" class="block size-4" />
        </span>
      </div>
    </div>

    <!-- The figure sits UNDER the bar, as plain text: the bar says how far, this says how long. -->
    <time
      :datetime="`PT${Math.max(Math.floor(seconds), 0)}S`"
      class="font-mono text-4xl leading-none font-semibold tabular-nums"
      >{{ formatClock(seconds) }}</time
    >

    <template v-if="zones">
      <p data-testid="call-answer-labels" class="text-sm font-medium tabular-nums">
        {{
          $t('interview.call.answer.budget_range', {
            from: formatBudgetTime(budget!.min),
            to: formatBudgetTime(budget!.max),
          })
        }}
      </p>
      <p
        v-if="zones.elapsed > budget!.max"
        data-testid="call-answer-long"
        class="text-sm font-medium text-warning-dark"
      >
        {{ $t('interview.call.answer.budget_long') }}
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
 *   budget   — the good-answer range and the bar's scale end in whole seconds, or null (no bar,
 *              no labels). Guidance only: past the scale end the bar stays full and calm.
 *   micMuted — the candidate's own INTENT (not the visual state): the hint tells them to
 *              unmute, which they cannot do during a handover.
 *
 * NOT A LIVE REGION, NOT A TIMER ROLE. The figure is a plain <time>: announcing every second
 * would bury the question, and the page has exactly one `role="timer"`, the interview-time
 * countdown. The bar is a `progressbar` (spec: it exposes the answer time against the max to
 * assistive technology) whose value is read on demand, never announced; its min / ideal / max
 * range is also written as text under it, and a text hint appears once the answer runs long,
 * so colour is never the only carrier.
 *
 * Top to bottom: the status chip (and the muted hint), the bar with its two markers, then the
 * elapsed time as plain text UNDER the bar, the range sentence and the long-answer hint.
 *
 * The bar is three zones: too short [0, min), good answer [min, max], long (max, end]. Each
 * zone fills in turn, so the position reads against the guidance.
 */
import { computed } from 'vue'
import { AlarmClockIcon, CircleCheckIcon, MicOffIcon } from '@lucide/vue'
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

/** Zone names, widths as a share of the scale, ink classes, and how much of each the answer has filled. */
const zones = computed(() => {
  const budget = props.budget
  if (budget === null) return null

  const elapsed = Math.min(Math.max(Math.floor(props.seconds), 0), budget.end)
  const bounds = [0, budget.min, budget.max, budget.end]
  const kinds = [
    { name: 'short', track: 'bg-secondary', ink: 'bg-primary-ink' },
    { name: 'good', track: 'bg-primary-ink/30', ink: 'bg-primary-ink' },
    { name: 'long', track: 'bg-warning-light', ink: 'bg-warning' },
  ] as const

  const items = kinds.map((kind, index) => {
    const from = bounds[index]!
    const length = bounds[index + 1]! - from

    return {
      ...kind,
      width: (length * 100) / budget.end,
      fill: (Math.min(Math.max(elapsed - from, 0), length) * 100) / length,
    }
  })

  return { items, elapsed, end: budget.end }
})
</script>
