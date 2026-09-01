<template>
  <div class="grid min-h-screen grid-cols-1 bg-background lg:grid-cols-[24rem_1fr]">
    <!--
      Brand band. Solid `--color-primary` rather than a card floating on a white
      page: these four routes are the only BEAI surface most candidates ever
      see, and an unbranded centred box reads as a broken deployment at the
      exact moment the person is deciding whether this service is trustworthy.
    -->
    <!--
      One vertical lockup, centred — NOT wordmark-top / tagline-bottom. Pushing
      them to opposite ends of a full-height column leaves ~700px of empty
      purple between them at 1440x900, which reads as an unfinished page rather
      than as deliberate space. Kept together they are a single confident mark.
    -->
    <aside
      class="relative flex flex-col justify-center gap-5 overflow-hidden bg-primary px-8 py-12 text-primary-foreground lg:px-10"
    >
      <div
        aria-hidden="true"
        class="pointer-events-none absolute -top-28 -left-20 size-80 rounded-full bg-primary-light/30 blur-3xl"
      />
      <div
        aria-hidden="true"
        class="pointer-events-none absolute -right-28 -bottom-32 size-96 rounded-full bg-accent/25 blur-3xl"
      />

      <!--
        The organization's mark when it has one, ours when it does not. Never
        NOTHING: an organization that configured no logo still gets a branded
        page, because these four routes are the only BEAI surface most
        candidates ever see and a blank band reads as a broken deployment at
        the exact moment the person is deciding whether to trust the service
        (CLAUDE.md ruling 9).

        `alt=""` and `aria-hidden`: the logo is decoration beside the tagline
        that follows, and announcing an organization's name to a candidate who
        already knows whose assessment they are taking adds noise, not meaning.
      -->
      <img
        v-if="logoUrl"
        :src="logoUrl"
        alt=""
        aria-hidden="true"
        data-testid="notice-shell-logo"
        class="relative max-h-12 w-auto max-w-[12rem] object-contain object-left"
      />
      <p v-else class="relative text-2xl leading-none font-semibold tracking-[0.3em]">BEAI</p>
      <!-- A hairline, not a gap: it ties the two lines into one lockup and
           gives the eye a reason to travel from the mark to the sentence. -->
      <span aria-hidden="true" class="relative h-px w-12 bg-primary-foreground/40" />
      <p class="relative max-w-[26ch] text-sm leading-6 text-primary-foreground/80">
        {{ $t('shell.tagline') }}
      </p>
    </aside>

    <main
      :aria-labelledby="headingId"
      :data-testid="testId"
      class="flex items-center px-8 py-16 lg:px-20"
    >
      <div class="flex w-full max-w-2xl flex-col gap-8">
        <span
          aria-hidden="true"
          :class="['flex size-12 shrink-0 items-center justify-center rounded-xl', TONE_CHIP[tone]]"
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
            class="size-6"
          >
            <template v-if="tone === 'success'">
              <path d="M20 6 9 17l-5-5" />
            </template>
            <template v-else-if="tone === 'warning'">
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path
                d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
              />
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

        <div class="flex flex-col gap-4">
          <h1
            :id="headingId"
            class="text-3xl leading-tight font-semibold tracking-tight text-balance text-foreground lg:text-4xl"
          >
            {{ title }}
          </h1>
          <p class="max-w-[58ch] text-base leading-7 text-muted-foreground">{{ message }}</p>
        </div>

        <slot />
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useCandidateBranding } from '~/app/composables/useCandidateBranding'

/**
 * These four routes are reached in states where nothing else has fetched the
 * session — `terminal` in particular is rendered by a guard before any page
 * bootstraps — so the shell asks for branding itself. `ensureLoaded` is a
 * no-op once primed, so the common path (a page that already fetched the
 * session) costs no extra request.
 */
const { logoUrl, ensureLoaded } = useCandidateBranding()

onMounted(() => {
  void ensureLoaded()
})
/**
 * Shared shell for the four standalone, non-interview routes: the root landing,
 * the unsupported-device gate, and the interview done / error screens.
 *
 * They exist for four different reasons but share one job — tell a candidate,
 * in one glance, what happened and what to do next — so they get one visual
 * system rather than four independently-invented layouts. `tone` is the only
 * thing that varies, and it varies in exactly one place: the icon chip.
 *
 * The landmark is a bare `<main>`: it already carries `role="main"` implicitly,
 * and restating it trips `vuejs-accessibility/no-redundant-roles`. Route specs
 * locate it by element, not by attribute.
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
const TONE_CHIP: Record<Tone, string> = {
  info: 'bg-primary/10 text-primary',
  success: 'bg-success-light text-success-dark',
  warning: 'bg-warning-light text-warning-dark',
  danger: 'bg-error-light text-destructive',
}
</script>
