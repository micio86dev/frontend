<template>
  <InterviewSession />
</template>

<script setup lang="ts">
/**
 * Interview session page — ssr:false container (D1, D-A).
 *
 * The interview UI itself, moved verbatim from `[token].vue` (candidate-session-auth
 * D-A): `[token].vue` is now the entry route that exchanges the sso-link token
 * exactly once and `replace`-redirects here. This route carries NO token in its
 * URL — a refresh or Back navigation lands here safely, by construction, never
 * re-triggering the exchange.
 *
 * public-api step 10 — the interview UI itself (consent → device-check → live
 * loop → end_of_question/pause → done/error/terminal, provider wiring,
 * proctoring, exit redirect, the tab-hidden and network-drop guards) was
 * extracted VERBATIM into `~/components/InterviewSession.vue` (SPEC §4.4:
 * "Reuses the hosted page component. Hosted mode differs only in chrome"), so
 * `app/pages/embed/[token].vue` can render the identical UI after its own
 * token exchange. This page keeps only what genuinely differs per route: the
 * `ssr: false` / `candidate-session` middleware page meta below, which
 * `definePageMeta` can only be called from inside `app/pages/`.
 *
 * Route gate: `app/middleware/candidate-session.ts` runs before this page
 * mounts and `replace`-redirects to the expired-session terminal when no
 * valid stored candidate session exists — this page never renders without one.
 *
 * noindex: this route is session-gated and must never be indexed (also set,
 * redundantly-but-harmlessly, by `InterviewSession.vue`'s own `useHead` call —
 * kept there rather than here since both hosted and embed modes want the
 * identical title/meta).
 */
import InterviewSession from '~/components/InterviewSession.vue'

definePageMeta({ ssr: false, middleware: ['candidate-session'] })
</script>
