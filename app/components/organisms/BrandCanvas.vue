<template>
  <div
    class="brand-canvas relative isolate flex min-h-screen flex-col overflow-hidden bg-canvas text-on-canvas"
  >
    <!--
      The candidate flow's page (DESIGN.md §7.0.1): the CLIENT's background colour
      is the canvas (dark `#0f172a` when unset), and everything drawn straight on
      it uses the on-canvas tokens, which `applyBrandCanvas()` derives so they
      read on any colour an operator picks. Content never sits on the bare canvas: it sits on the one elevated
      white surface below, where the ordinary card tokens keep their measured
      contrast whatever the brand is.
    -->
    <!--
      ONE decorative layer, CSS only. It paints with `--color-canvas-tone`
      alone, a shade of the background moved away from on-canvas, so it can deepen
      or lift the canvas without ever lowering the contrast of the text on it.
    -->
    <div
      data-slot="brand-canvas-decor"
      aria-hidden="true"
      class="brand-canvas__decor pointer-events-none absolute inset-0 -z-10"
    />

    <header
      :class="`mx-auto flex w-full ${wide ? 'max-w-[96rem]' : 'max-w-6xl'} items-center gap-4 px-4 pt-6 lg:px-10`"
    >
      <BrandLogo :logo-url="logoUrl" />

      <template v-if="organizationName">
        <span aria-hidden="true" class="h-6 w-px shrink-0 bg-current opacity-40" />
        <p data-testid="brand-canvas-org" class="text-sm leading-tight font-semibold">
          {{ organizationName }}
        </p>
      </template>

      <!-- Where-am-I chrome (the interview's steps, progress and timer). -->
      <div
        v-if="$slots['header-end']"
        class="ml-auto flex min-w-0 flex-1 items-center justify-end gap-3"
      >
        <slot name="header-end" />
      </div>
    </header>

    <main
      :data-testid="testId"
      :aria-labelledby="headingId"
      :aria-label="headingId ? undefined : ariaLabel"
      :aria-busy="busy ? 'true' : undefined"
      :aria-live="busy ? 'polite' : undefined"
      :class="[
        'flex flex-1 items-center justify-center px-4 py-8 lg:px-10',
        surface ? 'lg:py-10' : 'flex-col gap-5 lg:py-8',
        wide && 'mx-auto w-full max-w-[96rem]',
      ]"
    >
      <div
        v-if="surface"
        data-slot="brand-canvas-surface"
        class="brand-canvas__surface w-full max-w-[34rem] rounded-surface bg-card p-6 text-card-foreground shadow-surface lg:p-9"
      >
        <slot />
      </div>
      <!-- Bare: the interview renders its own surfaces, one per state. -->
      <slot v-else />
    </main>

    <footer
      v-if="footer"
      class="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 pb-6 text-sm text-on-canvas-muted lg:px-10"
    >
      <span>{{ $t('shell.tagline') }}</span>
      <a
        v-if="privacyPolicyUrl"
        :href="privacyPolicyUrl"
        target="_blank"
        rel="noopener noreferrer"
        data-testid="privacy-policy-link"
        class="text-on-canvas underline underline-offset-4"
      >
        {{ $t('shell.privacyPolicy') }}
      </a>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import BrandLogo from '~/components/molecules/BrandLogo.vue'
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
    /**
     * Wrap the slot in the one elevated surface. Off for the interview, which
     * renders a surface per state around the avatar panel and so brings its
     * own (the slot is then stacked straight in the landmark).
     */
    surface?: boolean
    /** The tagline footer. Off during the live interview, where it is noise. */
    footer?: boolean
    /**
     * Landmark name when there is no single `<h1>` to point at. Ignored when a
     * `headingId` is given: `aria-labelledby` would win over it anyway, so only
     * one naming mechanism is ever rendered.
     */
    ariaLabel?: string
    /**
     * Widen the header and the main column to `max-w-[96rem]` (DESIGN.md
     * §7.0.1). Only the live call screen opts in; without it the classes are
     * exactly what they have always been.
     */
    wide?: boolean
  }>(),
  {
    headingId: undefined,
    busy: false,
    loadBranding: true,
    surface: true,
    footer: true,
    ariaLabel: undefined,
    wide: false,
  }
)

const { logoUrl, organizationName, ensureLoaded } = useCandidateBranding()

/**
 * The privacy policy document (env NUXT_PUBLIC_PRIVACY_POLICY_URL). It ends up in
 * an `href`, so only an absolute `https:` URL is linked; anything else renders no link.
 */
const privacyPolicyUrl = computed((): string | null => {
  const configured = (useRuntimeConfig().public as Record<string, unknown>).privacyPolicyUrl
  if (typeof configured !== 'string') return null

  try {
    const url = new URL(configured.trim())

    return url.protocol === 'https:' && url.hostname !== '' ? url.href : null
  } catch {
    return null
  }
})

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

/*
 * The analytics consent banner floats over the bottom of the canvas and
 * publishes its height while it is open (ConsentBanner.vue); reserving it here
 * keeps the footer readable above the banner instead of underneath it.
 *
 * The surface entrance lives in main.css: the interview's own surfaces enter
 * the same way, and they are not this component's elements.
 */
.brand-canvas {
  padding-bottom: var(--consent-banner-clearance, 0px);
}
</style>
