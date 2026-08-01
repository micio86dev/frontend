<template>
  <div
    class="flex flex-col gap-6 p-6"
    role="region"
    :aria-label="$t('interview.device_check.title')"
  >
    <h2 class="text-xl font-semibold text-foreground">{{ $t('interview.device_check.title') }}</h2>

    <!-- Camera preview -->
    <div
      class="relative overflow-hidden rounded-lg bg-avatar-bg"
      style="aspect-ratio: 4/3; max-width: 320px"
    >
      <video
        ref="previewEl"
        class="size-full object-cover"
        autoplay
        playsinline
        muted
        :aria-label="$t('interview.device_check.camera_ok')"
      />
      <div
        v-if="!deviceCheck.cameraOk.value"
        class="absolute inset-0 flex items-center justify-center bg-muted"
      >
        <Skeleton class="size-full" />
      </div>
    </div>

    <!-- Status indicators -->
    <div class="flex flex-col gap-2">
      <!-- Camera status -->
      <div class="flex items-center gap-3">
        <div
          class="size-3 rounded-full"
          :class="deviceCheck.cameraOk.value ? 'bg-success' : 'bg-error'"
          :aria-label="
            deviceCheck.cameraOk.value
              ? $t('interview.device_check.camera_ok')
              : $t('interview.device_check.camera_error')
          "
          role="status"
        />
        <span
          class="text-sm"
          :class="deviceCheck.cameraOk.value ? 'text-foreground' : 'text-destructive'"
        >
          {{
            deviceCheck.cameraOk.value
              ? $t('interview.device_check.camera_ok')
              : $t('interview.device_check.camera_error')
          }}
        </span>
      </div>

      <!-- Microphone status -->
      <div class="flex items-center gap-3">
        <div
          class="size-3 rounded-full"
          :class="deviceCheck.micOk.value ? 'bg-success' : 'bg-muted-foreground'"
          :aria-label="
            deviceCheck.micOk.value
              ? $t('interview.device_check.mic_ok')
              : $t('interview.device_check.mic_error')
          "
          role="status"
        />
        <span
          class="text-sm"
          :class="deviceCheck.micOk.value ? 'text-foreground' : 'text-muted-foreground'"
        >
          {{
            deviceCheck.micOk.value
              ? $t('interview.device_check.mic_ok')
              : $t('interview.device_check.mic_error')
          }}
        </span>
      </div>
    </div>

    <!-- Alert on error -->
    <Alert v-if="checkError" variant="destructive">
      <AlertTitle>{{ $t('interview.device_check.camera_error') }}</AlertTitle>
      <AlertDescription>{{ checkError }}</AlertDescription>
    </Alert>

    <!-- Continue button -->
    <Button
      :disabled="!deviceCheck.cameraOk.value || !deviceCheck.micOk.value"
      @click="handleContinue"
    >
      {{ $t('interview.device_check.continue') }}
    </Button>
  </div>
</template>

<script setup lang="ts">
/**
 * DeviceCheck.client.vue — Browser-only device check UI.
 *
 * Wraps useDeviceCheck composable. Shows camera preview + mic level indicator.
 * Enables the "Continue" button only when both devices are confirmed.
 *
 * Emits 'confirmed' with the MediaStream to hand off to useProctor.
 *
 * .client.vue enforces SSR isolation — this component is never server-rendered.
 */
import { ref, onMounted, onUnmounted } from 'vue'
import { useDeviceCheck } from '~/composables/useDeviceCheck'
import { Alert, AlertTitle, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'

const emit = defineEmits<{
  confirmed: [stream: MediaStream]
}>()

const previewEl = ref<HTMLVideoElement | null>(null)
const checkError = ref<string | null>(null)
const deviceCheck = useDeviceCheck()

onMounted(async () => {
  await deviceCheck.check()

  if (deviceCheck.stream.value && previewEl.value) {
    previewEl.value.srcObject = deviceCheck.stream.value
  }

  if (!deviceCheck.cameraOk.value) {
    checkError.value = 'Camera not accessible'
  }
})

// Stream lifecycle: on confirmation the stream is handed to ProctorOverlay and managed
// there (D5, single getUserMedia). If this component unmounts WITHOUT a handoff, nothing
// else owns the stream — release it here rather than leaving the camera hot.
let handedOff = false

function handleContinue(): void {
  if (deviceCheck.stream.value) {
    handedOff = true
    emit('confirmed', deviceCheck.stream.value)
  }
}

onUnmounted(() => {
  if (handedOff) {
    // Mic RMS polling is this component's concern only; the stream is not ours to stop.
    deviceCheck.stopMicSampling()
  } else {
    deviceCheck.release()
  }
})
</script>
