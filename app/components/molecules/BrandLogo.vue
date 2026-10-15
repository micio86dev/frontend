<template>
  <!--
    The client's mark sits on a white plate, never straight on the canvas:
    the most common logo file there is, the brand colour on a transparent
    background, would vanish into a canvas of that same colour.

    `alt=""`: the organization name beside it is the accessible text, and
    repeating it would make a screen reader say the name twice. With no
    name it stays decoration on purpose (notice-shell.spec.ts): the
    candidate already knows whose assessment they are taking.

    The hairline edge is for the light logo on a light canvas: a yellow mark
    on a white plate on a yellow page had nothing to sit on.
  -->
  <span
    v-if="logoUrl"
    class="inline-flex shrink-0 items-center rounded-lg border border-border bg-card px-4 py-2.5 shadow-sm"
  >
    <img
      :src="logoUrl"
      alt=""
      data-testid="brand-canvas-logo"
      class="h-8 w-auto max-w-[10rem] object-contain"
    />
  </span>
  <!-- Ours when the organization configured none: never nothing (CLAUDE.md ruling 9). -->
  <p v-else class="text-lg leading-none font-semibold tracking-[0.3em]">BEAI</p>
</template>

<script setup lang="ts">
/**
 * BrandLogo — the organization's logo on its white plate, or the BEAI wordmark.
 *
 * The single drawing of the mark for every candidate screen (before the
 * interview, the live call and the end page), so it looks identical everywhere
 * (DESIGN.md §3.1 rule 5).
 */
defineProps<{
  /** The organization's logo URL, as `useCandidateBranding().logoUrl` exposes it. */
  logoUrl: string | null | undefined
}>()
</script>
