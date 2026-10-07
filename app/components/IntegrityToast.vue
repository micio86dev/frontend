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
 * Renders nothing — toasts are fired as side effects and drawn by the single
 * `<Toaster>` InterviewSession mounts. Each toast is a localized instruction
 * (title + one line) from `interview.integrity_toast.<kind>`; the machine kind is
 * never shown, and an unknown kind falls back to the generic copy
 * (`integrityToastKey`).
 *
 * One toast per kind: the kind is the toast id, so a repeated detection
 * refreshes the toast already on screen instead of stacking copies of it.
 * SSR-safe: toast() is called only inside watch(), never at module scope.
 */
import { watch } from 'vue'
import { toast } from 'vue-sonner'
import type { IntegrityEventInternal } from '~/utils/proctor-config'
import { integrityToastKey } from '~/utils/integrity-toast-copy'

/** Long enough to read a title and one line without rushing (WCAG 2.2.1). */
const TOAST_DURATION_MS = 6000

const props = defineProps<{
  events: IntegrityEventInternal[]
}>()

const { t } = useI18n()

watch(
  () => props.events,
  (newEvents, oldEvents) => {
    if (newEvents.length <= (oldEvents ?? []).length) return

    const latest = newEvents[newEvents.length - 1]
    const key = latest ? integrityToastKey(latest.type) : null
    if (!key) return

    toast.warning(t(`${key}.title`), {
      id: key,
      description: t(`${key}.description`),
      duration: TOAST_DURATION_MS,
    })
  },
  { deep: false }
)
</script>
