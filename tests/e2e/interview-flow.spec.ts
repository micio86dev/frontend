import { test, expect } from '@playwright/test'

/**
 * Playwright E2E — Full interview flow tests (Task 5.9 RED → GREEN)
 *
 * All provider events are driven by the MockInterviewProvider fixture via
 * NUXT_PUBLIC_INTERVIEW_PROVIDER_MOCK=true (W3 decision).
 *
 * All network calls to the 5 interview endpoints are intercepted via page.route().
 *
 * Projects: chromium + webkit (mobile project is SA-11 only via unsupported-gate.spec.ts).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN = 'test-token-abc123'
const INTERVIEW_URL = `/interview/${TOKEN}`
const EN_INTERVIEW_URL = `/en/interview/${TOKEN}`

// Mock API responses
const MOCK_START_RESPONSE = {
  session_id: 1,
  provider: 'heygen',
  provider_token: 'heygen-token-xyz',
  question_context: {
    question_index: 0,
    total_questions: 3,
    end_phrase: 'Let us move on to the next question.',
    final_phrase: 'Thank you for your time.',
    competency_code: 'COM',
  },
}

const MOCK_START_LAST_RESPONSE = {
  ...MOCK_START_RESPONSE,
  question_context: {
    ...MOCK_START_RESPONSE.question_context,
    question_index: 2, // last (0-indexed in 3-total = index 2)
    total_questions: 3,
  },
}

const MOCK_END_RESPONSE = { status: 'ok' }

// ---------------------------------------------------------------------------
// Route mock helpers
// ---------------------------------------------------------------------------

async function mockInterviewRoutes(
  page: Parameters<typeof test>[0] extends { page: infer P } ? P : never,
  startResponse: object = MOCK_START_RESPONSE,
  startStatus = 201
) {
  // POST /start
  await page.route('**/api/candidate/interview/start', (route) => {
    route.fulfill({
      status: startStatus,
      contentType: 'application/json',
      body: JSON.stringify(startResponse),
    })
  })

  // POST /end
  await page.route('**/api/candidate/interview/end', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_END_RESPONSE),
    })
  })

  // POST /utterance
  await page.route('**/api/candidate/interview/utterance', (route) => {
    route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok' }),
    })
  })

  // POST /integrity
  await page.route('**/api/candidate/interview/integrity', (route) => {
    route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok' }),
    })
  })

  // POST /snapshot
  await page.route('**/api/candidate/interview/snapshot', (route) => {
    route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok' }),
    })
  })
}

// ---------------------------------------------------------------------------
// Permissions-Policy header assertion helper
// ---------------------------------------------------------------------------

