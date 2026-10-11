<template>
  <div data-slot="call-tile" :data-speaking="speaking ? 'true' : 'false'" :class="TILE_CLASSES">
    <slot />

    <!--
      The name chip. When the tile is lit it adds two cues that are not colour:
      the microphone glyph and visually hidden text. The hidden text is
      deliberately NOT a live region: announcing every turn would bury the
      question, the same argument DESIGN.md §7.3.1 makes for the voice
      visualizer. A screen reader finds it by exploring the tile.
    -->
    <div
      data-slot="call-tile-name"
      class="absolute bottom-2 left-2 inline-flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-md bg-avatar-bg/80 px-2 py-1 text-xs font-medium text-white"
    >
      <!-- Inline rather than an icon package, as NoticeShell does (D37). -->
      <svg
        v-if="speaking"
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="size-3.5 shrink-0"
      >
        <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
        <path
          d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V20H8.5a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H13v-2.08A7 7 0 0 0 19 11Z"
        />
      </svg>
      <span class="truncate">{{ name }}</span>
      <span v-if="speaking" class="sr-only">{{ speakingLabel }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * CallTile — the frame of one tile on the call screen: a dark surface that
 * holds the media (the slot), a name chip, and the speaking ring
 * (DESIGN.md §3.5, §7.3; change `candidate-interview-call-ui`, D5).
 *
 * Presentational only. It owns no signal and no copy: the parent decides who
 * is speaking and passes the already-localized `name` and `speakingLabel`.
 *
 * The ring is a box-shadow composite, outside in: 2px avatar-bg, 3px white,
 * 2px avatar-bg, then a decorative 32px white halo at 30%. The white band
 * sits between two dark bands, so its contrast does not depend on the brand
 * colour or the video behind it; no brand token appears here on purpose.
 * Resting, the tile keeps only the 2px dark frame.
 *
 * Motion: a 150ms box-shadow transition under `motion-safe` only (DESIGN.md
 * §10), so `prefers-reduced-motion: reduce` switches the ring instantly. It is
 * state, not animation: nothing here pulses or loops. In forced-colours mode
 * the shadows are dropped, and `main.css` swaps the ring for a Highlight
 * outline.
 */
withDefaults(
  defineProps<{
    /** Already-localized name shown on the chip. */
    name: string
    /** Already-localized text for screen readers, rendered only while speaking. */
    speakingLabel: string
    /** Whether this tile's party is speaking; lights the ring. */
    speaking?: boolean
  }>(),
  { speaking: false }
)

const TILE_CLASSES = [
  'relative overflow-hidden rounded-surface bg-avatar-bg',
  'shadow-[0_0_0_2px_var(--color-avatar-bg)]',
  'data-[speaking=true]:shadow-[0_0_0_2px_var(--color-avatar-bg),0_0_0_5px_var(--color-speaking-ring),0_0_0_7px_var(--color-avatar-bg),0_0_32px_rgb(255_255_255/0.3)]',
  'motion-safe:transition-shadow motion-safe:duration-150 motion-safe:ease-out',
]
</script>
