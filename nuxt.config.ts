// https://nuxt.com/docs/api/configuration/nuxt-config
import tailwindcss from '@tailwindcss/vite'

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
  modules: ['@nuxtjs/i18n'],
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
  },

  // Global CSS
  css: ['~/assets/css/main.css'],

  // App head — noindex for local/staging; production default allows normal robots
  app: {
    head: {
      htmlAttrs: { lang: 'it' },
    },
  },

  // Runtime config
  runtimeConfig: {
    public: {
      apiBase: '',
      appEnv: 'local',
      // Set NUXT_PUBLIC_INTERVIEW_PROVIDER_MOCK=true in E2E to inject the mock provider (D2, W3)
      interviewProviderMock: '',
    },
  },
})
