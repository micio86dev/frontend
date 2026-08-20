import { test, expect } from '@playwright/test'
import { checkA11y } from './fixtures/a11y'

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

// ---------------------------------------------------------------------------
// sso-link exchange mocking (candidate-session-auth D1/D-A)
//
// `/interview/{token}` is the entry route: it exchanges the sso-link token
// exactly once against `GET /api/sso/exchange`, persists the returned
// candidate JWT, then `replace`-redirects to the token-free `/interview/session`
// route. Every scenario below needs this mocked or the entry route can never
// progress past its connecting skeleton.
// ---------------------------------------------------------------------------

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** A candidate JWT shaped closely enough for useCandidateSession to decode client-side. */
function makeCandidateJwt(candidateRef = 'cand-e2e-001', projectId = 1): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      typ: 'candidate',
      candidate_ref: candidateRef,
      project_id: projectId,
      exp: Math.floor(Date.now() / 1000) + 7200,
    })
  )
  return `${header}.${payload}.e2e-fake-signature`
}

/**
 * Mock `GET /api/sso/exchange` — counts calls so refresh-safety can be
 * asserted (D1's central hazard: the exchange consumes the sso-link's `jti`
 * BEFORE any gate, so re-exchanging on refresh would burn the link).
 */
function mockSsoExchange(
  page: Parameters<typeof test>[0] extends { page: infer P } ? P : never,
  accessToken: string = makeCandidateJwt()
): { getCallCount: () => number } {
  let callCount = 0
  page.route('**/api/sso/exchange*', (route) => {
    callCount++
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: accessToken }),
    })
  })
  return { getCallCount: () => callCount }
}

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
// Device mocks — getUserMedia + AudioContext, so device check completes
// automatically (camera live, mic OK via immediate RMS spike). This enables
// the "Continue to Interview" button so confirmDevices() fires.
//
// DeviceCheck.client.vue is a .client.vue component registered as "DeviceCheck".
// It mounts inside <ClientOnly> in the production build. The mocks below allow
// navigator.mediaDevices.getUserMedia to succeed and AudioContext to report a
// mic RMS above threshold — enabling the "Continue to Interview" button without
// real hardware. Module-scoped so every describe block below can share it.
// ---------------------------------------------------------------------------

