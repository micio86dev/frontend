<template>
  <CallTile :name="t('interview.call.you')" :speaking-label="speakingLabel" :speaking="speaking">
    <!--
      Display only. Every attribute here keeps the tile inert: no controls, no
      focus, no pointer events (the camera tile must never trap focus or
      swallow a click, design A3). The mirror is a CSS flip of the rendered
      pixels; the stream is the very one the proctoring layer reads.
    -->
    <video
      v-if="hasLiveVideo"
      :ref="bindVideo"
      data-slot="self-view-video"
      class="pointer-events-none aspect-video size-full -scale-x-100 object-cover"
      :aria-label="t('interview.call.self_view')"
      tabindex="-1"
      autoplay
      muted
      playsinline
      disablePictureInPicture
    />
    <div
      v-else
      data-slot="self-view-off"
      role="img"
      :aria-label="t('interview.call.self_view_off')"
      class="pointer-events-none flex aspect-video size-full items-center justify-center text-white/70"
    >
      <!-- Camera-off glyph; inline, as NoticeShell does (D37). -->
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" class="size-6">
        <path
          d="M3.7 2.3a1 1 0 0 0-1.4 1.4l2.2 2.2A3 3 0 0 0 3 8v8a3 3 0 0 0 3 3h8c.6 0 1.2-.2 1.7-.5l4.6 4.2a1 1 0 0 0 1.4-1.4l-17-17.2ZM21 8.6a1 1 0 0 0-1.1.2L17 11.4V8a3 3 0 0 0-3-3H8.4l9 9H17v-.6l3.4 3.1a1 1 0 0 0 1.6-.8V9.5a1 1 0 0 0-1-.9Z"
        />
      </svg>
    </div>
  </CallTile>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import CallTile from './CallTile.vue'

/**
 * CallSelfView — the candidate's own camera tile on the call screen
 * (DESIGN.md §7.3; change `candidate-interview-call-ui`, D5).
 *
 * It only CONSUMES a stream another part of the app already holds (the
 * device-check `confirmedStream`): it never calls `getUserMedia`, never stops
 * or clones a track, and never replaces the stream it was given. Placing and
 * sizing the tile (bottom right of the interviewer tile) is the parent's job.
 *
 * With no live video track (none at all, or every one `ended`) it swaps the
 * video for a static placeholder carrying its own accessible name.
 * `speaking` / `speakingLabel` pass straight through to `CallTile`'s ring.
 */
const props = withDefaults(
  defineProps<{
    /** The stream to display, owned by someone else. */
    stream: MediaStream
    /** Already-localized hidden text for the ring, shown only while speaking. */
    speakingLabel?: string
    speaking?: boolean
  }>(),
  { speakingLabel: '', speaking: false }
)

// Imported by name (not auto-registered), so it keeps the name it is stubbed and traced by.
defineOptions({ name: 'CallSelfView' })

const { t } = useI18n()

let videoEl: HTMLVideoElement | null = null
const hasLiveVideo = ref(false)

function refresh(stream: MediaStream) {
  hasLiveVideo.value = stream.getVideoTracks().some((track) => track.readyState === 'live')
}

// Re-evaluate when the stream is swapped, when a track ends, or when the stream
// gains or loses a track. Listeners are removed on swap and on unmount.
watch(
  () => props.stream,
  (stream, _previous, onCleanup) => {
    const watched = new Set<MediaStreamTrack>()
    const onChange = () => {
      stream.getVideoTracks().forEach((track) => {
        if (watched.has(track)) return
        watched.add(track)
        track.addEventListener('ended', onChange)
      })
      refresh(stream)
    }
    stream.addEventListener('addtrack', onChange)
    stream.addEventListener('removetrack', onChange)
    onChange()
    onCleanup(() => {
      watched.forEach((track) => track.removeEventListener('ended', onChange))
      stream.removeEventListener('addtrack', onChange)
      stream.removeEventListener('removetrack', onChange)
    })
  },
  { immediate: true }
)

// The <video> exists only while a live track does. A function ref runs
// synchronously on mount and on unmount, so the stream is attached the moment
// the element is, and detached (never stopped: it is not ours) when it goes.
// Vue re-runs it on every patch of this element, and a changed `stream` prop
// always re-renders the component, so a swapped stream is rebound here too.
function bindVideo(el: unknown) {
  if (videoEl && el === null) videoEl.srcObject = null
  videoEl = el as HTMLVideoElement | null
  if (videoEl) videoEl.srcObject = props.stream
}
</script>
