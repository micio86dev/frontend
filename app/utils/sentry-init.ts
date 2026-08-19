/**
 * The posture-defining half of the Sentry init options (C13, task 5.1 —
 * Nuxt half): what turns the SDK on, and what is pinned regardless of env.
 *
 * Extracted into a pure function — rather than left inline in
 * `sentry.client.config.ts` / `sentry.server.config.ts` — so "does an empty
 * DSN actually turn Sentry off" and "is PII pinned off no matter what" are
 * one-line assertions in a unit test, not something inferred from reading a
 * Nuxt plugin file and trusting it.
 */
export interface SentryPosture {
  dsn: string
  enabled: boolean
  environment: string
  sendDefaultPii: false
}

export function sentryPosture(dsn: string, environment: string): SentryPosture {
  return {
    dsn,
    // OFF by default via an EMPTY DSN — a per-deployment credential that is
    // never committed (mirrors api/config/sentry.php and the Clarity/GA4 IDs
    // in this file's runtimeConfig). `enabled` makes that inertness the
    // SDK's own decision rather than trusting that `Sentry.init({ dsn: '' })`
    // silently no-ops — the same discipline as the api's `sentry.dsn` test.
    //
    // NOT additionally gated on analytics consent (`beai.consent.analytics`)
    // — see sentry.client.config.ts for why that would cost more than it
    // protects here.
    enabled: dsn !== '',
    environment,
    // Pinned false, not read from env: this app's own exceptions can carry a
    // candidate JWT, a transcript, or an SSO exchange token in scope, and
    // PII here is not a preference any deployment gets to flip back on.
    sendDefaultPii: false,
  }
}
