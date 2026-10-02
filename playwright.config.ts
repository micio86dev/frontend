import { defineConfig, devices } from '@playwright/test'
import { DEFAULT_STACK_URL } from './tests/e2e/support/stack-origin'

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

/**
 * Opt-in REAL-STACK tier (`BEAI_E2E_STACK=1`, script `test:e2e:stack`).
 *
 * Runs `tests/e2e/stack/**` against the developer's live local stack (candidate
 * app, api, database) with NO `page.route` on /api: the mocked suites cannot see a
 * real api that is broken (the 2026-10-02 incident, a schema behind the code).
 * A stack run replaces the whole project list and starts no web server, so the
 * default tier (CI) is byte-for-byte what it was; the default projects in turn
 * ignore `tests/e2e/stack/**`.
 */
const STACK = process.env['BEAI_E2E_STACK'] === '1'
const STACK_URL = process.env['BEAI_E2E_STACK_URL'] ?? DEFAULT_STACK_URL
const STACK_SPECS = ['stack/**/*.stack.spec.ts']

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: !STACK,
  forbidOnly: !!process.env['CI'],
  retries: STACK ? 0 : process.env['CI'] ? 2 : 0,
  // A test that fails and then passes on a retry is NOT green. Retries exist to
  // keep one infrastructure hiccup from hiding a real signal in the report, and
  // without this a flaky test exits 0 and is never looked at again. With it the
  // run fails and the HTML report still shows which test and which attempt.
  failOnFlakyTests: true,
  workers: STACK || process.env['CI'] ? 1 : undefined,
  globalSetup: STACK ? './tests/e2e/support/stack-global-setup.ts' : undefined,
  reporter: [['html', { open: 'never' }], ['list']],

  // Screenshot visual-regression tolerance (absorbs sub-pixel font/AA rendering noise).
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },

  use: {
    // IPv4 explicitly: the Nitro node-server binds dual-stack but Playwright
    // resolves `localhost` to IPv4 first — use 127.0.0.1 to avoid IPv6 bind timeouts.
    baseURL: STACK ? STACK_URL : 'http://127.0.0.1:4174',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: STACK
    ? [
        { name: 'stack-chromium', use: { ...devices['Desktop Chrome'] }, testMatch: STACK_SPECS },
        { name: 'stack-webkit', use: { ...devices['Desktop Safari'] }, testMatch: STACK_SPECS },
      ]
    : [
        {
          name: 'chromium',
          use: { ...devices['Desktop Chrome'] },
          testIgnore: ['stack/**'],
        },
        {
          name: 'webkit',
          use: { ...devices['Desktop Safari'] },
          testIgnore: ['stack/**'],
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
  webServer: STACK
    ? undefined
    : [
        {
          // Stand-in api for the CSP middleware's frame-policy lookup (embed.spec.ts).
          command: 'node tests/e2e/fixtures/frame-policy-stub.mjs',
          url: 'http://127.0.0.1:4175/api/health',
          reuseExistingServer: !process.env['CI'],
          timeout: 30_000,
        },
        {
          command: 'bun run build && node .output/server/index.mjs',
          // 4174, NOT 3000, and the port is the whole point.
          //
          // `reuseExistingServer` is true locally, and the local docker stack
          // publishes this app on 3000. So running the E2E while `./dev.sh` was up
          // handed the whole suite to the CONTAINER: a server built from a different
          // checkout, with none of the env below — no mock provider, no measurement
          // ID, an apiBase pointing somewhere else. 39 specs failed, every one of
          // them correctly, against an app they were never meant to be testing.
          //
          // Nothing in the output says which server answered, which is what made it
          // cost an afternoon. The backoffice suite has always used its own 4173 and
          // never had the problem; this is the same fix.
          url: 'http://127.0.0.1:4174/api/health',
          env: {
            HOST: '0.0.0.0',
            PORT: '4174',
            NITRO_PORT: '4174',
            // apiBase INCLUDES the /api suffix (AGENTS.md, .env.example, docker-compose.yml).
            // Left unset, apiBase would be '' and every candidate call would resolve to a
            // same-origin '/candidate/...' URL that the specs' '**/api/candidate/...' route
            // globs do not match — the E2E would exercise a URL shape no environment uses.
            NUXT_PUBLIC_API_BASE: 'http://127.0.0.1:4174/api',
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
        {
          // Second instance of the SAME build, pointed at the frame-policy stub, for
          // embed.spec.ts only. NUXT_API_ORIGIN also switches on the /api proxy, which
          // would change every other spec's behavior on the main server above.
          command: 'node .output/server/index.mjs',
          url: 'http://127.0.0.1:4176/api/health',
          env: {
            HOST: '0.0.0.0',
            PORT: '4176',
            NITRO_PORT: '4176',
            NUXT_API_ORIGIN: 'http://127.0.0.1:4175',
          },
          reuseExistingServer: !process.env['CI'],
          timeout: 60_000,
        },
      ],
})
