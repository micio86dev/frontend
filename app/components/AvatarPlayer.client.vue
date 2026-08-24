<template>
  <div
    class="flex items-center justify-center overflow-hidden rounded-lg bg-avatar-bg transition-opacity duration-200 ease-in-out motion-reduce:transition-none"
    :class="[isReady ? 'opacity-100' : 'opacity-0', overlay ? 'absolute inset-0' : 'relative']"
    style="aspect-ratio: 16/9"
    aria-live="off"
  >
    <!--
      `muted` (the `muted` PROP, imperatively applied below) is legal to bind
      to ONE thing only: this instance's handover ROLE (invisible-competency-
      handover D4) — whether it is the outgoing/live player (unmuted) or a
      hidden incoming player warming up behind it (muted, unmuted at the start
      of the crossfade). It is NEVER legal to bind it to the CANDIDATE's own
      microphone state. This element carries the INTERVIEWER's audio; the
      candidate's microphone is a separate channel controlled through
      provider.setMicMuted()/toggleMic(). Muting this video from the
      candidate's mic state muted the interviewer whenever the candidate
      muted their own mic — the defect this comment used to warn about
      unconditionally.
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
 *   overlay    — true for a non-`live` handover role (D6). Decided HERE, not by a
 *                `class` fallthrough from session.vue: this component's root already
 *                carries `relative`/`absolute` as part of its own class list, and a
 *                parent-injected `absolute inset-0` string-concatenated onto that is a
 *                same-property utility collision whose winner depends on Tailwind's
 *                generated CSS order, not on DOM class order — during a handover this
 *                silently left the incoming player in normal flow, clipped by the
 *                wrapper's `overflow-hidden`. A single internal ternary makes the two
 *                classes mutually exclusive by construction.
 *   muted      — handover-role downlink control (invisible-competency-handover
 *                D4). Defaults to false. NEVER bind this to the candidate's own
 *                microphone state — see the template comment above the <video>.
 *                ALSO seeds this session's own microphone UPLINK exactly once,
 *                right after `provider.start()` resolves (B1, four-lens
 *                review): `setMicMuted()` is a guaranteed no-op before the
 *                underlying provider session exists, so this is the earliest
 *                point at which muting an `incoming` handover session is even
 *                possible — closing the window where a hidden, unmuted mic
 *                would otherwise capture the candidate's answer to a question
 *                they have not been asked yet. This is a ONE-TIME seed, not a
 *                reactive binding: later `muted` prop changes (e.g. the D6
 *                `entering` role) only ever affect the video element below;
 *                the incoming's mic is unmuted explicitly and exactly once,
 *                by `promote()`, never by this prop reacting.
 *
 * Emits:
 *   state      — provider state changes
 *   transcript — transcript events from the avatar
 *   error      — provider errors
 *   painted    — fired ONCE, the first time a real frame has been presented
 *                (invisible-competency-handover D6/F3). Driven by
 *                `requestVideoFrameCallback` where available, else the first
 *                of `loadeddata`/`playing`. Deliberately NOT driven by the
 *                provider's own `ready` state — at least one provider emits
 *                `ready` unconditionally on session start, which does not
 *                imply a frame exists; gating the crossfade on it would fade
 *                to a dark `--color-avatar-bg` rectangle, worse than the
 *                panel it replaces. This component's own `isReady` opacity
 *                gate is driven by the SAME signal, which incidentally also
 *                stops the first connect from flashing that dark box.
 */
import { ref, onMounted, onUnmounted, watchEffect } from 'vue'
import { Skeleton } from '~/components/ui/skeleton'
import type {
  InterviewProvider,
  StartConfig,
  ProviderState,
  TranscriptEntry,
} from '~/types/interview-provider'

const props = withDefaults(
  defineProps<{
    provider: InterviewProvider
    config: StartConfig
    overlay?: boolean
    muted?: boolean
  }>(),
  { overlay: false, muted: false }
)

const emit = defineEmits<{
  state: [state: ProviderState]
  transcript: [entry: TranscriptEntry]
  error: [payload: unknown]
  painted: []
}>()

const videoEl = ref<HTMLElement | null>(null)
const isReady = ref(false)

// D4: applied IMPERATIVELY, not as a template `:muted` binding. On <video>,
// the `muted` DOM PROPERTY is what actually silences playback; the `muted`
// ATTRIBUTE is only consulted once, at parse time, for autoplay purposes —
// a template binding writes the attribute and silently fails to affect an
// already-playing element.
watchEffect(() => {
  const el = videoEl.value as HTMLVideoElement | null
  if (el) el.muted = props.muted
})

/** D6: whichever of rVFC / loadeddata / playing fires first, once only. */
function wirePaintedDetection(el: HTMLVideoElement) {
  let fired = false
  const fire = () => {
    if (fired) return
    fired = true
    isReady.value = true
    emit('painted')
  }

  const rvfc = (el as unknown as { requestVideoFrameCallback?: (cb: () => void) => void })
    .requestVideoFrameCallback
  if (typeof rvfc === 'function') {
    rvfc.call(el, fire)
  }
  el.addEventListener('loadeddata', fire, { once: true })
  el.addEventListener('playing', fire, { once: true })
}

onMounted(async () => {
  if (!videoEl.value) return

  props.provider.on('state', (statePayload) => {
    const providerState = statePayload as ProviderState
    emit('state', providerState)
  })

  props.provider.on('transcript', (transcriptPayload) => {
    emit('transcript', transcriptPayload as TranscriptEntry)
  })

  props.provider.on('error', (errorPayload) => {
    emit('error', errorPayload)
  })

  wirePaintedDetection(videoEl.value as HTMLVideoElement)

  await props.provider.start(videoEl.value, props.config)

  // B1: one-time mic-uplink seed — see the `muted` prop doc above. Fire-and-
  // forget, like every other setMicMuted() call site in this codebase; a
  // rejection here must not block the player from finishing its mount.
  props.provider.setMicMuted(props.muted).catch(() => {})
})

onUnmounted(async () => {
  try {
    await props.provider.stop()
  } catch {
    // Non-fatal: provider may already be stopped
  }
})
</script>
