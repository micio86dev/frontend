<template>
  <BrandCanvas :test-id="testId" :heading-id="headingId" busy :load-branding="false">
    <!--
      The entry routes spend a moment exchanging a token before they redirect.
      A bare grey skeleton there promised content that never arrives; this
      says what is happening, in the candidate's language, on the client's own
      canvas, so the first thing a candidate sees already looks like the
      company that invited them.
    -->
    <h1
      :id="headingId"
      class="text-2xl leading-[1.25] font-semibold tracking-[-0.01em] text-card-foreground"
    >
      {{ title ?? $t('shell.loading.title') }}
    </h1>
    <p class="mt-3 text-base leading-7 text-muted-foreground">{{ $t('shell.loading.body') }}</p>

    <!--
      Indeterminate, so no progressbar role and no value: a number would be
      invented. The aria-busy landmark is the state for assistive tech.
    -->
    <div aria-hidden="true" class="mt-8 h-1 overflow-hidden rounded-full bg-primary-surface">
      <div class="canvas-loading__bar h-full w-1/3 rounded-full bg-primary-ink" />
    </div>
  </BrandCanvas>
</template>

<script setup lang="ts">
/**
 * CanvasLoading — the in-flight state of the candidate entry routes
 * (`/i/{token}`, `/interview/{token}`, `/embed/{token}`, the reusable entry).
 */
import BrandCanvas from '~/components/organisms/BrandCanvas.vue'

withDefaults(
  defineProps<{
    testId?: string
    headingId?: string
    /** Overrides the generic "Opening your interview" heading. */
    title?: string
  }>(),
  { testId: 'canvas-loading', headingId: 'canvas-loading-heading', title: undefined }
)
</script>

<style scoped>
/*
 * Three sweeps (4.2 s), then the still third of the track that reduced motion
 * shows from the start: DESIGN.md §10 allows no animation to autoplay past
 * 5 s, and an exchange that slow is already on its way to an error screen.
 */
@media (prefers-reduced-motion: no-preference) {
  .canvas-loading__bar {
    animation: canvas-loading-slide 1.4s cubic-bezier(0.65, 0, 0.35, 1) 3;
  }
}

@keyframes canvas-loading-slide {
  from {
    transform: translateX(-100%);
  }

  to {
    transform: translateX(300%);
  }
}
</style>
