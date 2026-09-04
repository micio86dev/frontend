<template>
  <div class="relative flex size-full items-center justify-center" data-testid="voice-visualizer">
    <!--
      `role="img"` with a STATIC label, never a live region.

      What the interviewer is saying is already delivered as text by
      <InterviewCaption>, driven by the provider's transcript events — that is
      the WCAG 1.2.4 answer and it is live. This canvas carries one further
      fact, "the voice is speaking right now", and announcing that on every
      amplitude change would bury the caption under noise. So it is labelled
      once and left alone.
    -->
    <canvas
      ref="canvasEl"
      class="size-full"
      role="img"
      :aria-label="label"
      data-testid="voice-visualizer-canvas"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * VoiceVisualizer.client.vue — what a candidate looks at when there is no face.
 *
 * WHY THIS EXISTS
 * ---------------
 * A voice-only template hands the browser a stream with NO video track. The
 * page mounted it on a `<video>` anyway, and the element painted an undecoded
 * frame: green and black vertical banding, for the whole interview, where a
 * face was supposed to be. A candidate has no way to read that as "this
 * assessment is audio-only" — it reads as broken.
 *
 * WHAT IT DRAWS, AND WHY NOT THE OBVIOUS THING
 * --------------------------------------------
 * A symmetric waveform ribbon: per-column peak amplitude, mirrored about the
 * centreline, drawn as ONE continuous filled shape with smoothed corners.
 *
 * Not a bar equaliser — that is the first thing anyone reaches for and it reads
 * as a music player, which is the wrong promise in an assessment. Not a
 * pulsing orb either, which is the second thing anyone reaches for and belongs
 * to voice assistants. A continuous ribbon is honest about what it shows (it
 * IS the amplitude envelope), and it has the one property this screen needs:
 * in silence it collapses to a hairline rather than to nothing, so "not
 * speaking" and "not working" never look the same.
 *
 * Restrained palette on the dark `--color-avatar-bg` panel: lavender
 * (`#8373d2`) rather than the brand purple, which at `#771aaf` sits too close
 * to `#0f172a` to carry a thin stroke.
 *
 * MEASURED, not estimated (DESIGN.md §9.1 asks for a real calculation, and this
 * comment previously claimed ≈5.4:1, which was simply wrong): lavender on
 * `--color-avatar-bg` is 4.55:1, the gradient's `primary-light` edge 3.79:1,
 * and the resting baseline at 85% alpha 3.64:1. All clear of the 3:1 floor for
 * graphical objects, the baseline by the narrowest margin because it is the
 * thinnest mark.
 *
 * MOTION IS STATE, NEVER DECORATION. The ribbon moves only because the voice
 * does. Under `prefers-reduced-motion` the animation loop is never started:
 * the panel paints ONCE per state change — a connect, a pause, a resize — and
 * holds still, rather than putting a 60fps surface in the candidate's
 * peripheral vision for the length of an interview. It is deliberately not a
 * slower animation; a reduced-motion preference is not a request for less
 * frequent motion.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    /**
     * The avatar's own audio, as published by the provider.
     *
     * Analysis ONLY. This component never plays it: the media element that
     * owns playback stays mounted and audible, because a second sink for the
     * same stream would double every word.
     */
    stream: MediaStream | null
    /**
     * False while the interview is paused, so the ribbon settles to its
     * resting hairline instead of freezing mid-syllable — a frozen waveform
     * reads as a crash.
     */
    active?: boolean
    label: string
  }>(),
  { active: true }
)

const canvasEl = ref<HTMLCanvasElement | null>(null)

/**
 * Sampled columns across the panel.
 *
 * Fixed rather than derived from width: the ribbon must look the same at
 * 1280px and 1920px, and a column count that grows with the viewport makes the
 * same voice render finer on a bigger screen — a difference nobody asked for.
 */
const COLUMNS = 96

/** Peak per column, retained across frames so movement can be eased. */
const levels = new Float32Array(COLUMNS)

/**
 * How fast a column chases its new peak, per frame.
 *
 * Raw analyser output is jittery enough to look like interference. Easing
 * toward the target is what turns a noisy signal into speech you can read at a
 * glance; too much and consonants smear into one blob.
 */
const EASING = 0.32

/** The ribbon never fully closes — silence is a line, not an absence. */
const MIN_HALF_HEIGHT_PX = 1.5

