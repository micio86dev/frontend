<template>
  <div
    class="flex flex-col gap-6 p-6"
    role="region"
    :aria-label="$t('interview.device_check.title')"
  >
    <h2 class="text-xl font-semibold text-foreground">{{ $t('interview.device_check.title') }}</h2>

    <!-- Camera preview — native aspect ratio (D1), never a hardcoded one, never
         cropped. previewRatio is already clamped to [3/4, 21/9] by the composable;
         null until the first acquisition resolves, so a 16:9 placeholder holds the
         Skeleton until then (same tick as the stream in the common case). -->
    <div
      data-testid="device-preview"
      class="relative w-full overflow-hidden rounded-lg bg-avatar-bg"
      :style="{ aspectRatio: String(deviceCheck.previewRatio.value ?? FALLBACK_RATIO) }"
    >
      <video
        ref="previewEl"
        data-testid="preview-video"
        class="size-full object-contain"
        autoplay
        playsinline
        muted
        :aria-label="$t('interview.device_check.title')"
      />
      <div
        v-if="!deviceCheck.cameraOk.value"
        class="absolute inset-0 flex items-center justify-center bg-muted"
      >
        <Skeleton class="size-full" />
      </div>
    </div>
    <FieldDescription>{{ $t('interview.device_check.camera_instruction') }}</FieldDescription>

    <!-- Status rows — indicator dots are decorative (aria-hidden); the adjacent
         text carries the semantics. Today each state was announced twice
         (role=status + aria-label on the dot AND the visible text row). -->
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-3">
        <div
          data-testid="camera-status-dot"
          class="size-3 rounded-full"
          :class="deviceCheck.cameraOk.value ? 'bg-success' : 'bg-error'"
          aria-hidden="true"
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

      <div class="flex items-center gap-3">
        <div
          data-testid="mic-status-dot"
          class="size-3 rounded-full"
          :class="deviceCheck.micOk.value ? 'bg-success' : 'bg-muted-foreground'"
          aria-hidden="true"
        />
        <span
          class="text-sm"
          :class="deviceCheck.micOk.value ? 'text-foreground' : 'text-muted-foreground'"
        >
          {{ micStatusText }}
        </span>
      </div>
    </div>

    <!-- Live microphone level meter (D5) — Progress supplies role=progressbar +
         aria-valuenow (reka-ui ProgressRoot). NEVER in a live region: a
         continuously-updating live region is a screen-reader denial of service.
         Non-visual equivalent is the static instruction below plus the single
         role=status announcement on the threshold crossing. -->
    <div class="flex flex-col gap-2">
      <div class="relative">
        <Progress
          data-testid="mic-meter"
          class="h-2"
          :model-value="micMeterPercent"
          :aria-label="$t('interview.device_check.mic_instruction')"
        />
        <div
          class="absolute top-0 h-2 w-px bg-foreground/60"
          aria-hidden="true"
          :style="{ left: micThresholdPercent + '%' }"
        />
      </div>
      <FieldDescription>{{ $t('interview.device_check.mic_instruction') }}</FieldDescription>
      <span data-testid="mic-detected-status" role="status" class="sr-only">
        {{ deviceCheck.micOk.value ? $t('interview.device_check.mic_detected') : '' }}
      </span>
    </div>

    <!-- Failure recovery — browser-neutral guidance (D7, no UA detection), plus
         Retry. No failure state on this screen may be terminal. -->
    <Alert v-if="showRecovery" variant="destructive" data-testid="recovery-alert">
      <AlertTitle>{{ $t('interview.device_check.recovery_title') }}</AlertTitle>
      <AlertDescription>
        {{ recoveryMessage }}
      </AlertDescription>
    </Alert>
    <Button v-if="showRecovery" variant="outline" data-testid="retry-button" @click="handleRetry">
      {{ $t('interview.device_check.retry') }}
    </Button>

    <!-- Continue — the mic gate is deliberately hard (D6): a spoken assessment
         with a dead microphone is unusable. -->
    <Button
      data-testid="continue-button"
      :disabled="!deviceCheck.cameraOk.value || !deviceCheck.micOk.value"
      @click="handleContinue"
    >
      {{ $t('interview.device_check.continue') }}
    </Button>
  </div>
