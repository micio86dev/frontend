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
 *   seconds — initial countdown in seconds
 *
 * Emits:
 *   expired — when the countdown reaches 0
 *
 * SSR-safe: uses Vue's onMounted/onUnmounted with setInterval.
 * All text is i18n-keyed (D31).
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps<{
  seconds: number
}>()

const emit = defineEmits<{
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