let audioContext: AudioContext | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null
let analyser: AnalyserNode | null = null
// `Uint8Array<ArrayBuffer>`, not the bare alias. Since TypeScript 5.7 the
// typed arrays are generic over their buffer, and `new Uint8Array(n)` widens to
// `ArrayBufferLike` — which `getByteTimeDomainData` refuses, because it cannot
// write into a SharedArrayBuffer. Allocating the buffer explicitly says which
// one this is.
let timeDomain: Uint8Array<ArrayBuffer> | null = null
let frame: number | null = null
/** The reduced-motion repaint handle — see `start()`. */
let slowTimer: number | null = null

/**
 * 250ms: four repaints a second. Slow enough that nobody reads it as
 * animation, fast enough that the ribbon still tracks whether a sentence is
 * happening.
 */
const REDUCED_MOTION_INTERVAL_MS = 250
let observer: ResizeObserver | null = null

const reducedMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

const label = computed(() => props.label)

/**
 * Attach the analyser to a stream.
 *
 * `AudioContext` may start suspended — browsers require a user gesture, and
 * although the device-check step already provided one, that guarantee is not
 * ours to assume across every engine. `resume()` is fire-and-forget: a
 * rejection means no animation, never a broken interview.
 */
function connect(stream: MediaStream): void {
  // Idempotent. A simultaneous change of `stream` AND `active` fires both
  // watchers, and the second `connect()` would strand the first context and its
  // running frame — leaked for the rest of the interview, at 60fps. The
  // REBUILDS test only exercised the sequential toggle, which is why nothing
  // saw it.
  disconnect()

  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

  if (AudioContextCtor === undefined) return

  audioContext = new AudioContextCtor()
  void audioContext.resume().catch(() => undefined)

  sourceNode = audioContext.createMediaStreamSource(stream)
  analyser = audioContext.createAnalyser()
  // 2048 samples is ~46ms at 44.1kHz: long enough that a single column is a
  // syllable rather than a click, short enough to keep the ribbon in step with
  // what the candidate hears.
  analyser.fftSize = 2048
  timeDomain = new Uint8Array(new ArrayBuffer(analyser.fftSize))

  // Deliberately NOT connected to `destination`. The analyser taps the stream;
  // routing it onward would play the avatar a second time, out of phase with
  // the media element that already owns playback.
  sourceNode.connect(analyser)
}

function disconnect(): void {
  if (frame !== null) {
    cancelAnimationFrame(frame)
    frame = null
  }

  if (slowTimer !== null) {
    window.clearInterval(slowTimer)
    slowTimer = null
  }

  sourceNode?.disconnect()
  analyser?.disconnect()
  void audioContext?.close().catch(() => undefined)

  sourceNode = null
  analyser = null
  audioContext = null
  timeDomain = null
}

/**
 * The brand colours, READ from the stylesheet rather than restated here.
 *
 * These were `rgba(131, 115, 210, …)` and `rgba(194, 34, 211, …)` — the hex
 * values of `--color-lavender` and `--color-primary-light` transcribed by
 * hand. Change the token and the canvas keeps painting the old brand: exactly
 * the drift the "never re-declare a brand token" rule exists to stop, only
 * expressed in `rgba()` instead of `@theme`. The header's contrast measurement
 * against `--color-avatar-bg` is only true while these are the same values, and
 * nothing bound them.
 *
 * Falls back to the DESIGN.md values when the custom property does not resolve
 * — a jsdom canvas, or a paint before styles land. A visible ribbon in slightly
 * wrong lavender beats an invisible one.
 */
let cachedColors: { lavender: string; primaryLight: string } | null = null

/**
 * Read once, not per frame.
 *
 * This ran inside `draw()` — a `getComputedStyle()` sixty times a second for
 * the length of an interview, resolving two custom properties that cannot
 * change without a restyle. Cached, and dropped on resize, which is when a
 * restyle would have taken effect anyway.
 */
function brandColors(): { lavender: string; primaryLight: string } {
  if (cachedColors !== null) return cachedColors

  cachedColors = readBrandColors()

  return cachedColors
}

function readBrandColors(): { lavender: string; primaryLight: string } {
  const styles = canvasEl.value !== null ? getComputedStyle(canvasEl.value) : null

  const read = (token: string, fallback: string): string =>
    styles?.getPropertyValue(token).trim() || fallback

  return {
    lavender: read('--color-lavender', '#8373d2'),
    primaryLight: read('--color-primary-light', '#c222d3'),
  }
}

