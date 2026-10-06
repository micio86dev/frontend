<template>
  <BrandCanvas :test-id="testId" :heading-id="headingId">
    <!--
      The brand colour IS the page now (DESIGN.md §7.0): the canvas, the logo
      lockup and the footer belong to `BrandCanvas`, and this molecule only fills
      its elevated surface. The old solid primary band beside a white column is
      gone because the whole page carries the client's colour.
    -->
    <span
      aria-hidden="true"
      :class="['flex size-11 shrink-0 items-center justify-center rounded-xl', TONE_CHIP[tone]]"
    >
      <!-- Inline rather than an icon package: adding a dependency to ship
           four glyphs would breach the pinned-dependency policy (D37). -->
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="size-5"
      >
        <template v-if="tone === 'success'">
          <path d="M20 6 9 17l-5-5" />
        </template>
        <template v-else-if="tone === 'warning'">
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        </template>
        <template v-else-if="tone === 'danger'">
          <circle cx="12" cy="12" r="9" />
          <path d="m15 9-6 6" />
          <path d="m9 9 6 6" />
        </template>
        <template v-else>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5" />
          <path d="M12 8h.01" />
        </template>
      </svg>
    </span>

    <h1
      :id="headingId"
      class="mt-6 text-3xl leading-[1.2] font-semibold tracking-[-0.01em] text-balance text-card-foreground"
    >
      {{ title }}
    </h1>
    <p class="mt-3 max-w-[58ch] text-base leading-7 text-muted-foreground">{{ message }}</p>

    <!-- The route's one action, when it has one. -->
    <div v-if="$slots.default" class="mt-8">
      <slot />
    </div>
  </BrandCanvas>
</template>

<script setup lang="ts">
import BrandCanvas from '~/components/organisms/BrandCanvas.vue'

/**
 * Shared notice for the standalone, non-interview routes: the root landing,
 * the unsupported-device gate, the interview done / error screens, the
 * terminal reasons and the reusable entry states. Branding (the fetch, the
 * logo, the organization name) is `BrandCanvas`'s job.
 *
 * They exist for four different reasons but share one job — tell a candidate,
 * in one glance, what happened and what to do next — so they get one visual
 * system rather than four independently-invented layouts. `tone` is the only
 * thing that varies, and it varies in exactly one place: the icon chip.
 *
 * The landmark is `BrandCanvas`'s bare `<main>`, labelled by this `<h1>`.
 */
type Tone = 'info' | 'success' | 'warning' | 'danger'

withDefaults(
  defineProps<{
    /** Rendered as the page's <h1>; also the landmark's accessible name. */
    title: string
    message: string
    headingId: string
    testId: string
    tone?: Tone
  }>(),
  { tone: 'info' }
)

// Semantic tokens, not raw palette values: `--color-success-dark` /
// `--color-warning-dark` are the text-and-icon-safe pair from DESIGN.md §9.1,
// where the plain `--color-success` / `--color-warning` are fill-only.
// `info` is a solid brand fill with the derived on-primary glyph, which reads
// on any client colour; `bg-primary/10 text-primary` vanished on a light one.
const TONE_CHIP: Record<Tone, string> = {
  info: 'bg-primary text-on-primary',
  success: 'bg-success-light text-success-dark',
  warning: 'bg-warning-light text-warning-dark',
  danger: 'bg-error-light text-destructive',
}
</script>