async function injectDeviceMocks(
  page: Parameters<typeof test>[0] extends { page: infer P } ? P : never
) {
  await page.addInitScript(() => {
    // Mock getUserMedia with fake tracks (non-real MediaStream object).
    // navigator.mediaDevices is null in non-HTTPS (localhost without TLS);
    // we replace it wholesale.
    //
    // getSettings() + enumerateDevices()/add|removeEventListener are fixture
    // FIDELITY (device-check-preview-and-device-selection D9) — they match the
    // real platform surface useDeviceCheck/useMediaDeviceList now consume, not
    // new test assertions.
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

// ---------------------------------------------------------------------------
// Route mock helpers
// ---------------------------------------------------------------------------

async function mockInterviewRoutes(
  page: Parameters<typeof test>[0] extends { page: infer P } ? P : never,
  startResponse: object = MOCK_START_RESPONSE,
  startStatus = 201,
  // GET /api/sso/exchange — the entry route exchanges once before the
  // candidate ever reaches the consent/device-check/live screens these tests
  // exercise; every scenario needs it mocked to get past the entry route.
  // Accepts an already-registered exchange handle (default param: creates one
  // if the caller doesn't need to inspect the call count) — registering a
  // SECOND `page.route()` for the same pattern here would shadow a caller's
  // own handle in Playwright's LIFO route-matching order, making its call
  // counter permanently stuck at 0.
  ssoExchange: { getCallCount: () => number } = mockSsoExchange(page)
) {
  void ssoExchange

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
      // getSettings()/enumerateDevices()/add|removeEventListener are fixture FIDELITY
      // (D9) matching the real platform surface, not new assertions.
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
              {
                deviceId: 'mock-camera-1',
                kind: 'videoinput',
                label: 'Mock Camera',
                groupId: 'g1',
              },
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

        // Mock AudioContext too — this fixture was missing it (a latent gap:
        // the REAL AudioContext.createMediaStreamSource() rejects a
        // duck-typed fakeStream that is not an actual MediaStream instance,
        // which the pre-Slice-5 component silently absorbed via its bare
        // catch{} with no visible consequence. Slice 5's micUnavailable
        // recovery Alert made that same failure user-visible, surfacing this
        // fixture gap via axe — buffer filled with 148 → RMS ≈ 0.156, above
        // MIC_SPEAK_THRESHOLD (0.04), so the mic genuinely passes here,
        // matching this describe block's "Happy path" intent.
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
    })

    test('shows consent screen on first load', async ({ page }) => {
      // Use English locale URL → button text is "I Accept and Continue"
      await page.goto(EN_INTERVIEW_URL)

      // Consent screen should be visible
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      // Accept button present (role-based locator — project convention, English locale)
      const acceptButton = page.getByRole('button', { name: /accept and continue/i })
      await expect(acceptButton).toBeVisible()

      // C13: the consent screen is the FIRST thing a candidate sees and the
      // one place they are asked to agree to recording. Until now axe ran only
      // on /health and /unsupported — the two simplest pages in the app —
      // while the screens that actually matter went unchecked.
      await checkA11y(page)
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

      // Camera and microphone permission UI. A candidate who cannot operate
      // this by keyboard cannot take the interview at all.
      await checkA11y(page)
    })

    // sdd-verify device-check-preview-and-device-selection CRITICAL finding,
    // attack surface 6: the scan above only ever runs against the CLOSED
    // dropdown's default state, so a `:focus`-only color-contrast violation
    // (SelectItem.vue's highlighted option) was structurally invisible to it —
    // axe-core evaluates real computed style, but nothing here ever gave an
    // option actual DOM focus before scanning. This closes that gap generally
    // (not just for the one class string that regressed): open the picker,
    // move real keyboard focus onto an option — Reka-ui's SelectItem drives
    // `data-highlighted` from the SAME native focus/blur event as `:focus`
    // (verified in node_modules/reka-ui/src/Select/SelectItem.vue), so there
    // is no separate keyboard-only state to also cover — then scan while the
    // highlighted option is live in the DOM. Any future focus:/hover:/
    // data-highlighted: variant that regresses contrast on this or any other
    // select trips this, not only the one CSS class named in the report.
    test('device picker highlighted option meets AA contrast when keyboard-focused', async ({
      page,
    }) => {
      await page.goto(EN_INTERVIEW_URL)

      await page.getByRole('button', { name: /accept and continue/i }).click()
      await expect(page.getByRole('heading', { level: 2, name: /device check/i })).toBeVisible({
        timeout: 5000,
      })

      const cameraPicker = page.getByTestId('camera-select-trigger')
      await cameraPicker.click()

      // Reka-ui auto-focuses the currently-selected item on open; ArrowDown
      // additionally exercises the roving-focus keyboard path explicitly.
      const option = page.getByRole('option').first()
      await expect(option).toBeVisible()
      await page.keyboard.press('ArrowDown')
      await expect(option).toBeFocused()

      // Scoped to the open listbox (`[data-slot="select-content"]`), not a
      // full-page scan. During RED, a full-page scan against this exact
      // sequence also surfaced a SEPARATE, pre-existing violation unrelated
      // to this fix: `session.vue`'s outer `<main>` keeps a hardcoded
      // `aria-label="Privacy Notice and Consent"` on every screen (not just
      // the consent step), and reka-ui's listbox correctly aria-hides that
      // `<main>` while open — except the trigger's own ancestor chain stays
      // inside the hidden subtree, tripping `aria-hidden-focus`. That is a
      // genuine, independent defect (flagged to the team, not fixed here —
      // out of scope for this hotfix); scoping to the listbox keeps this
      // regression test discriminating for the ONE thing it claims to
      // guard — the highlighted option's contrast — without going RED on
      // an unrelated finding it did not sign up to cover.
      await checkA11y(page, '[data-slot="select-content"]')
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
      mockSsoExchange(page)
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
      mockSsoExchange(page)
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
      mockSsoExchange(page)
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

  // ---------------------------------------------------------------------------
  // Entry route — refresh does not burn the link (Task 2.8 — D1's central hazard)
  //
  // The sso-link is single-use and its `jti` is consumed BEFORE any gate is
  // evaluated (SsoExchangeController.php:44) — an entry route that re-exchanges
  // on every mount would burn the link on the candidate's first refresh, which
  // is exactly what someone does when a page looks stuck. `replace: true`
  // removes the token URL from the history entry, so a refresh always lands on
  // the token-free session route, never back on the exchange.
  // ---------------------------------------------------------------------------

  test.describe('Entry route — refresh does not burn the link (D1)', () => {
    // Verification Finding #4 (mutation-proven decorative test, now removed):
    // a "reload at /interview/session triggers zero additional exchange
    // calls" test used to live here. It could not fail on the thing it
    // named — by the time a reload happens, the browser is ALREADY on
    // `/interview/session`, a route whose own component (`session.vue`)
    // never imports or calls the exchange transport at all. That guarantee
    // is structural (route separation), not a property of
    // `storedSessionMatchesLink` or any exchange-guard logic — disabling
    // `storedSessionMatchesLink` entirely left that test green, because
    // there was nothing left in the reload path for the mutation to break.
    // A test that cannot fail on the thing it names reads as coverage while
    // providing none, which is worse than no test.
    //
    // The sibling test below — re-visiting the ENTRY URL itself with a
    // stored, matching session — IS the test that exercises
    // `storedSessionMatchesLink` and DOES go red when it is disabled. It is
    // the one that actually protects D1's hazard: a candidate landing back
    // on the token URL (refresh, Back, a resent link) must not re-exchange.
    test('a stored, unexpired session with matching claims → zero exchange calls on a fresh visit', async ({
      page,
    }) => {
      // Simulates "closed the tab, reopened the app" (D1 scenario 3): the
      // candidate already holds a valid session before the entry route ever
      // exchanges anything. The stored candidate JWT's claims must MATCH the
      // sso-link's own claims for the skip to fire — build both from the
      // same candidate_ref/project_id.
      const candidateRef = 'cand-e2e-skip'
      const projectId = 7
      const candidateToken = makeCandidateJwt(candidateRef, projectId)
      const ssoLinkToken = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
        .concat(
          '.',
          base64url(
            JSON.stringify({
              typ: 'sso-link',
              candidate_ref: candidateRef,
              project_id: projectId,
              exp: Math.floor(Date.now() / 1000) + 1800,
            })
          )
        )
        .concat('.e2e-fake-sso-signature')
      const entryUrl = `/en/interview/${ssoLinkToken}`

      const exchange = mockSsoExchange(page, candidateToken)
      await mockInterviewRoutes(page, MOCK_START_RESPONSE, 201, exchange)

      await page.goto(entryUrl)
      await expect(page.getByRole('button', { name: /accept and continue/i })).toBeVisible({
        timeout: 10_000,
      })
      expect(exchange.getCallCount()).toBe(1)

      // Re-visit the SAME entry URL — the stored session's claims match the
      // sso-link's own claims, so the exchange must be skipped entirely.
      await page.goto(entryUrl)
      await expect(page.getByRole('button', { name: /accept and continue/i })).toBeVisible({
        timeout: 10_000,
      })
      expect(exchange.getCallCount()).toBe(1)
    })

    // -------------------------------------------------------------------------
    // Task 4.2 — the first /start request carries Authorization: Bearer.
    //
    // Interpretation note (documented per non-negotiable honesty requirement):
    // spec.md's "The E2E exchange step is not mocked" scenario asks that
    // GET /api/sso/exchange never be intercepted via page.route(). This
    // Playwright config's webServer is frontend-only — no PHP/Postgres/Redis
    // (playwright.config.ts:52-65) — and design.md's own "Where the real-chain
    // test lives — and why not the frontend" section explicitly scopes the
    // GENUINE chain to the api Pest suite (Task 4.1) for exactly that reason,
    // recording a real-API E2E wrapper as a named, costed, NOT-built-here
    // follow-up. Consistent with that recorded decision, the exchange RESPONSE
    // stays mocked here (there is no backend to answer it for real), but the
    // request-side behavior — the token is genuinely propagated from the
    // exchange response into the very next authenticated call — is asserted
    // directly and is not weakened by the stubbed response.
    // -------------------------------------------------------------------------
    test('the first POST /start request carries Authorization: Bearer <the exchanged token>', async ({
      page,
    }) => {
      const candidateToken = makeCandidateJwt('cand-e2e-auth-header')
      const exchange = mockSsoExchange(page, candidateToken)
      await mockInterviewRoutes(page, MOCK_START_RESPONSE, 201, exchange)

      let startAuthHeader: string | null = null
      await page.route('**/api/candidate/interview/start', (route) => {
        startAuthHeader ??= route.request().headers()['authorization'] ?? null
        route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_START_RESPONSE),
        })
      })

      await injectDeviceMocks(page)
      await page.goto(EN_INTERVIEW_URL)
      await page.getByRole('button', { name: /accept and continue/i }).click()
      await expect(page.getByRole('button', { name: /continue to interview/i })).toBeEnabled({
        timeout: 8000,
      })
      await page.getByRole('button', { name: /continue to interview/i }).click()

      await expect.poll(() => startAuthHeader, { timeout: 10_000 }).toBe(`Bearer ${candidateToken}`)
    })
  })

  // ---------------------------------------------------------------------------
  // Verification Finding #5 — locale preservation through failure paths.
  //
  // Both locale-loss fix sites ([token].vue and candidate-session.ts
  // middleware) are unit-tested with a marker-based useLocalePath stub, but
  // neither of those tests can prove the REAL @nuxtjs/i18n integration
  // actually resolves the marker into a genuine `/en/...` URL end to end in
  // a real browser. This E2E walks the `/en/` locale through to a terminal
  // via BOTH fix sites and asserts the final URL keeps the `/en/` prefix.
  // ---------------------------------------------------------------------------

  test.describe('Locale preservation through failure paths (Verification Finding #5)', () => {
    test('EN locale + no stored session on /interview/session → middleware redirects to /en/interview/terminal (not the default locale)', async ({
      page,
    }) => {
      // Navigate straight to the session route with NO exchange, NO stored
      // session — the candidate-session middleware gate fires synchronously.
      await page.goto('/en/interview/session')

      await page.waitForURL(/\/interview\/terminal/, { timeout: 10_000 })

      expect(page.url()).toContain('/en/interview/terminal')
      expect(page.url()).toContain('reason=session_expired')
    })

    test('EN locale + exchange 401 (spent link) → entry route redirects to /en/interview/terminal (not the default locale)', async ({
      page,
    }) => {
      await page.route('**/api/sso/exchange*', (route) => {
        route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Unauthenticated.' }),
        })
      })

      await page.goto(EN_INTERVIEW_URL)

      await page.waitForURL(/\/interview\/terminal/, { timeout: 10_000 })

      expect(page.url()).toContain('/en/interview/terminal')
      expect(page.url()).toContain('reason=spent_link')
    })
  })

  test.describe('pagehide keepalive-flush transport (D-C — sendBeacon replaced)', () => {
    // `navigator.sendBeacon` cannot carry an `Authorization` header (D-C), so the
    // pagehide integrity flush moved to `fetch(..., { keepalive: true })` via
    // `flushIntegrityKeepalive` (candidate-api.ts). This asserts NO code path
    // reaches for `navigator.sendBeacon` any more — a regression here would
    // silently reintroduce the unauthenticated end-of-session flush this
    // change exists to fix.
    test('navigator.sendBeacon is never called — the keepalive transport replaced it', async ({
      page,
    }) => {
      const sendBeaconCalls: string[] = []

      await page.addInitScript(() => {
        const originalSendBeacon = navigator.sendBeacon.bind(navigator)
        navigator.sendBeacon = (url: string, data?: BodyInit | null) => {
          const calls = JSON.parse(localStorage.getItem('sendBeaconCalls') ?? '[]') as string[]
          calls.push(url)
          localStorage.setItem('sendBeaconCalls', JSON.stringify(calls))
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

      const storedCalls = await page.evaluate(() => {
        return JSON.parse(localStorage.getItem('sendBeaconCalls') ?? '[]') as string[]
      })

      sendBeaconCalls.push(...storedCalls)
      expect(sendBeaconCalls).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // Slice 6 (Tasks 6.1-6.3) — device switching, cookie fallback, denied-permission
  // recovery. These scenarios land in the slice that BUILDS the behaviour (D9
  // correction to the proposal) — they must not arrive already green.
  // ---------------------------------------------------------------------------

  test.describe('Device switching, cookie fallback, denied-permission recovery (D3/D4/D6, Slice 6)', () => {
    const DEFAULT_CAM = { deviceId: 'cam-default', label: 'Default Camera' }
    const ALT_CAM = { deviceId: 'cam-alt', label: 'Alt Camera' }
    const DEFAULT_MIC = { deviceId: 'mic-default', label: 'Default Microphone' }

    // A getUserMedia mock that inspects the requested deviceId (if any) and
    // returns a stream whose video track's `label` identifies which camera was
    // actually acquired — the E2E-observable signal these tests assert on.
    // AudioContext returns a constant above-threshold RMS so the mic gate
    // passes immediately, isolating these scenarios to the camera/permission
    // behaviour under test.
    async function injectSwitchableDeviceMocks(
      page: Parameters<typeof test>[0] extends { page: infer P } ? P : never
    ) {
      // addInitScript's page function accepts exactly ONE serialized arg — cams
      // and mic must travel together in a single object, not as two positional
      // parameters (a second positional param silently binds to `undefined`).
      await page.addInitScript(
        ({
          cams,
          mic,
        }: {
          cams: { deviceId: string; label: string }[]
          mic: { deviceId: string; label: string }
        }) => {
          function makeStream(camLabel: string) {
            return {
              getTracks: () => [
                { readyState: 'live', kind: 'video', stop: () => {}, label: camLabel },
                { readyState: 'live', kind: 'audio', stop: () => {}, label: mic.label },
              ],
              getVideoTracks: () => [
                {
                  readyState: 'live',
                  stop: () => {},
                  label: camLabel,
                  getSettings: () => ({
                    deviceId: cams.find((c) => c.label === camLabel)?.deviceId ?? cams[0]!.deviceId,
                    width: 1280,
                    height: 720,
                  }),
                },
              ],
              getAudioTracks: () => [
                {
                  readyState: 'live',
                  stop: () => {},
                  label: mic.label,
                  getSettings: () => ({ deviceId: mic.deviceId }),
                },
              ],
            }
          }

          const deviceChangeListeners: Array<() => void> = []

          Object.defineProperty(navigator, 'mediaDevices', {
            writable: true,
            configurable: true,
            value: {
              getUserMedia: async (constraints: MediaStreamConstraints) => {
                const requestedId =
                  typeof constraints.video === 'object' &&
                  constraints.video &&
                  'deviceId' in constraints.video
                    ? ((constraints.video as { deviceId?: { exact?: string } }).deviceId?.exact ??
                      null)
                    : null
                const cam = cams.find((c) => c.deviceId === requestedId) ?? cams[0]!
                return makeStream(cam.label)
              },
              enumerateDevices: async () => [
                ...cams.map((c) => ({
                  deviceId: c.deviceId,
                  kind: 'videoinput',
                  label: c.label,
                  groupId: `g-${c.deviceId}`,
                })),
                { deviceId: mic.deviceId, kind: 'audioinput', label: mic.label, groupId: 'g-mic' },
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

          const fakeBuffer = new Uint8Array(128).fill(200) // RMS ~0.5625, above threshold
          const fakeAnalyser = {
            fftSize: 256,
            frequencyBinCount: 128,
            getByteTimeDomainData: (buf: Uint8Array) => {
              for (let i = 0; i < buf.length; i++) buf[i] = fakeBuffer[i] ?? 200
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
        },
        { cams: [DEFAULT_CAM, ALT_CAM], mic: DEFAULT_MIC }
      )
    }

    // Reads the picker's DISPLAYED value (SelectValue), not video.srcObject:
    // real Chromium's HTMLMediaElement.srcObject setter requires an actual
    // MediaStream instance and silently rejects a duck-typed mock object, so
    // the video element itself is not an observable signal here. The picker's
    // rendered text is exactly what a candidate perceives, and is driven by
    // the SAME deviceCheck.activeSelection the switch reconciles.
    async function getActiveCameraLabel(
      page: Parameters<typeof test>[0] extends { page: infer P } ? P : never
    ): Promise<string> {
      const text = await page.getByRole('combobox', { name: /camera/i }).textContent()
      return (text ?? '').trim()
    }

    test('switching the camera mid-check hands the SWITCHED stream to the interview on continue', async ({
      page,
    }) => {
      await mockInterviewRoutes(page)
      await injectSwitchableDeviceMocks(page)
      await page.goto(EN_INTERVIEW_URL)

      await page.getByRole('button', { name: /accept and continue/i }).click()
      const cameraPicker = page.getByRole('combobox', { name: /camera/i })
      await expect(cameraPicker).toBeVisible()

      // Starts on the default camera.
      await expect.poll(() => getActiveCameraLabel(page)).toBe(DEFAULT_CAM.label)

      await cameraPicker.click()
      await page.getByRole('option', { name: ALT_CAM.label }).click()

      // The switch settles: the picker re-enables and the preview now carries
      // the ALT camera's track — release-before-replace, never two live streams.
      await expect(cameraPicker).toBeEnabled()
      await expect.poll(() => getActiveCameraLabel(page)).toBe(ALT_CAM.label)

      const continueButton = page.getByRole('button', { name: /continue to interview/i })
      await expect(continueButton).toBeEnabled({ timeout: 8000 })
      await continueButton.click()

      // Handoff succeeds with the switched stream: the interview proceeds past
      // the device-check screen (no crash, no dead-end).
      await expect(page.getByRole('heading', { level: 2, name: /device check/i })).toHaveCount(0)
    })

    test('a stale cookie device id falls back to the system default, and the preference is rewritten', async ({
      page,
    }) => {
      await mockInterviewRoutes(page)
      await injectSwitchableDeviceMocks(page)

      // A cookie pointing at a camera id that no longer exists on this
      // "machine" (D4 step 1 — the primary fallback mechanism).
      await page.addInitScript(() => {
        document.cookie = `beai_device_prefs=${encodeURIComponent(
          JSON.stringify({ c: 'cam-unplugged-long-ago', m: 'mic-unplugged-long-ago' })
        )}; path=/`
      })

      await page.goto(EN_INTERVIEW_URL)
      await page.getByRole('button', { name: /accept and continue/i }).click()
      await expect(page.getByRole('combobox', { name: /camera/i })).toBeVisible()

      // Never dead-ends: the default device is acquired despite the stale ids.
      await expect.poll(() => getActiveCameraLabel(page)).toBe(DEFAULT_CAM.label)
      await expect(page.getByRole('button', { name: /continue to interview/i })).toBeEnabled({
        timeout: 8000,
      })

      // The cookie is rewritten to what was ACTUALLY obtained — never left
      // pointing at devices that no longer exist.
      //
      // WebKit-only exception: the webServer here is plain HTTP
      // (127.0.0.1:3000, playwright.config.ts). Chromium treats localhost/
      // 127.0.0.1 as a "potentially trustworthy origin" and allows a
      // `Secure`-flagged cookie to be set there anyway; WebKit does not
      // extend that exception and silently refuses the rewrite (D4's
      // `secure: true`, correct and required in production, which is always
      // HTTPS — an NFR). The pre-set stale cookie this test wrote via plain
      // `document.cookie` (no Secure flag) is unaffected by that and stays
      // exactly as written, which is what this assertion would otherwise
      // catch as a false failure. Every other assertion above (default
      // device acquired, Continue enabled) still runs identically on WebKit.
      if (test.info().project.name !== 'webkit') {
        const cookieValue = await page.evaluate(() => {
          const match = document.cookie.split('; ').find((c) => c.startsWith('beai_device_prefs='))
          return match ? JSON.parse(decodeURIComponent(match.split('=')[1] ?? '')) : null
        })
        expect(cookieValue).toEqual({ c: DEFAULT_CAM.deviceId, m: DEFAULT_MIC.deviceId })
      }
    })

    test('a denied permission shows browser-neutral recovery copy; Retry re-triggers the check and recovers', async ({
      page,
    }) => {
      await mockInterviewRoutes(page)

      await page.addInitScript(() => {
        let attempt = 0
        Object.defineProperty(navigator, 'mediaDevices', {
          writable: true,
          configurable: true,
          value: {
            getUserMedia: async () => {
              attempt += 1
              if (attempt === 1) {
                const err = new DOMException('Permission denied', 'NotAllowedError')
                throw err
              }
              const track = (kind: 'video' | 'audio') => ({
                readyState: 'live',
                kind,
                stop: () => {},
                label: `${kind}-recovered`,
                getSettings: () => ({ deviceId: `${kind}-recovered`, width: 1280, height: 720 }),
              })
              const videoTrack = track('video')
              const audioTrack = track('audio')
              return {
                getTracks: () => [videoTrack, audioTrack],
                getVideoTracks: () => [videoTrack],
                getAudioTracks: () => [audioTrack],
              }
            },
            enumerateDevices: async () => [],
            addEventListener: () => {},
            removeEventListener: () => {},
          },
        })

        const fakeBuffer = new Uint8Array(128).fill(200)
        const fakeAnalyser = {
          fftSize: 256,
          frequencyBinCount: 128,
          getByteTimeDomainData: (buf: Uint8Array) => {
            for (let i = 0; i < buf.length; i++) buf[i] = fakeBuffer[i] ?? 200
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

      await page.goto(EN_INTERVIEW_URL)
      await page.getByRole('button', { name: /accept and continue/i }).click()

      // The recovery Alert is shown — browser-neutral guidance (D7), no failure
      // state on this screen is terminal.
      await expect(page.getByText(/camera icon in your browser's address bar/i)).toBeVisible()
      const retryButton = page.getByRole('button', { name: /retry/i })
      await expect(retryButton).toBeVisible()

      await retryButton.click()

      // release() then check() re-runs getUserMedia — this time it succeeds.
      await expect(page.getByRole('button', { name: /continue to interview/i })).toBeEnabled({
        timeout: 8000,
      })
    })
  })
})