/**
 * A canvas-safe colour with alpha applied.
 *
 * `color-mix()` rather than parsing the token into components: the value could
 * be a hex, an `oklch()`, or anything else CSS accepts, and a parser here would
 * be a second, worse implementation of the browser's. Canvas accepts any CSS
 * colour string.
 */
function withAlpha(color: string, alpha: number): string {
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`
}

/**
 * Size the backing store to the device's real pixels.
 *
 * A canvas sized only in CSS pixels renders the ribbon soft on every retina
 * display, which on a 1.5px hairline is the difference between a line and a
 * smudge.
 */
function resize(): void {
  const canvas = canvasEl.value

  if (canvas === null) return

  const ratio = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()

  canvas.width = Math.max(1, Math.round(rect.width * ratio))
  canvas.height = Math.max(1, Math.round(rect.height * ratio))

  // A resize is the one moment a restyle could have landed, so it is where the
  // cached tokens are dropped rather than on every frame.
  cachedColors = null
}

/** Read the current peak of each column from the analyser, eased. */
function sample(): void {
  if (analyser === null || timeDomain === null) {
    // No analyser (or paused): decay toward rest so the ribbon settles rather
    // than freezing at whatever amplitude the last frame happened to hold.
    for (let i = 0; i < COLUMNS; i += 1) {
      levels[i] = (levels[i] ?? 0) * (1 - EASING)
    }

    return
  }

  analyser.getByteTimeDomainData(timeDomain)

  const perColumn = Math.floor(timeDomain.length / COLUMNS)

  for (let column = 0; column < COLUMNS; column += 1) {
    let peak = 0

    for (let i = 0; i < perColumn; i += 1) {
      // Time-domain bytes are centred on 128; distance from centre IS the
      // amplitude. Peak rather than mean, because the mean of a waveform is
      // ~0 and would render every voice as silence.
      const deviation = Math.abs((timeDomain[column * perColumn + i] ?? 128) - 128) / 128

      if (deviation > peak) peak = deviation
    }

    const previous = levels[column] ?? 0
    levels[column] = previous + (peak - previous) * EASING
  }
}

function draw(): void {
  const canvas = canvasEl.value
  const context = canvas?.getContext('2d')

  if (canvas === null || context === null || context === undefined) return

  const { width, height } = canvas
  const centre = height / 2
  // Leave the outer eighth clear so a loud syllable never touches the panel
  // edge, which would read as clipping.
  const maxHalfHeight = (height / 2) * 0.78
  const step = width / (COLUMNS - 1)

  context.clearRect(0, 0, width, height)

  const { lavender, primaryLight } = brandColors()

  // Resting baseline, drawn UNDER the ribbon and always present. It is what
  // makes silence legible as "listening" rather than as a blank panel.
  // 0.85, not 0.28. At 0.28 the hairline composites to #2f3159 over
  // --color-avatar-bg and measures 1.45:1 — invisible, which inverts the
  // property this component exists to have: silence looked exactly like a
  // broken panel. 0.85 measures 3.64:1, a real margin over DESIGN.md §9.1's
  // 3:1 floor for graphical objects. Calculated, not eyeballed.
  context.strokeStyle = withAlpha(lavender, 0.85)
  context.lineWidth = Math.max(1, window.devicePixelRatio || 1)
  context.beginPath()
  context.moveTo(0, centre)
  context.lineTo(width, centre)
  context.stroke()

  const gradient = context.createLinearGradient(
    0,
    centre - maxHalfHeight,
    0,
    centre + maxHalfHeight
  )
  // Full opacity at the edges too: at 85% the primary-light stop measured
  // 3.03:1 — passing, with no margin at all. Full it is 3.79:1, and the
  // lavender centre 4.55:1.
  gradient.addColorStop(0, primaryLight)
  gradient.addColorStop(0.5, lavender)
  gradient.addColorStop(1, primaryLight)

  const half = (column: number): number =>
    Math.max(
      MIN_HALF_HEIGHT_PX * (window.devicePixelRatio || 1),
      (levels[column] ?? 0) * maxHalfHeight
    )

  context.beginPath()
  context.moveTo(0, centre - half(0))

  // Quadratic midpoint smoothing: each control point is a column peak and each
  // curve ends halfway to the next, which joins the columns into one outline
  // with no visible corners. Straight segments between peaks would read as a
  // bar chart with the gaps filled in, which is the shape this deliberately
  // is not.
  for (let column = 0; column < COLUMNS - 1; column += 1) {
    const x = column * step
    const nextX = (column + 1) * step
    const y = centre - half(column)
    const nextY = centre - half(column + 1)

    context.quadraticCurveTo(x, y, (x + nextX) / 2, (y + nextY) / 2)
  }

  context.lineTo(width, centre - half(COLUMNS - 1))
  context.lineTo(width, centre + half(COLUMNS - 1))

  for (let column = COLUMNS - 1; column > 0; column -= 1) {
    const x = column * step
    const previousX = (column - 1) * step
    const y = centre + half(column)
    const previousY = centre + half(column - 1)

    context.quadraticCurveTo(x, y, (x + previousX) / 2, (y + previousY) / 2)
  }

  context.lineTo(0, centre + half(0))
  context.closePath()

  context.fillStyle = gradient
  context.fill()
}

function loop(): void {
  sample()
  draw()
  frame = requestAnimationFrame(loop)
}

function start(): void {
  if (frame !== null || slowTimer !== null) return

  if (reducedMotion) {
    // No rAF loop — but not one paint either.
    //
    // It used to sample and draw exactly once, immediately after `connect()`,
    // when the analyser has no data yet: every byte reads 128, every level
    // resolves to zero, so it painted the resting hairline and was never
    // repainted for the rest of the interview. A reduced-motion candidate
    // watched a dark rectangle that never once said the interviewer was
    // speaking.
    //
    // A reduced-motion preference asks not to ANIMATE. It does not ask to stop
    // reporting state. Four repaints a second is not animation — it is the
    // cadence a status line would update at — and it is what keeps "not
    // speaking" distinguishable from "not working".
    slowTimer = window.setInterval(() => {
      sample()
      draw()
    }, REDUCED_MOTION_INTERVAL_MS)

    return
  }

  frame = requestAnimationFrame(loop)
}

watch(
  () => props.stream,
  (stream) => {
    disconnect()

    if (stream === null) {
      // Zeroed like the pause branch, and for the same reason: a shape left at
      // whatever amplitude the last frame held reads as a crash, not as
      // silence.
      for (let i = 0; i < COLUMNS; i += 1) {
        levels[i] = 0
      }

      draw()

      return
    }

    // Guarded on `active`, and this is not defensive padding: it is the
    // handover's happy path. An incoming player mounts with `muted: true`, so
    // `AvatarPlayer` passes `:active="false"`, and this watcher then fired on
    // the stream arriving — building an AudioContext and spinning a 60fps loop
    // for a hidden session meant to be inert for the whole overlap, and
    // animating under `prefers-reduced-motion` where nothing should animate at
    // all. It ran until promote() or clearIncomingProvider().
    if (!props.active) {
      draw()

      return
    }

    connect(stream)
    resize()
    start()
  },
  { immediate: true }
)

watch(
  () => props.active,
  (active) => {
    if (active) {
      // REBUILD, not merely restart. Pausing tears the audio graph down, so
      // there is nothing left to read — and `start()` alone would early-return
      // on its own `frame !== null` guard if the loop were still alive,
      // leaving a ribbon that never moves again for the rest of the interview.
      if (props.stream !== null) {
        connect(props.stream)
        resize()
      }

      start()

      return
    }

    // Paused: tear the graph down rather than orphaning it.
    //
    // The first version nulled `analyser` and left the rAF loop running, on
    // the theory that `sample()`'s decay branch would settle the shape. It did
    // settle it — and then spun at 60fps for the whole pause, and made resume
    // a no-op, because `start()` returns early while a frame is pending. A
    // pause that keeps a render loop alive is the same class of defect as the
    // pause that kept the provider session alive.
    disconnect()

    // One last paint with the analyser gone: every column reads its floor, so
    // the ribbon comes to rest as the hairline rather than freezing mid-word.
    for (let i = 0; i < COLUMNS; i += 1) {
      levels[i] = 0
    }

    draw()
  }
)

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  disconnect()
})

watch(canvasEl, (canvas) => {
  observer?.disconnect()
  observer = null

  if (canvas === null) return

  resize()
  draw()

  if (typeof ResizeObserver === 'undefined') return

  observer = new ResizeObserver(() => {
    resize()
    draw()
  })
  observer.observe(canvas)
})
</script>
