<template>
  <div
    class="relative flex items-center justify-center overflow-hidden rounded-lg bg-avatar-bg"
    :class="isReady ? 'opacity-100' : 'opacity-0'"
    style="aspect-ratio: 16/9"
    aria-live="off"
  >
    <video
      ref="videoEl"
      class="size-full object-cover"
      autoplay
      playsinline
      :muted="micMuted"
      :aria-label="$t ? $t('interview.live.timer_label') : 'Avatar video'"
    />
    <div v-if="!isReady" class="absolute inset-0 flex items-center justify-center">
      <Skeleton class="size-full" />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * AvatarPlayer.client.vue — Browser-only avatar video player.
 *
 * Mounts the avatar provider (HeyGen/Tavus) onto the <video> element.
 * Emits provider lifecycle events upward to the interview page container.
 *
 * .client.vue enforces Nuxt SSR-client isolation — this component is NEVER
 * rendered on the server.
 *
 * Props:
 *   provider   — the InterviewProvider instance (from createProvider())
 *   config     — StartConfig to pass to provider.start()
 *   micMuted   — whether the mic is muted (drives <video muted>)
 *
 * Emits:
 *   state      — provider state changes
 *   transcript — transcript events from the avatar
 *   error      — provider errors
 */
import { ref, onMounted, onUnmounted } from 'vue'
import { Skeleton } from '~/components/ui/skeleton'
import type {
  InterviewProvider,
  StartConfig,
  ProviderState,
  TranscriptEntry,
} from '~/types/interview-provider'

const props = defineProps<{
  provider: InterviewProvider
  config: StartConfig
  micMuted?: boolean
}>()

const emit = defineEmits<{
  state: [state: ProviderState]
  transcript: [entry: TranscriptEntry]
  error: [payload: unknown]
}>()

const videoEl = ref<HTMLElement | null>(null)
const isReady = ref(false)

onMounted(async () => {
  if (!videoEl.value) return

  props.provider.on('state', (statePayload) => {
    const providerState = statePayload as ProviderState
    if (
      providerState === 'ready' ||
      providerState === 'listening' ||
      providerState === 'speaking'
    ) {
      isReady.value = true
    }
    emit('state', providerState)
  })

  props.provider.on('transcript', (transcriptPayload) => {
    emit('transcript', transcriptPayload as TranscriptEntry)
  })

  props.provider.on('error', (errorPayload) => {
    emit('error', errorPayload)
  })

  await props.provider.start(videoEl.value, props.config)
})

onUnmounted(async () => {
  try {
    await props.provider.stop()
  } catch {
    // Non-fatal: provider may already be stopped
  }
})
</script>
