<template>
  <div
    class="relative flex items-center justify-center overflow-hidden rounded-lg bg-avatar-bg"
    :class="isReady ? 'opacity-100' : 'opacity-0'"
    style="aspect-ratio: 16/9"
    aria-live="off"
  >
    <!--
      NEVER bind `muted` here. This element carries the INTERVIEWER's audio; the
      candidate's microphone is a separate channel controlled through
      provider.toggleMic(). Muting this video muted the interviewer whenever the
      candidate muted their own mic.
    -->
    <!--
      A <track> element cannot caption this stream: the source is a live WebRTC
      feed generated in real time by the avatar provider, and a track file
      requires content that exists before playback.

      The requirement itself is met by a different mechanism. The avatar's
      speech is rendered as live text by <InterviewCaption>, driven by the
      provider's transcript events — see the `transcript` handler in
      pages/interview/[token].vue. That is a caption in the sense WCAG 1.2.4
      (Captions, Live) actually asks for; <track> is one way to deliver it and
      not the applicable one here.

      Disabled on this line only, with the reason, rather than switching the
      rule off globally: the next <video> added to this app almost certainly
      SHOULD carry a track.
    -->
    <!-- eslint-disable-next-line vuejs-accessibility/media-has-caption -->
    <video
      ref="videoEl"
      class="size-full object-cover"
      autoplay
      playsinline
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
 * Mounts the avatar provider onto the <video> element.
 *
 * Deliberately unnamed. The provider is chosen server-side and the candidate
 * must never learn which one — a vendor name in a comment is not shipped, but
 * it is the first thing somebody copies into a label or an error string.
 * tests/unit/provider-anonymity.spec.ts holds this file to it.
 * Emits provider lifecycle events upward to the interview page container.
 *
 * .client.vue enforces Nuxt SSR-client isolation — this component is NEVER
 * rendered on the server.
 *
 * Props:
 *   provider   — the InterviewProvider instance (published by useInterviewSession)
 *   config     — StartConfig to pass to provider.start()
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
