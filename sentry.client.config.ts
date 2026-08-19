import * as Sentry from '@sentry/nuxt'
import { sentryPosture } from './app/utils/sentry-init'
import {
  scrubBreadcrumb,
  scrubSentryEvent,
  type ScrubbableBreadcrumb,
  type ScrubbableEvent,
} from './app/utils/sentry-scrub'

/**
 * Sentry — client-side (C13, task 5.1, Nuxt half).
 *
 * `@sentry/nuxt/module` loads this file automatically as a client plugin; it
 * runs inside a `defineNuxtPlugin` wrapper the module supplies, which is why
 * `useRuntimeConfig()` is available here even though this is not itself a
 * `~/plugins/*.client.ts` file.
 *
 * Every decision about WHAT may be sent lives in `app/utils/sentry-init.ts`
 * and `app/utils/sentry-scrub.ts`, both unit-tested in isolation. This file
 * is wiring only — the same split this codebase already uses for
 * Clarity/GA4 (`app/utils/analytics.ts` decides, `app/plugins/analytics.client.ts`
 * injects).
 *
 * Consent: Sentry is NOT gated on `beai.consent.analytics`, unlike Clarity
 * and GA4. Error monitoring and behavioral/marketing analytics are different
 * things — the spec's own Tool Responsibility Boundaries table treats them
 * as separate tools with separate purposes, and this codebase's api
 * integration (`api/config/sentry.php`) is not consent-gated either. Gating
 * crash reporting on a cookie-banner answer would blind the team to failures
 * on exactly the highest-stakes path — the interview — for every candidate
 * who has not opted into marketing analytics, which in practice is most of
 * them, in exchange for a privacy benefit the scrubber below already
 * provides without it: no candidate-identifying or candidate-authored
 * content, and no persistent user identifier, ever reaches Sentry.
 *
 * Session Replay is deliberately NOT enabled. `spec.md`'s Tool
 * Responsibility Boundaries make Microsoft Clarity the SOLE session-recording
 * tool; a second DOM recorder here would violate that boundary directly, and
 * would record exactly the interview screen Clarity is already forbidden
 * from touching (`app/utils/analytics-path.ts`).
 */

const config = useRuntimeConfig()
const posture = sentryPosture(
  String(config.public.sentryDsn ?? ''),
  String(config.public.appEnv ?? 'local')
)

Sentry.init({
  ...posture,
  beforeSend: (event) =>
    scrubSentryEvent(event as unknown as ScrubbableEvent) as unknown as typeof event,
  beforeBreadcrumb: (breadcrumb) =>
    scrubBreadcrumb(breadcrumb as unknown as ScrubbableBreadcrumb) as unknown as typeof breadcrumb,
})
