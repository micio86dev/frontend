<template>
  <!-- Invisible overlay: no visual output. Integrity events are shown via IntegrityToast. -->
  <IntegrityToast :events="observedEvents" />
</template>

<script setup lang="ts">
/* eslint-disable no-unused-vars */
/**
 * ProctorOverlay.client.vue — Invisible proctoring overlay.
 *
 * Starts useProctor with the shared MediaStream handed off from DeviceCheck.
 * Renders IntegrityToast to surface detected events.
 *
 * .client.vue enforces SSR isolation — never server-rendered.
 *
 * Props:
 *   stream           — shared MediaStream from DeviceCheck (single getUserMedia)
 *   sessionId        — DB session id; POST /snapshot is suppressed while it is null
 *   onEventsUpdated  — called on every integrity event with the events still awaiting
 *                      flush, plus the acknowledge callback the flusher must invoke
 *                      once they have actually been sent
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { useProctor } from '~/composables/useProctor'
import IntegrityToast from '~/components/IntegrityToast.vue'
import type { IntegrityEventInternal } from '~/utils/proctor-config'

const props = defineProps<{
  stream: MediaStream
  sessionId?: number | null
  /**
   * Injected by the parent page to let useInterviewSession read and acknowledge
   * pending events on the resize/pagehide beacon flush.
   */
  onEventsUpdated?: (
    eventsArg: IntegrityEventInternal[],
    acknowledgeArg: (acknowledgedArg: IntegrityEventInternal[]) => void
  ) => void
}>()

/** Display log for the toast — every event ever observed, in order. */
const observedEvents = ref<IntegrityEventInternal[]>([])

// Push-based: useProctor calls onEvent the moment an event is recorded, so there is no
// 1s polling interval and no window where a toast lags behind the detection.
const proctor = useProctor({
  getSessionId: () => props.sessionId ?? null,
  onEvent: (event) => {
    observedEvents.value = [...observedEvents.value, event]
    props.onEventsUpdated?.(proctor.getPendingEvents(), proctor.acknowledgeEvents)
  },
})

onMounted(() => {
  proctor.start(props.stream)
})

// Registered at setup scope, NOT inside onMounted: a lifecycle hook registered from
// within another hook's callback only binds while the instance is still current, so a
// single `await` before it would have silently stopped the cleanup from registering.
onUnmounted(() => {
  proctor.stop()
})
</script>
