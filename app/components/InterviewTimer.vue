<template>
  <div class="flex items-center gap-2">
    <span class="text-sm text-muted-foreground">{{ $t('interview.live.timer_label') }}</span>
    <time
      role="timer"
      :aria-label="$t('interview.live.timer_label')"
      :aria-live="remaining <= 10 ? 'assertive' : 'off'"
      class="font-mono text-lg font-semibold tabular-nums"
      :class="remaining <= 10 ? 'text-destructive' : 'text-foreground'"
    >
      {{ formattedTime }}
    </time>
  </div>
</template>

<script setup lang="ts">
/**
 * Timer — countdown component for the live interview screen.
 *
 * Props:
 *   seconds — countdown to start from, in seconds. NOT necessarily the full
 *             question limit: on resume the parent hands back what was left.
 *
 * Emits:
 *   tick    — the remaining seconds, every second. The parent OWNS the remaining
 *             time; this component only counts.
 *   expired — when the countdown reaches 0
 *
 * WHY THE PARENT OWNS THE REMAINING TIME:
 * This component is rendered inside the interview page's `v-if="state === 'live'"`
 * block, so pausing unmounts it and destroys `remaining` with the instance.
 * Keeping the countdown here meant every resume mounted a fresh instance that
 * restarted from the full limit — a candidate who paused and resumed repeatedly
 * got unlimited time on a question. On an assessment that is a fairness hole,
 * not a cosmetic bug. Emitting each tick lets the page persist the value across
 * the unmount and hand it straight back.
 *
 * SSR-safe: uses Vue's onMounted/onUnmounted with setInterval.
 * All text is i18n-keyed (D31).
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps<{
  seconds: number
}>()

const emit = defineEmits<{
  tick: [remaining: number]
  expired: []
}>()

const remaining = ref(props.seconds)
let intervalId: ReturnType<typeof setInterval> | null = null

const formattedTime = computed(() => {
  const m = Math.floor(remaining.value / 60)
  const s = remaining.value % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
})

function tick(): void {
  if (remaining.value <= 0) {
    if (intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
    }
    return
  }
  remaining.value -= 1
  // Reported BEFORE the expiry branch: the parent must see the final 0, or a
  // remount would re-arm it with the last non-zero value it happened to keep.
  emit('tick', remaining.value)
  if (remaining.value <= 0) {
    if (intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
    }
    emit('expired')
  }
}

onMounted(() => {
  if (remaining.value <= 0) {
    emit('expired')
    return
  }
  intervalId = setInterval(tick, 1000)
})

onUnmounted(() => {
  if (intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }
})
</script>
