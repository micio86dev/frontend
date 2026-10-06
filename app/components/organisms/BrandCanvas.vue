<template>
  <div
    class="brand-canvas relative isolate flex min-h-screen flex-col overflow-hidden bg-primary text-on-primary"
  >
    <!--
      The candidate flow's page (DESIGN.md §7.0.1): the CLIENT's primary colour is
      the canvas, and everything drawn straight on it uses the on-primary tokens,
      which `applyBrandColor()` derives so they read on any colour an operator
      picks. Content never sits on the bare canvas: it sits on the one elevated
      white surface below, where the ordinary card tokens keep their measured
      contrast whatever the brand is.
    -->
    <!--
      ONE decorative layer, CSS only. It paints with `--color-canvas-tone`
      alone, a shade of the primary moved away from on-primary, so it can deepen
      or lift the canvas without ever lowering the contrast of the text on it.
    -->
    <div
      data-slot="brand-canvas-decor"
      aria-hidden="true"
      class="brand-canvas__decor pointer-events-none absolute inset-0 -z-10"
    />

    <header class="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 pt-6 lg:px-10 lg:pt-8">
      <!--
        The client's mark sits on a white plate, never straight on the canvas:
        the most common logo file there is, the brand colour on a transparent
        background, would vanish into a canvas of that same colour.

        `alt=""`: the organization name beside it is the accessible text, and
        repeating it would make a screen reader say the name twice.
      -->
      <span
        v-if="logoUrl"
        class="inline-flex shrink-0 items-center rounded-lg bg-card px-4 py-2.5 shadow-sm"
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

      <template v-if="organizationName">
        <span aria-hidden="true" class="h-6 w-px shrink-0 bg-current opacity-40" />
        <p data-testid="brand-canvas-org" class="text-sm leading-tight font-semibold">
          {{ organizationName }}
        </p>
      </template>
    </header>

    <main
      :data-testid="testId"
      :aria-labelledby="headingId"
      :aria-busy="busy ? 'true' : undefined"
      :aria-live="busy ? 'polite' : undefined"
      class="flex flex-1 items-center justify-center px-4 py-10 lg:px-10 lg:py-14"
    >
      <div
        data-slot="brand-canvas-surface"
        class="brand-canvas__surface w-full max-w-[34rem] rounded-surface bg-card p-6 text-card-foreground shadow-surface lg:p-10"
      >
        <slot />
      </div>
    </main>

    <footer
      class="mx-auto w-full max-w-6xl px-4 pb-6 text-sm text-on-primary-muted lg:px-10 lg:pb-8"
    >
      {{ $t('shell.tagline') }}
    </footer>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useCandidateBranding } from '~/app/composables/useCandidateBranding'

/**
 * BrandCanvas — the shell of every candidate page outside the live interview.
 *
 * It owns the branding fetch: several of these routes are reached in states
 * where nothing else has read the session (`terminal` is rendered by a guard
 * before any page bootstraps), and `ensureLoaded` is a no-op once primed, so a
 * page that already fetched the session costs no extra request.
 *
 * The landmark is a bare `<main>` (implicit `role="main"`), carrying the
 * route's test id and its heading link, so route specs keep locating the page
 * by element and the heading stays the landmark's accessible name.
 */
const props = withDefaults(
  defineProps<{
    /** Rendered on the `<main>` landmark. */
    testId: string
    /** Id of the `<h1>` inside the slot: the landmark's accessible name. */
    headingId?: string
    /** A redirect or a request is in flight: the landmark is `aria-busy`. */
    busy?: boolean
    /**
     * Read the branding if nobody has yet. Off for the entry routes' loading
     * state: there is no candidate session before the token exchange, so the
     * read could only fail, and a failed read is a SETTLED answer
     * (`ensureLoaded` primes "no branding"), which would leave every later page
     * of the interview unbranded. Those states render in whatever was already
     * primed, or in the Quint default.
     */
    loadBranding?: boolean
  }>(),
  { headingId: undefined, busy: false, loadBranding: true }
)

const { logoUrl, organizationName, ensureLoaded } = useCandidateBranding()

onMounted(() => {
  if (props.loadBranding) void ensureLoaded()
})
</script>

<style scoped>
/*
 * Two soft pools of the canvas tone from opposite corners. Sizes are fixed rem,
 * not percentages, so the composition does not stretch on a wide screen, and
 * nothing here is an image, a filter or a blur: it costs one paint.
 */
.brand-canvas__decor {
  background-image:
    radial-gradient(60rem 38rem at 0% 0%, var(--color-canvas-tone), transparent 70%),
    radial-gradient(52rem 34rem at 100% 100%, var(--color-canvas-tone), transparent 72%);
  opacity: 0.6;
}

/* DESIGN.md §10: entrance only, once, opacity and transform only. */
@media (prefers-reduced-motion: no-preference) {
  .brand-canvas__surface {
    animation: brand-canvas-rise 280ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
}

@keyframes brand-canvas-rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}
</style>