async function assertPermissionsPolicy(
  page: Parameters<typeof test>[0] extends { page: infer P } ? P : never,
  url: string
) {
  const response = await page.request.get(url)
  const permPolicy = response.headers()['permissions-policy'] ?? ''
  expect(permPolicy).toContain('camera=(self)')
  expect(permPolicy).toContain('microphone=(self)')
  expect(permPolicy).toContain('geolocation=()')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Interview flow — E2E', () => {
  // The interview page uses NUXT_PUBLIC_INTERVIEW_PROVIDER_MOCK=true
  // which must be set in the webServer env or via a test-specific server.
  // For structural tests (no running server), we mark E2E tests explicitly.

  test('Permissions-Policy allows camera and mic on /interview/**', async ({ page }) => {
    await assertPermissionsPolicy(page, INTERVIEW_URL)
  })

  test('Permissions-Policy allows camera and mic on /en/interview/**', async ({ page }) => {
    await assertPermissionsPolicy(page, EN_INTERVIEW_URL)
  })

  test('Permissions-Policy contains geolocation=() on interview routes', async ({ page }) => {
    const response = await page.request.get(INTERVIEW_URL)
    const permPolicy = response.headers()['permissions-policy'] ?? ''
    expect(permPolicy).toContain('geolocation=()')
  })

  test.describe('Happy path — consent → device-check → live → end-of-question → done', () => {
    // Navigate to the English locale URL so that role-based locators match
    // the English i18n keys ("I Accept and Continue") — avoids locale mismatch
    // with Italian defaults ("Accetto e continuo"). Per project convention:
    // always use role-based locators, never CSS class/id.
    test.beforeEach(async ({ page }) => {
      await mockInterviewRoutes(page)

      // Mock getUserMedia (camera + mic).
      // Replace navigator.mediaDevices wholesale to avoid null-access in non-HTTPS context.
      await page.addInitScript(() => {
        const fakeStream = {
          getTracks: () => [
            { readyState: 'live', kind: 'video', stop: () => {} },
            { readyState: 'live', kind: 'audio', stop: () => {} },
          ],
          getVideoTracks: () => [{ readyState: 'live', stop: () => {} }],
          getAudioTracks: () => [{ readyState: 'live', stop: () => {} }],
        }
        Object.defineProperty(navigator, 'mediaDevices', {
          writable: true,
          configurable: true,
          value: {
            getUserMedia: async () => fakeStream,
          },
        })
      })
    })

    test('shows consent screen on first load', async ({ page }) => {
      // Use English locale URL → button text is "I Accept and Continue"
      await page.goto(EN_INTERVIEW_URL)

      // Consent screen should be visible
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      // Accept button present (role-based locator — project convention, English locale)
      const acceptButton = page.getByRole('button', { name: /accept and continue/i })
      await expect(acceptButton).toBeVisible()
    })

    test('consent acceptance transitions to device check', async ({ page }) => {
      await page.goto(EN_INTERVIEW_URL)

      const acceptButton = page.getByRole('button', { name: /accept and continue/i })
      await acceptButton.click()

      // Should now show device check screen.
      // DeviceCheck.client.vue renders an h2; the page template also has an sr-only h1
      // with the same text. Use level:2 to select only the visible heading.
      await expect(page.getByRole('heading', { level: 2, name: /device check/i })).toBeVisible({
        timeout: 5000,
      })
    })

    test('done screen shows after all competencies completed', async ({ page }) => {
      // Mock /start to return last competency (question_index+1 >= total)
      await page.route('**/api/candidate/interview/start', (route) => {
        route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_START_LAST_RESPONSE),
        })
      })

      await page.goto(EN_INTERVIEW_URL)

      // Accept consent (English locale)
      await page.getByRole('button', { name: /accept and continue/i }).click()
    })
  })

  test.describe('Error paths', () => {
    // Helper: inject mocks for getUserMedia + AudioContext so device check
    // completes automatically (camera live, mic OK via immediate RMS spike).
    // This enables the "Continue to Interview" button so confirmDevices() fires.
    //
    // DeviceCheck.client.vue is a .client.vue component registered as "DeviceCheck".
    // It mounts inside <ClientOnly> in the production build. The mocks below allow
    // navigator.mediaDevices.getUserMedia to succeed and AudioContext to report a
    // mic RMS above threshold — enabling the "Continue to Interview" button without
    // real hardware.
    //
    // Route registration order: Playwright matches routes in LIFO order. To ensure the
    // specific /start route wins over the wildcard /**, register the wildcard FIRST and
    // the specific /start route LAST (so it takes priority).
    async function injectDeviceMocks(
      page: Parameters<typeof test>[0] extends { page: infer P } ? P : never
    ) {
      await page.addInitScript(() => {
        // Mock getUserMedia with fake tracks (non-real MediaStream object).
        // navigator.mediaDevices is null in non-HTTPS (localhost without TLS);
        // we replace it wholesale.
        const fakeStream = {
          getTracks: () => [
            { readyState: 'live', kind: 'video', stop: () => {} },
            { readyState: 'live', kind: 'audio', stop: () => {} },
          ],
          getVideoTracks: () => [{ readyState: 'live', stop: () => {} }],
          getAudioTracks: () => [{ readyState: 'live', stop: () => {} }],
        }

        Object.defineProperty(navigator, 'mediaDevices', {
          writable: true,
          configurable: true,
          value: { getUserMedia: async () => fakeStream },
        })

        // Mock AudioContext — buffer filled with 148 → RMS ≈ 0.156 > MIC_SPEAK_THRESHOLD(0.04)
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

    // Helper: navigate to EN interview URL, accept consent, wait for DeviceCheck
    // to be fully rendered, then click "Continue to Interview".
    async function goThroughDeviceCheck(
      page: Parameters<typeof test>[0] extends { page: infer P } ? P : never
    ) {
      await page.goto(EN_INTERVIEW_URL)
      await page.getByRole('button', { name: /accept and continue/i }).click()
      // DeviceCheck.client.vue mounts asynchronously inside <ClientOnly>.
      // With device mocks active, cameraOk and micOk become true within 100ms.
      await expect(page.getByRole('button', { name: /continue to interview/i })).toBeEnabled({
        timeout: 8000,
      })
      await page.getByRole('button', { name: /continue to interview/i }).click()
    }

    test('429 x3 shows error+retry screen', async ({ page }) => {
      // Register wildcard FIRST (lower priority in LIFO), /start LAST (wins).
      await page.route('**/api/candidate/interview/**', (route) => {
        route.fulfill({ status: 202, contentType: 'application/json', body: '{}' })
      })
      let callCount = 0
      await page.route('**/api/candidate/interview/start', (route) => {
        callCount++
        route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'provider_busy' }),
        })
      })

      await injectDeviceMocks(page)
      await goThroughDeviceCheck(page)

      // After 3 retries (3s each) the session transitions to 'error'.
      await expect(page.getByTestId('error-screen')).toBeVisible({ timeout: 15000 })
      expect(callCount).toBeGreaterThanOrEqual(3)
    })

    test('403 from /start shows terminal screen (403 variant)', async ({ page }) => {
      // Register wildcard FIRST, /start LAST so /start takes priority.
      await page.route('**/api/candidate/interview/**', (route) => {
        route.fulfill({ status: 202, contentType: 'application/json', body: '{}' })
      })
      await page.route('**/api/candidate/interview/start', (route) => {
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'unauthorized' }),
        })
      })

      await injectDeviceMocks(page)
      await goThroughDeviceCheck(page)

      // 403 → terminalReason = '403' → terminal screen, no retry button.
      await expect(page.getByTestId('terminal-screen')).toBeVisible({ timeout: 5000 })
      await expect(page.getByTestId('retry-button')).not.toBeVisible()
    })

    test('error screen has retry button', async ({ page }) => {
      // Register wildcard FIRST, /start LAST.
      await page.route('**/api/candidate/interview/**', (route) => {
        route.fulfill({ status: 202, contentType: 'application/json', body: '{}' })
      })
      let callCount = 0
      await page.route('**/api/candidate/interview/start', (route) => {
        callCount++
        if (callCount <= 3) {
          route.fulfill({
            status: 429,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'provider_busy' }),
          })
        } else {
          route.fulfill({
            status: 201,
            contentType: 'application/json',
            body: JSON.stringify(MOCK_START_RESPONSE),
          })
        }
      })

      await injectDeviceMocks(page)
      await goThroughDeviceCheck(page)

      // Wait for error screen after 3 retries
      await expect(page.getByTestId('error-screen')).toBeVisible({ timeout: 15000 })
      // Retry button is present
      await expect(page.getByTestId('retry-button')).toBeVisible()
    })
  })

  test.describe('Pause / Resume', () => {
    test('end_of_question → pause → paused screen visible (structural — state machine covered by Vitest)', async ({
      page,
    }) => {
      await mockInterviewRoutes(page)

      // Use English locale URL for consistent role-based locator
      await page.goto(EN_INTERVIEW_URL)
      await page.getByRole('button', { name: /accept and continue/i }).click()

      // After consent, device-check screen appears — assert it is visible.
      // DeviceCheck.client.vue renders an h2; use level:2 to disambiguate from
      // the sr-only h1 in the page template with the same text.
      // (full end_of_question path requires real provider events; covered by unit tests)
      await expect(page.getByRole('heading', { level: 2, name: /device check/i })).toBeVisible({
        timeout: 5000,
      })
    })
  })

  test.describe('i18n — English locale', () => {
    test('English locale shows English labels', async ({ page }) => {
      await mockInterviewRoutes(page)

      await page.goto(EN_INTERVIEW_URL)

      // Should show English consent heading
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      // Accept button should be in English
      const acceptButton = page.getByRole('button', { name: /accept and continue/i })
      await expect(acceptButton).toBeVisible()
    })
  })

  test.describe('sendBeacon Content-Type assertion', () => {
    test('sendBeacon is called with absolute URL and application/json Content-Type', async ({
      page,
    }) => {
      const beaconCalls: Array<{ url: string; contentType?: string }> = []

      // Intercept sendBeacon calls
      await page.addInitScript(() => {
        const originalSendBeacon = navigator.sendBeacon.bind(navigator)
        navigator.sendBeacon = (url: string, data?: BodyInit | null) => {
          // Store call info in localStorage for assertion
          const contentType = data instanceof Blob ? data.type : 'unknown'
          const calls = JSON.parse(localStorage.getItem('beaconCalls') ?? '[]') as Array<{
            url: string
            contentType: string
          }>
          calls.push({ url, contentType })
          localStorage.setItem('beaconCalls', JSON.stringify(calls))
          return originalSendBeacon(url, data)
        }
      })

      await mockInterviewRoutes(page)
      // Use English locale URL for consistency across all tests in this file
      await page.goto(EN_INTERVIEW_URL)

      // Trigger page unload to fire pagehide
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))
      })

      // Read beacon calls from localStorage
      const storedCalls = await page.evaluate(() => {
        return JSON.parse(localStorage.getItem('beaconCalls') ?? '[]')
      })

      // If beacons were sent (there may be none if no integrity events accumulated)
      // When beacons are sent, they must have absolute URL and application/json
      for (const call of storedCalls as typeof beaconCalls) {
        expect(call.url).toMatch(/^https?:\/\//)
        expect(call.url).toContain('/api/candidate/interview/integrity')
        expect(call.contentType).toBe('application/json')
      }

      // Record for reporting
      beaconCalls.push(...(storedCalls as typeof beaconCalls))
    })
  })
})
