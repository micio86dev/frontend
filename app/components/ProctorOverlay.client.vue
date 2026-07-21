<template>
  <!-- Invisible overlay: no visual output. Integrity events are shown via IntegrityToast. -->
  <IntegrityToast :events="pendingEvents" />
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
 *   stream              — shared MediaStream from DeviceCheck (single getUserMedia)
 *   getPendingEvents    — callback from useInterviewSession to supply events for beacon flush
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { useProctor } from '~/app/composables/useProctor'
import IntegrityToast from '~/app/components/IntegrityToast.vue'
import type { IntegrityEventInternal } from '~/app/utils/proctor-config'

const props = defineProps<{
  stream: MediaStream
  /** Injected by the parent page to let useInterviewSession read pending events on resize flush */
  onEventsUpdated?: (eventsArg: IntegrityEventInternal[]) => void
}>()

const pendingEvents = ref<IntegrityEventInternal[]>([])
const proctor = useProctor()

onMounted(async () => {
  proctor.start(props.stream)
  // Expose pending events upward if needed
  if (props.onEventsUpdated) {
    // Poll the pending batch — proctor.getPendingEvents is exposed for this
    const expose = proctor.getPendingEvents
    if (typeof expose === 'function') {
      const interval = setInterval(() => {
        const latestEvents = expose()
        pendingEvents.value = latestEvents
        props.onEventsUpdated?.(latestEvents)
      }, 1000)
      onUnmounted(() => clearInterval(interval))
    }
  }
})

onUnmounted(async () => {
  await proctor.stop()
})
</script>
