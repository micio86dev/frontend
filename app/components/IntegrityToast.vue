<template>
  <span aria-hidden="true" class="sr-only" />
</template>

<script setup lang="ts">
/**
 * IntegrityToast — render-less component that fires vue-sonner toasts when
 * new integrity events arrive during a live interview session.
 *
 * Props:
 *   events — array of IntegrityEventInternal from useProctor
 *
 * Renders nothing — toasts are fired as side effects.
 * Uses vue-sonner (project convention — no custom toast component).
 * SSR-safe: toast() is called only inside watch(), never at module scope.
 */
import { watch } from 'vue'
import { toast } from 'vue-sonner'
import type { IntegrityEventInternal } from '~/app/utils/proctor-config'

const props = defineProps<{
  events: IntegrityEventInternal[]
}>()

watch(
  () => props.events,
  (newEvents, oldEvents) => {
    const newCount = newEvents.length
    const oldCount = (oldEvents ?? []).length
    if (newCount > oldCount) {
      // New event(s) arrived — show a non-blocking toast
      const latest = newEvents[newCount - 1]
      if (latest) {
        toast.warning(latest.type.replace(/_/g, ' '), {
          duration: 3000,
          position: 'bottom-right',
        })
      }
    }
  },
  { deep: false }
)
</script>
