<template>
  <ol
    ref="list"
    data-testid="call-storyboard"
    :aria-label="$t('interview.call.storyboard.label')"
    :tabindex="overflowing ? 0 : undefined"
    class="flex min-h-0 flex-col gap-3 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <li
      v-for="row in rows"
      :key="row.ordinal"
      data-testid="call-storyboard-item"
      :data-status="row.status"
      :aria-current="row.status === 'current' ? 'step' : undefined"
      class="flex items-start gap-3"
    >
      <span
        data-testid="call-storyboard-marker"
        class="flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular-nums"
        :class="MARKER_CLASSES[row.status]"
      >
        <CheckIcon
          v-if="row.status === 'done'"
          data-icon="check"
          aria-hidden="true"
          class="size-4"
        />
        <RotateCcwIcon
          v-else-if="row.status === 'retry'"
          data-icon="retry"
          aria-hidden="true"
          class="size-4"
        />
        <template v-else>{{ row.ordinal }}</template>
      </span>

      <span class="flex min-w-0 flex-col">
        <span
          data-testid="call-storyboard-name"
          class="text-sm text-card-foreground"
          :class="row.status === 'current' ? 'font-semibold' : 'font-medium'"
          >{{ row.name }}</span
        >
        <span v-if="row.status === 'done'" class="sr-only">{{
          $t('interview.call.storyboard.done')
        }}</span>
        <span
          v-else-if="row.status === 'retry'"
          data-testid="call-storyboard-line"
          class="text-xs text-muted-foreground"
          >{{ $t('interview.call.storyboard.retry') }}</span
        >
        <span
          v-else-if="row.status === 'current'"
          data-testid="call-storyboard-line"
          class="text-xs text-muted-foreground"
          >{{
            row.counts
              ? $t('interview.call.storyboard.current_counted', row.counts)
              : $t('interview.call.storyboard.current')
          }}</span
        >
      </span>
    </li>
  </ol>
</template>

<script setup lang="ts">
/**
 * CallStoryboard — the interview panel's named path (live-interview-call-chrome D14 section 2;
 * DESIGN.md §7.3).
 *
 * Presentational: it is handed what to draw and reads no session. A name is text from the
 * outline, already given a generic fallback by the page; this component has no other
 * identifier for a competency and renders none.
 *
 * Props:
 *   items        — outline order: `{ name, ordinal, status, primaryTotal }`. `status` is one of
 *                  done / current / upcoming / retry.
 *   primaryIndex — the number of scripted primary questions asked so far in the current
 *                  competency session, from the latest utterance response; null when unknown.
 *
 * The current item reads "In corso · domanda k di n" with `k = primaryIndex` clamped into
 * 1..n when it is a number and n >= 1, and a bare "In corso" otherwise: "domanda 0 di n" and
 * "domanda 4 di 3" cannot be drawn.
 *
 * Status is carried by an icon AND text, never by colour alone: a check and a hidden
 * "Completata" for done, the numeral for upcoming, a retry glyph and "Da ripetere" for retry
 * (which differs from upcoming by text in forced colours), and the current step by
 * `aria-current="step"` plus its question line. The brand accent (`primary-ink`) only fills the
 * done marker and rings the current one: a graphic held to 3:1 on the white panel, never text.
 *
 * It scrolls inside the panel; a scrollable region has to be reachable by keyboard, so it
 * becomes a tab stop only while its content really overflows.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { CheckIcon, RotateCcwIcon } from '@lucide/vue'
import { useResizeObserver } from '@vueuse/core'

type Status = 'done' | 'current' | 'upcoming' | 'retry'

export interface StoryboardItem {
  name: string
  ordinal: number
  status: Status
  primaryTotal: number
}

const props = defineProps<{
  items: StoryboardItem[]
  primaryIndex: number | null
}>()

/** Done is the filled accent; current is the ringed accent; upcoming and retry stay neutral. */
const MARKER_CLASSES: Record<Status, string> = {
  done: 'bg-primary-ink text-white',
  current: 'border-2 border-primary-ink text-card-foreground',
  upcoming: 'border border-border text-muted-foreground',
  retry: 'border border-dashed border-card-foreground text-card-foreground',
}

function counts(total: number): { k: number; n: number } | null {
  const k = props.primaryIndex
  if (k === null || !Number.isFinite(k) || !(total >= 1)) return null

  return { k: Math.min(Math.max(k, 1), total), n: total }
}

const rows = computed(() =>
  props.items.map((item) => ({
    ...item,
    counts: item.status === 'current' ? counts(item.primaryTotal) : null,
  }))
)

const list = ref<HTMLElement | null>(null)
const overflowing = ref(false)

function measure(): void {
  const el = list.value
  overflowing.value = el !== null && el.scrollHeight > el.clientHeight
}

onMounted(measure)
useResizeObserver(list, measure)
watch(() => props.items, measure, { deep: true, flush: 'post' })
</script>
