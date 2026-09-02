// https://nuxt.com/docs/api/configuration/nuxt-config
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  // Nuxt 4 SSR (default; Nitro node-server preset for production)
  nitro: {
    preset: 'node-server',
    routeRules: {
      '/**': {
        headers: {
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        },
      },
      // Per-route override for the interview flow (D6 — Nitro REPLACES headers, never merges).
      // All four security headers must be restated explicitly; omitting any drops it silently.
      // Covers the default locale (no prefix, strategy: prefix_except_default) and the English
      // non-default locale prefix. Add a new entry for each additional locale (es/fr/de/pt).
      '/interview/**': {
        headers: {
          'Permissions-Policy': 'camera=(self) microphone=(self) geolocation=()',
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
      },
      '/en/interview/**': {
        headers: {
          'Permissions-Policy': 'camera=(self) microphone=(self) geolocation=()',
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
      },
    },
  },

  // i18n
  modules: ['@nuxtjs/i18n', '@sentry/nuxt/module'],

  // Sentry — application error monitoring (C13, task 5.1, Nuxt half).
  // Source-map upload is OFF unless a SENTRY_AUTH_TOKEN is present in the
  // deploy environment: an unattended `enabled: true` default would make
  // every local `nuxt build` attempt an authenticated network call it has no
  // credentials for. `sentry.client.config.ts` / `sentry.server.config.ts`
  // hold the actual DSN/PII/scrubbing posture.
  sentry: {
    sourceMapsUploadOptions: {
      enabled: Boolean(process.env['SENTRY_AUTH_TOKEN']),
      org: process.env['SENTRY_ORG'],
      project: process.env['SENTRY_PROJECT'],
      authToken: process.env['SENTRY_AUTH_TOKEN'],
    },
  },
  i18n: {
    defaultLocale: 'it',
    strategy: 'prefix_except_default',
    lazy: true,
    langDir: 'locales/',
    locales: [
      { code: 'it', file: 'it.json' },
      { code: 'en', file: 'en.json' },
    ],
  },

  // Tailwind CSS v4 via Vite plugin
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: [
        // `~/app/` shim: PRs 1-4 authored imports as `~/app/utils/...` with ~ = project root.
        // In Nuxt 4, `~` = app/ (srcDir), so ~/app/ would resolve to app/app/ (wrong).
        // This alias MUST come before the built-in `~` entry so Vite matches the longer
        // prefix first and routes ~/app/foo → <projectRoot>/app/foo.
        { find: /^~\/app\/(.*)$/, replacement: `${resolve(__dirname, 'app')}/$1` },
        // Same for @/app/ (less common but consistent)
        { find: /^@\/app\/(.*)$/, replacement: `${resolve(__dirname, 'app')}/$1` },
      ],
    },
  },

  // Global CSS
  css: ['~/assets/css/main.css'],

  // App head — noindex for local/staging; production default allows normal robots
  app: {
    head: {
      htmlAttrs: { lang: 'it' },
    },
  },

  // Alias: remap ~/app → project root's app/ directory.
  // Composables/providers use `~/app/` paths authored with Vitest's alias (~ = project root).
  // In Nuxt 4 build, `~` = srcDir (app/), so `~/app/` → app/app/ (wrong).
  // Adding this alias fixes the build without changing 20+ import statements.
  alias: {
    '~/app': resolve(__dirname, 'app'),
  },

  // Runtime config
  runtimeConfig: {
    /**
     * SERVER-ONLY, and deliberately not under `public`: this is the origin the
     * Nitro proxy in `server/routes/api/[...].ts` forwards to, and it is a
     * Docker-internal hostname. Shipping it to the browser is precisely the
     * bug that proxy removes.
     *
     * Fed by NUXT_API_ORIGIN. The name is not a preference: Nuxt maps only
     * `NUXT_`-prefixed environment variables onto runtimeConfig at runtime,
     * so any other name is simply never read and this stays ''. This comment
     * said BEAI_API_ORIGIN, and so did the proxy's own 500 message — an
     * operator hitting that error on Railway would have set the variable it
     * named, got the same 500, and had nothing to go on.
     */
    apiOrigin: '',

    public: {
      // NUXT_PUBLIC_API_BASE. The value INCLUDES the /api suffix (e.g.
      // http://api:8000/api) — see app/utils/api-url.ts. Left empty here so a missing
      // env var fails loudly against a same-origin URL instead of silently pointing
      // somewhere plausible.
      apiBase: '',
      appEnv: 'local',
      // Set NUXT_PUBLIC_INTERVIEW_PROVIDER_MOCK=true in E2E to inject the mock provider (D2, W3)
      interviewProviderMock: '',
      // C13 task 5.3 — analytics. EMPTY means the tool does not load at all,
      // which is the correct default: these are per-deployment IDs, and a
      // committed one would have every developer's local session reported into
      // a production property. Consent gates them independently
      // (app/utils/analytics-consent.ts) and defaults to denied.
      gaMeasurementId: '',
      clarityProjectId: '',
      // C13 task 5.1 — Sentry. EMPTY means the SDK never initializes
      // (app/utils/sentry-init.ts's `enabled` gate), the same "unset ID"
      // posture as Clarity/GA4 above. Unlike those two, Sentry is NOT
      // additionally gated on analytics consent — see
      // sentry.client.config.ts for why.
      sentryDsn: '',
    },
  },
})
