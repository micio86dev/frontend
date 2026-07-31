import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright E2E configuration — 3 required browser projects per D14.
 *
 * Projects:
 *   chromium  — Desktop Chromium, full suite (all E2E specs)
 *   webkit    — Desktop Safari/WebKit, full suite (all E2E specs)
 *   mobile    — Mobile device viewport, SA-11 gate spec ONLY (asserts unsupported-experience)
 *
 * Firefox is intentionally excluded per NFR (product is desktop Chrome/Edge/Safari only).
 * E2E is a required, blocking tier and must run 100% green (D15).
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],

  // Screenshot visual-regression tolerance (absorbs sub-pixel font/AA rendering noise).
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },

  use: {
    // IPv4 explicitly: the Nitro node-server binds dual-stack but Playwright
    // resolves `localhost` to IPv4 first — use 127.0.0.1 to avoid IPv6 bind timeouts.
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      // SA-11 — mobile viewport: asserts the unsupported-experience gate ONLY.
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      testMatch: ['**/unsupported-gate.spec.ts'],
    },
  ],

  // Build the SSR app and serve the production output. Readiness is checked
  // against a real endpoint (/api/health); binding forced to IPv4 via HOST.
  webServer: {
    command: 'bun run build && node .output/server/index.mjs',
    url: 'http://127.0.0.1:3000/api/health',
    env: {
      HOST: '0.0.0.0',
      PORT: '3000',
      NITRO_PORT: '3000',
      // apiBase INCLUDES the /api suffix (AGENTS.md, .env.example, docker-compose.yml).
      // Left unset, apiBase would be '' and every candidate call would resolve to a
      // same-origin '/candidate/...' URL that the specs' '**/api/candidate/...' route
      // globs do not match — the E2E would exercise a URL shape no environment uses.
      NUXT_PUBLIC_API_BASE: 'http://127.0.0.1:3000/api',
      // C10 PR7: wires the W3-documented mock injection point (factory.ts) so E2E
      // specs can drive the interview state machine to `live`/`done` without a
      // real HeyGen/Tavus SDK connection. See app/providers/factory.ts and
      // tests/e2e/fixtures/interview-provider.ts.
      NUXT_PUBLIC_INTERVIEW_PROVIDER_MOCK: 'true',
      // C13 task 5.6: the consent banner only appears where there is something
      // to ask permission FOR, so E2E needs a measurement ID configured. It is
      // a fake one, and analytics-consent.spec.ts blocks the third-party hosts
      // at the network layer — a suite that phoned Google on every run would be
      // slow, flaky, and reporting CI traffic into a real property.
      NUXT_PUBLIC_GA_MEASUREMENT_ID: 'G-E2ETEST',
    },
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
  },
})
