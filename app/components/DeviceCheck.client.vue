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

    <!-- Camera + microphone pickers (D11 item 2). 44px trigger (--spacing-control),
         border-input (§16 rule 8, applies here per D8). Disabled while a switch is
         in flight or permanently after Continue (A7). Blank platform labels fall
         back to a numbered "Camera N" / "Microphone N" name. -->
    <Field>
      <FieldLabel for="device-check-camera-select">
        {{ $t('interview.device_check.camera_picker_label') }}
      </FieldLabel>
      <Select
        :model-value="deviceCheck.activeSelection.value.cameraId ?? undefined"
        :disabled="pickersDisabled"
        @update:model-value="onCameraChange"
      >
        <SelectTrigger
          id="device-check-camera-select"
          data-testid="camera-select-trigger"
          class="h-(--spacing-control) w-full"
        >
          <SelectValue :placeholder="$t('interview.device_check.camera_picker_label')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="(camera, index) in mediaDeviceList.cameras.value"
            :key="camera.deviceId"
            :value="camera.deviceId"
          >
            {{
              camera.isFallbackLabel
                ? $t('interview.device_check.camera_fallback', { n: index + 1 })
                : camera.label
            }}
          </SelectItem>
        </SelectContent>
      </Select>
    </Field>

    <Field>
      <FieldLabel for="device-check-mic-select">
        {{ $t('interview.device_check.mic_picker_label') }}
      </FieldLabel>
      <Select
        :model-value="deviceCheck.activeSelection.value.micId ?? undefined"
        :disabled="pickersDisabled"
        @update:model-value="onMicChange"
      >
        <SelectTrigger
          id="device-check-mic-select"
          data-testid="mic-select-trigger"
          class="h-(--spacing-control) w-full"
        >
          <SelectValue :placeholder="$t('interview.device_check.mic_picker_label')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="(mic, index) in mediaDeviceList.microphones.value"
            :key="mic.deviceId"
            :value="mic.deviceId"
          >
            {{
              mic.isFallbackLabel
                ? $t('interview.device_check.mic_fallback', { n: index + 1 })
                : mic.label
            }}
          </SelectItem>
        </SelectContent>
      </Select>
    </Field>

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
      <!-- The vendored destructive variant sets *:data-[slot=alert-description]:text-destructive/90
           on the Alert root, but AlertDescription also hardcodes text-muted-foreground on
           itself; both are single-class-selector specificity, so which one wins depends on
           Tailwind's generated CSS order rather than markup nesting — an axe-caught AA
           contrast failure. Passing the same color explicitly here lets tailwind-merge (used
           inside AlertDescription's own cn()) deterministically drop text-muted-foreground. -->
      <AlertDescription class="text-destructive/90">
        {{ recoveryMessage }}
      </AlertDescription>
    </Alert>
    <Button v-if="showRecovery" variant="outline" data-testid="retry-button" @click="handleRetry">
      {{ $t('interview.device_check.retry') }}
    </Button>

    <!-- Continue — the mic gate is deliberately hard (D6): a spoken assessment
         with a dead microphone is unusable. disabled:opacity-90 overrides the
         vendored default's disabled:opacity-50: WCAG 1.4.3 exempts inactive
         controls from the contrast minimum, but this button is disabled by
         DEFAULT on first paint (before the mic has had a chance to pass) and
         axe scans this screen in that exact state — so it must independently
         hold >=4.5:1 rather than rely on the exemption. -->
    <Button
      data-testid="continue-button"
      class="disabled:opacity-90"
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
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useDeviceCheck, MIC_SPEAK_THRESHOLD } from '~/composables/useDeviceCheck'
import { useMediaDeviceList } from '~/composables/useMediaDeviceList'
import { Alert, AlertTitle, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'
import { Progress } from '~/components/ui/progress'
import { Field, FieldLabel, FieldDescription } from '~/components/ui/field'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '~/components/ui/select'

const emit = defineEmits<{
  /**
   * Handoff on Continue.
   *
   * The second payload is the microphone deviceId actually in use, read back from
   * getSettings() — not the one that was requested. The avatar provider opens its
   * own capture track and cannot inherit this stream, so without the id it falls
   * back to the OS default: the candidate tests one microphone and is recorded
   * through another. Undefined when the browser exposed no id (permissions can
   * withhold it), which the provider reads as "use your default".
   */
  confirmed: [stream: MediaStream, micDeviceId: string | undefined]
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
const mediaDeviceList = useMediaDeviceList()
const checked = ref(false)
const confirmed = ref(false)

// Pickers disable while a switch is in flight, and PERMANENTLY once the
// candidate has continued (A7) — no switch may follow the handoff.
const pickersDisabled = computed(() => deviceCheck.switching.value || confirmed.value)

// Keeps the preview <video> element's srcObject in sync with whatever stream
// the composable currently owns — the initial check(), a Retry, and every
// device switch all flow through this single reactive assignment.
watch(
  () => deviceCheck.stream.value,
  (stream) => {
    if (previewEl.value) previewEl.value.srcObject = stream
  }
)

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

/**
 * D4 data flow: pre-flight enumerate (ids only, labels may be blank) ->
 * validate the stored cookie preference against it (drops a stale id, the
 * PRIMARY fallback mechanism) -> check() with the surviving pins -> on
 * success, reconcile the cookie to what was ACTUALLY obtained -> post-grant
 * enumerate (labels now populated) -> subscribe to devicechange.
 */
async function runInitialCheck(): Promise<void> {
  await mediaDeviceList.refresh()
  const preferred = mediaDeviceList.validatePreferences()
  await deviceCheck.check(preferred)
  checked.value = true

  if (deviceCheck.cameraOk.value && deviceCheck.error.value === null) {
    mediaDeviceList.persist(deviceCheck.activeSelection.value)
  }
  await mediaDeviceList.refresh()
  mediaDeviceList.start()
}

onMounted(runInitialCheck)

// Stream lifecycle: on confirmation the stream is handed to ProctorOverlay and managed
// there (spec.md clause (d), single getUserMedia before confirmation). If this
// component unmounts WITHOUT a handoff, nothing else owns the stream — release it
// here rather than leaving the camera hot.
let handedOff = false

function handleContinue(): void {
  if (deviceCheck.stream.value) {
    handedOff = true
    confirmed.value = true
    emit(
      'confirmed',
      deviceCheck.stream.value,
      deviceCheck.activeSelection.value.micId ?? undefined
    )
  }
}

async function handleRetry(): Promise<void> {
  deviceCheck.release()
  checked.value = false
  await runInitialCheck()
}

async function onCameraChange(deviceId: unknown): Promise<void> {
  if (typeof deviceId !== 'string') return
  await deviceCheck.switchCamera(deviceId)
  reconcileAfterSwitch()
}

async function onMicChange(deviceId: unknown): Promise<void> {
  if (typeof deviceId !== 'string') return
  await deviceCheck.switchMicrophone(deviceId)
  reconcileAfterSwitch()
}

/** Rewrites the cookie to whatever was ACTUALLY obtained by the switch — the
 * same D4 step 4 reconciliation the initial check() performs. */
function reconcileAfterSwitch(): void {
  if (deviceCheck.error.value === null) {
    mediaDeviceList.persist(deviceCheck.activeSelection.value)
  }
}

onUnmounted(() => {
  mediaDeviceList.stop()
  if (handedOff) {
    // Mic RMS polling is this component's concern only; the stream is not ours to stop.
    deviceCheck.stopMicSampling()
  } else {
    deviceCheck.release()
  }
})
</script>
