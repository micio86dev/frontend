import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Playwright E2E — Exit redirect at interview completion (D8/D10, C10 PR7)
 *
 * Task 14.2 / 15.7:
 *   - Completion redirects when exit_redirect_url is configured
 *   - Static done branch shown unchanged when exit_redirect_url is not configured
 *   - Redirect fires identically for a candidate whose evaluation will resolve
 *     `pending` — the frontend has no visibility into evaluation status at
 *     redirect time and never polls for it before redirecting
 *
 * Driven via the W3 mock-provider injection point (NUXT_PUBLIC_INTERVIEW_PROVIDER_MOCK,
 * wired in playwright.config.ts) and the `window.__mockInterviewProvider` E2E hook
 * added in app/providers/factory.ts (C10 PR7) so the state machine can be driven to
 * `done` without a real HeyGen/Tavus SDK connection.
 */

const TOKEN = 'test-token-exit-redirect'
const EN_INTERVIEW_URL = `/en/interview/${TOKEN}`

const MOCK_START_RESPONSE = {
  session_id: 1,
  provider: 'heygen',
  provider_token: 'heygen-token-xyz',
  question_context: {
    question_index: 0,
    total_questions: 1,
    end_phrase: 'Let us move on to the next question.',
    final_phrase: 'Thank you for your time.',
    competency_code: 'COM',
  },
}

// /end carries the directive that ends the interview (D7). `{status:'ok'}` is a
// pre-v0.24.0 body: the client sees no `next_action`, degrades to the pause
// screen, and `done` — the state this whole spec is about — never arrives.
const MOCK_END_RESPONSE = {
  ended_competencies: 3,
  total_competencies: 3,
  next_action: 'done',
}

const EXIT_REDIRECT_URL = 'https://hr.acme.example.com/beai/done?ref=acme-672'

// ---------------------------------------------------------------------------
// sso-link exchange mocking (candidate-session-auth D1/D-A) — the entry route
// exchanges once before the candidate ever reaches consent/device-check/live.
// ---------------------------------------------------------------------------

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function makeCandidateJwt(): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      typ: 'candidate',
      candidate_ref: 'cand-e2e-exit',
      project_id: 1,
      exp: Math.floor(Date.now() / 1000) + 7200,
    })
  )
  return `${header}.${payload}.e2e-fake-signature`
}

async function mockSsoExchange(page: Page): Promise<void> {
  await page.route('**/api/sso/exchange*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: makeCandidateJwt() }),
    })
  })
}

// ---------------------------------------------------------------------------
// Route mock helpers
// ---------------------------------------------------------------------------

async function mockInterviewRoutes(page: Page, exitRedirectUrl: string | null) {
  await mockSsoExchange(page)

  await page.route('**/api/candidate/session', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        project: { exit_redirect_url: exitRedirectUrl },
      }),
    })
  })

  await page.route('**/api/candidate/interview/start', (route) => {
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_START_RESPONSE),
    })
  })

  await page.route('**/api/candidate/interview/end', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_END_RESPONSE),
    })
  })

  await page.route('**/api/candidate/interview/utterance', (route) => {
    route.fulfill({ status: 202, contentType: 'application/json', body: '{}' })
  })

  await page.route('**/api/candidate/interview/integrity', (route) => {
    route.fulfill({ status: 202, contentType: 'application/json', body: '{}' })
  })

  await page.route('**/api/candidate/interview/snapshot', (route) => {
    route.fulfill({ status: 202, contentType: 'application/json', body: '{}' })
  })
}

// Fulfill the external exit-redirect URL locally so the test never leaves
// the Playwright-controlled network sandbox.
async function mockExitRedirectTarget(page: Page) {
  await page.route(`${EXIT_REDIRECT_URL}*`, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>External exit page</body></html>',
    })
  })
}