</template>

<script setup lang="ts">
/**
 * DeviceCheck.client.vue — Browser-only device check UI (Slice 5 rebuild).
 *
 * Orchestrates useDeviceCheck; never calls a platform media API directly
 * (Technical Approach, design.md). Renders geometry, status, the live mic
 * meter, instructional/recovery copy, and the Continue/Retry gate.
 *
 * Picker wiring to useMediaDeviceList (camera/mic Select controls,
 * switchCamera/switchMicrophone) is Slice 6 — deliberately not in this file
 * yet, per the slice boundary in tasks.md.
 *
 * Emits 'confirmed' with the MediaStream to hand off to useProctor.
 *
 * .client.vue enforces SSR isolation — this component is never server-rendered.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useDeviceCheck, MIC_SPEAK_THRESHOLD } from '~/composables/useDeviceCheck'
import { Alert, AlertTitle, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'
import { Progress } from '~/components/ui/progress'
import { FieldDescription } from '~/components/ui/field'

const emit = defineEmits<{
  confirmed: [stream: MediaStream]
}>()

const { t } = useI18n()

// 16:9 placeholder — the majority ratio, so the common case (previewRatio
// resolves in the same tick as the stream) never shifts after first paint (D1).
const FALLBACK_RATIO = 16 / 9

// Display-only scaling (D5): the composable exposes raw smoothed RMS (0-1);
// speech RMS is ~0.05-0.20, so a linear 0-1 map would leave the bar visually
// dead. 0.35 puts the 0.04 pass threshold at a visible ~11%. DA6: reasoned,
// not empirically measured on real hardware — flagged for a calibration pass.
const MIC_METER_DISPLAY_CEILING = 0.35

const previewEl = ref<HTMLVideoElement | null>(null)
const deviceCheck = useDeviceCheck()
const checked = ref(false)

const micMeterPercent = computed(() =>
  Math.min(100, Math.round((deviceCheck.micLevel.value / MIC_METER_DISPLAY_CEILING) * 100))
)
const micThresholdPercent = computed(() =>
  Math.min(100, Math.round((MIC_SPEAK_THRESHOLD / MIC_METER_DISPLAY_CEILING) * 100))
)

const micStatusText = computed(() => {
  if (deviceCheck.micOk.value) return t('interview.device_check.mic_ok')
  if (deviceCheck.micUnavailable.value) return t('interview.device_check.mic_unavailable')
  return t('interview.device_check.mic_error')
})

// A Retry affordance is shown once the FIRST check has settled, whenever the
// candidate is not fully through: an explicit acquisition error, the mic-gate
// dead end (micUnavailable), or a camera that never came up. Not shown while
// the sampler is quietly still waiting for speech — that path is recoverable
// on its own and showing Retry there would just be noise.
const showRecovery = computed(
  () =>
    checked.value &&
    (deviceCheck.error.value !== null ||
      deviceCheck.micUnavailable.value ||
      !deviceCheck.cameraOk.value)
)

const recoveryMessage = computed(() =>
  deviceCheck.micUnavailable.value && deviceCheck.error.value === null
    ? t('interview.device_check.mic_unavailable')
    : t('interview.device_check.recovery_instructions')
)

onMounted(async () => {
  await deviceCheck.check()
  checked.value = true

  if (deviceCheck.stream.value && previewEl.value) {
    previewEl.value.srcObject = deviceCheck.stream.value
  }
})

// Stream lifecycle: on confirmation the stream is handed to ProctorOverlay and managed
// there (spec.md clause (d), single getUserMedia before confirmation). If this
// component unmounts WITHOUT a handoff, nothing else owns the stream — release it
// here rather than leaving the camera hot.
let handedOff = false

function handleContinue(): void {
  if (deviceCheck.stream.value) {
    handedOff = true
    emit('confirmed', deviceCheck.stream.value)
  }
}

async function handleRetry(): Promise<void> {
  deviceCheck.release()
  checked.value = false
  await deviceCheck.check()
  checked.value = true

  if (deviceCheck.stream.value && previewEl.value) {
    previewEl.value.srcObject = deviceCheck.stream.value
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