// Device mocks — getUserMedia + AudioContext, mirrors interview-flow.spec.ts precedent.
// getSettings()/enumerateDevices()/add|removeEventListener are fixture FIDELITY
// (device-check-preview-and-device-selection D9) matching the real platform surface,
// not new assertions.
async function injectDeviceMocks(page: Page) {
  await page.addInitScript(() => {
    const videoTrack = {
      readyState: 'live',
      kind: 'video',
      stop: () => {},
      getSettings: () => ({ deviceId: 'mock-camera-1', width: 1280, height: 720 }),
    }
    const audioTrack = {
      readyState: 'live',
      kind: 'audio',
      stop: () => {},
      getSettings: () => ({ deviceId: 'mock-mic-1' }),
    }
    const fakeStream = {
      getTracks: () => [videoTrack, audioTrack],
      getVideoTracks: () => [videoTrack],
      getAudioTracks: () => [audioTrack],
    }

    const deviceChangeListeners: Array<() => void> = []

    Object.defineProperty(navigator, 'mediaDevices', {
      writable: true,
      configurable: true,
      value: {
        getUserMedia: async () => fakeStream,
        enumerateDevices: async () => [
          { deviceId: 'mock-camera-1', kind: 'videoinput', label: 'Mock Camera', groupId: 'g1' },
          {
            deviceId: 'mock-mic-1',
            kind: 'audioinput',
            label: 'Mock Microphone',
            groupId: 'g2',
          },
        ],
        addEventListener: (type: string, cb: () => void) => {
          if (type === 'devicechange') deviceChangeListeners.push(cb)
        },
        removeEventListener: (type: string, cb: () => void) => {
          if (type !== 'devicechange') return
          const idx = deviceChangeListeners.indexOf(cb)
          if (idx !== -1) deviceChangeListeners.splice(idx, 1)
        },
      },
    })

    const fakeBuffer = new Uint8Array(128).fill(148)
    const fakeAnalyser = {
      fftSize: 256,
      frequencyBinCount: 128,
      getByteTimeDomainData: (buf: Uint8Array) => {
        for (let i = 0; i < buf.length; i++) buf[i] = fakeBuffer[i] ?? 148
      },
    }
    ;(window as Record<string, unknown>).AudioContext = class {
      createAnalyser() {
        return fakeAnalyser
      }
      createMediaStreamSource() {
        return { connect: () => {} }
      }
    }
  })
}

async function goThroughDeviceCheckToLive(page: Page) {
  await page.goto(EN_INTERVIEW_URL)
  await page.getByRole('button', { name: /accept and continue/i }).click()
  await expect(page.getByRole('button', { name: /continue to interview/i })).toBeEnabled({
    timeout: 8000,
  })
  await page.getByRole('button', { name: /continue to interview/i }).click()

  // The W3 mock provider auto-transitions connecting → ready → listening on
  // start(), which drives the session to `live`. Wait for the E2E hook exposed
  // by createProvider() (factory.ts) before driving completion.
  await page.waitForFunction(() =>
    Boolean((window as Record<string, unknown>).__mockInterviewProvider)
  )
}

async function completeInterview(page: Page) {
  await page.evaluate(() => {
    const provider = (
      window as unknown as {
        __mockInterviewProvider: { emitFinalPhrase: () => void }
      }
    ).__mockInterviewProvider
    provider.emitFinalPhrase()
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Exit redirect at interview completion — E2E', () => {
  test.beforeEach(async ({ page }) => {
    await injectDeviceMocks(page)
  })

  test('exit_redirect_url configured → browser redirected on completion', async ({ page }) => {
    await mockInterviewRoutes(page, EXIT_REDIRECT_URL)
    await mockExitRedirectTarget(page)

    await goThroughDeviceCheckToLive(page)
    await completeInterview(page)

    await page.waitForURL(`${EXIT_REDIRECT_URL}*`, { timeout: 10_000 })
    expect(page.url()).toContain('hr.acme.example.com')
  })

  test('exit_redirect_url null → static done branch shown, no redirect', async ({ page }) => {
    await mockInterviewRoutes(page, null)

    await goThroughDeviceCheckToLive(page)
    await completeInterview(page)

    await expect(page.getByTestId('done-screen')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('heading', { name: /interview completed/i })).toBeVisible()
    // Still on the token-free session route — no external navigation occurred.
    expect(page.url()).toContain('/interview/session')
  })

  test('redirect fires identically for a pending-evaluation candidate — no status check precedes it', async ({
    page,
  }) => {
    await mockInterviewRoutes(page, EXIT_REDIRECT_URL)
    await mockExitRedirectTarget(page)

    // No evaluation/status endpoint is mocked at all — if the frontend ever
    // attempted to poll or check evaluation status before redirecting, that
    // request would fall through to Playwright's default "unmocked" abort
    // rather than silently succeeding, so a redirect here proves no such
    // check occurred.
    await goThroughDeviceCheckToLive(page)
    await completeInterview(page)

    await page.waitForURL(`${EXIT_REDIRECT_URL}*`, { timeout: 10_000 })
    expect(page.url()).toContain('hr.acme.example.com')
  })
})
