import { test, expect, type Frame, type Locator, type Page } from '@playwright/test'
import { checkA11y } from './fixtures/a11y'
import { injectCallMedia, setFakeMicLevel } from './fixtures/device-mocks'
import { mockBrandedInterview } from './fixtures/branded-interview'

/**
 * The candidate call screen, end to end (candidate-interview-call-ui). It is the
 * default live interview since UI-12, so this runs in the `chromium` and `webkit`
 * projects against the main web server like every other spec; the two embed tests
 * use the embed server (framing needs its frame-policy stub).
 *
 * The provider is the in-page mock the factory installs
 * (`NUXT_PUBLIC_INTERVIEW_PROVIDER_MOCK`), driven through `window.__mockInterviewProvider`;
 * every API call is answered by `page.route`. The microphone is a knob
 * (`setFakeMicLevel`), the camera a real canvas-backed `MediaStream`.
 */

const TOKEN = 'call-token-abc123'
const LIVE_URL = `/en/interview/${TOKEN}`
const SESSION_KEY = 'beai_candidate_session'
const SUPPORT_URL = 'https://support.example.test/help'

/** A response of `POST /candidate/interview/start`; `session_id` is what tells two competencies apart. */
function startResponse(sessionId: number, competency: string) {
  return {
    session_id: sessionId,
    provider: 'heygen',
    provider_token: 'heygen-token-xyz',
    audio_only: false,
    // The server states the interview limit: the duration section, the countdown and the
    // suggested-length bar all render, so the panel is as tall as it ever gets.
    interview_max_seconds: 1200,
    answer_min_seconds: 90,
    answer_max_seconds: 150,
    question_context: {
      question_index: sessionId - 1,
      total_questions: 3,
      end_phrase: 'Let us move on to the next question.',
      final_phrase: 'Thank you for your time.',
      competency_code: competency,
    },
  }
}

/** What a spec needs to know about, and to steer in, the calls the page makes. */
interface CallApi {
  /** `/start` calls so far. */
  starts: () => number
  /** Bodies of the `/suspend` calls so far. */
  suspends: () => unknown[]
  /** `/end` calls so far. */
  ends: () => number
  /** Every call to `/start`, `/end` and `/suspend`, in the order the page made them. */
  calls: () => string[]
  /** The next competency: every `/start` from now on answers with it. */
  startNextWith: (sessionId: number, competency: string) => void
  /** The next call to this endpoint answers 500, once; the counters still count it. */
  failNext: (endpoint: 'start' | 'suspend') => void
  /**
   * Hold every `/start` from now on until the returned function is called, so the boundary's
   * forced-mute window stays open long enough to be observed instead of raced.
   */
  holdStart: () => () => void
}

/** The branded interview routes, the call-screen media, and the counters the specs read. */
async function mockCallApi(page: Page, primaryColor: string | null = '#771aaf'): Promise<CallApi> {
  await mockBrandedInterview(page, primaryColor)
  await injectCallMedia(page)

  let starts = 0
  let ends = 0
  const suspends: unknown[] = []
  const calls: string[] = []
  const failing = new Set<'start' | 'suspend'>()
  let next = startResponse(1, 'COM')
  let startGate: Promise<void> | null = null

  /** A 500 for an endpoint armed with `failNext`, consumed by the call that gets it. */
  const failure = (endpoint: 'start' | 'suspend') => {
    if (!failing.delete(endpoint)) return null
    return {
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Server Error' }),
    }
  }

  // LIFO: registered after the branded fixture's own /start, so these answer.
  await page.route('**/api/candidate/interview/start', async (route) => {
    starts += 1
    calls.push('start')
    await startGate
    const failed = failure('start')
    if (failed) return route.fulfill(failed)
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(next),
    })
  })
  await page.route('**/api/candidate/interview/end', (route) => {
    ends += 1
    calls.push('end')
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ended_competencies: 1,
        total_competencies: 3,
        next_action: 'continue',
      }),
    })
  })
  await page.route('**/api/candidate/interview/suspend', (route) => {
    suspends.push(route.request().postDataJSON())
    calls.push('suspend')
    const failed = failure('suspend')
    if (failed) return route.fulfill(failed)
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok' }),
    })
  })

  return {
    starts: () => starts,
    suspends: () => suspends,
    ends: () => ends,
    calls: () => calls,
    startNextWith: (sessionId, competency) => {
      next = startResponse(sessionId, competency)
    },
    failNext: (endpoint) => {
      failing.add(endpoint)
    },
    holdStart: () => {
      let release!: () => void
      startGate = new Promise<void>((resolve) => (release = resolve))
      return () => {
        startGate = null
        release()
      }
    },
  }
}

/** A page, or a frame inside one: the embed renders the same screen in an iframe. */
type Root = Pick<Page, 'getByRole' | 'getByTestId' | 'locator'>

/** Consent, device check, then the live call screen. */
async function reachLiveCall(root: Root, open?: () => Promise<unknown>): Promise<void> {
  await open?.()
  await root.getByRole('button', { name: /accept and continue/i }).click({ timeout: 15000 })
  const start = root.getByRole('button', { name: /start the interview/i })
  await expect(start).toBeEnabled({ timeout: 8000 })
  await start.click()
  await expect(root.getByTestId('call-question')).toBeVisible({ timeout: 15000 })
}

/** Straight to the live call, and the fake microphone silent so the candidate's tile starts dark. */
async function goLive(page: Page): Promise<void> {
  await reachLiveCall(page, () => page.goto(LIVE_URL))
  await setFakeMicLevel(page, 0)
}

/** What the in-page mock provider (`window.__mockInterviewProvider`) is driven with. */
interface MockProvider {
  emitSpeaking: () => void
  emitListening: () => void
  emitEndPhrase: () => void
  emitTranscript: (text: string, role: 'avatar' | 'user') => void
}

/** Drives the newest in-page mock provider of a page or of a frame (the embed). */
async function callProvider<K extends keyof MockProvider>(
  root: Pick<Page | Frame, 'evaluate'>,
  method: K,
  ...args: Parameters<MockProvider[K]>
): Promise<void> {
  await root.evaluate(
    ({ method: name, args: values }) => {
      const provider = (window as unknown as Record<string, Record<string, unknown>>)[
        '__mockInterviewProvider'
      ]!
      ;(provider[name] as (...rest: unknown[]) => void)(...values)
    },
    { method, args: args as unknown[] }
  )
}

const drive = (page: Page, call: 'emitSpeaking' | 'emitListening' | 'emitEndPhrase') =>
  callProvider(page, call)

/** One transcript entry from the newest mock provider: the avatar's unless a role is given. */
const say = (page: Page, text: string, role: 'avatar' | 'user' = 'avatar') =>
  callProvider(page, 'emitTranscript', text, role)

const interviewerTile = (page: Page) =>
  page.locator('[data-slot="avatar-layer"] > [data-slot="call-tile"]')
const selfTile = (page: Page) =>
  page.locator('[data-slot="call-stage-self"] [data-slot="call-tile"]')

test.describe('the call stage (the default live interview)', () => {
  test('the call stage renders', async ({ page }) => {
    await mockCallApi(page)
    await goLive(page)

    await expect(page.locator('[data-slot="call-layout"]')).toHaveAttribute('data-live', 'true')
    await expect(page.getByTestId('call-question-hint')).toBeVisible()
    await expect(page.getByTestId('call-panel')).toBeVisible()
    await expect(page.getByTestId('call-exit')).toBeVisible()
    await expect(page.getByTestId('call-help-link')).toBeVisible()
    await expect(selfTile(page)).toBeVisible()

    // The old live screen's own controls are not on this one.
    await expect(page.getByRole('button', { name: /^pause$/i })).toHaveCount(0)
  })

  test('the header names the interview, shows a clock and offers exactly three controls', async ({
    page,
  }) => {
    await mockCallApi(page)
    // Later routes win: give the organization a logo so the plate is actually drawn.
    await page.route('**/api/candidate/session', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            project: { exit_redirect_url: null },
            branding: {
              primary_color: '#771aaf',
              logo_url: 'https://cdn.test/acme.png',
              name: 'Acme Selezione',
            },
          },
        }),
      })
    )
    await page.route('https://cdn.test/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="16"/>',
      })
    )
    await goLive(page)

    const header = page.getByTestId('call-header')
    await expect(page.getByTestId('call-header-title')).toHaveText(
      'Assessment interview · Sales Manager'
    )
    await expect(header.getByRole('button')).toHaveText(['Captions on', 'Microphone on', 'Exit'])
    await expect(page.getByTestId('call-header-clock').locator('time')).toHaveText(/^\d{2,}:\d{2}$/)
    await expect(header.getByRole('timer')).toHaveCount(0)
    await expect(page.getByRole('timer')).toHaveCount(1)
    await expect(page.getByTestId('call-header-captions')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('call-header-mic')).toHaveAttribute('aria-pressed', 'true')
    // The logo keeps the same white plate while live as on every other page.
    await expect(page.locator('header .bg-card [data-testid="brand-canvas-logo"]')).toHaveCount(1)
  })

  test('the question is the avatar transcript, and a user transcript never appears', async ({
    page,
  }) => {
    await mockCallApi(page)
    await goLive(page)
    const band = page.getByTestId('call-question')

    await say(page, 'Tell me about a time you led a team.')
    await expect(band).toContainText('Tell me about a time you led a team.')
    await expect(page.getByTestId('call-question-hint')).toHaveCount(0)

    await say(page, 'I once led a team of six engineers.', 'user')
    // The candidate's own words go to the server, never onto the screen.
    await page.waitForTimeout(300)
    await expect(band).not.toContainText('six engineers')
    await expect(band).toContainText('Tell me about a time you led a team.')

    // The next avatar utterance replaces the question.
    await say(page, 'What was the hardest part?')
    await expect(band).toContainText('What was the hardest part?')
    await expect(band).not.toContainText('led a team')
  })

  test('the ring follows the avatar turn and the faked microphone level', async ({ page }) => {
    await mockCallApi(page)
    await goLive(page)
    const interviewer = interviewerTile(page)
    const self = selfTile(page)

    await expect(interviewer).toHaveAttribute('data-speaking', 'false')
    await expect(self).toHaveAttribute('data-speaking', 'false')

    // The avatar speaks: its tile lights, the candidate's stays dark, and the cue
    // that is not colour is in the DOM.
    await drive(page, 'emitSpeaking')
    await expect(interviewer).toHaveAttribute('data-speaking', 'true')
    await expect(self).toHaveAttribute('data-speaking', 'false')
    await expect(interviewer.getByText('The interviewer is speaking')).toBeAttached()

    // The avatar yields: its ring goes out.
    await drive(page, 'emitListening')
    await expect(interviewer).toHaveAttribute('data-speaking', 'false')

    // The candidate speaks (mic above the threshold long enough): their tile lights.
    await setFakeMicLevel(page, 0.3)
    await expect(self).toHaveAttribute('data-speaking', 'true')
    await expect(interviewer).toHaveAttribute('data-speaking', 'false')
    await expect(self.getByText('You are speaking')).toBeAttached()

    // Silence: it goes out again.
    await setFakeMicLevel(page, 0)
    await expect(self).toHaveAttribute('data-speaking', 'false')
  })

  test.describe('Exit', () => {
    test('opens a confirmation, Stay closes it and sends nothing', async ({ page }) => {
      const api = await mockCallApi(page)
      await goLive(page)

      const exit = page.getByTestId('call-exit')
      await exit.click()
      const dialog = page.getByRole('dialog', { name: /leave the interview/i })
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('nothing is recorded')

      await page.getByTestId('call-exit-stay').click()
      await expect(dialog).toBeHidden()
      await expect(exit).toBeFocused()
      await expect(page.getByTestId('call-question')).toBeVisible()

      // No sleep: prove it with a real round trip made AFTER Stay. The next
      // competency's /end -> /start goes through the same page and the same
      // network pipeline, so a /suspend that Stay had fired would already be in the
      // ordered call log before the second /start arrives. The page is still live
      // (Stay never paused it), which is the only state a suspend is sent from.
      api.startNextWith(2, 'COL')
      await drive(page, 'emitEndPhrase')
      await expect.poll(() => api.starts(), { timeout: 15000 }).toBe(2)
      await expect(page.getByTestId('call-question')).toBeVisible()

      expect(api.calls()).toEqual(['start', 'end', 'start'])
      expect(api.suspends()).toHaveLength(0)
    })

    test('confirming suspends once, keeps the stored session, and Resume re-issues /start', async ({
      page,
    }) => {
      const api = await mockCallApi(page)
      await goLive(page)
      expect(api.starts()).toBe(1)
      const stored = await page.evaluate((key) => localStorage.getItem(key), SESSION_KEY)
      expect(stored).not.toBeNull()

      await page.getByTestId('call-exit').click()
      await page.getByTestId('call-exit-confirm').click()

      const suspended = page.getByRole('heading', { name: /interview suspended/i })
      await expect(suspended).toBeVisible()
      await expect(suspended).toBeFocused()
      await expect(page.getByTestId('call-question')).toHaveCount(0)

      // Exactly once, for the session that was live.
      await expect.poll(() => api.suspends().length).toBe(1)
      await page.waitForTimeout(500)
      expect(api.suspends()).toEqual([{ session_id: 1 }])

      // Suspended, not left: the stored session is untouched and the page did not move.
      expect(await page.evaluate((key) => localStorage.getItem(key), SESSION_KEY)).toBe(stored)
      expect(new URL(page.url()).pathname).toMatch(/\/interview\//)
      expect(api.ends()).toBe(0)

      // Resume goes back through /start, which answers with the SAME competency.
      await page.getByRole('button', { name: /resume/i }).click()
      await expect(page.getByTestId('call-question')).toBeVisible({ timeout: 15000 })
      expect(api.starts()).toBe(2)
      expect(api.ends()).toBe(0)
    })

    // The code treats the two failures differently, on purpose, and so do these:
    // /suspend is fire-and-forget (the candidate has already been shown the paused
    // screen; a failure is silent, see `callSuspend`), whereas /start on Resume
    // lands on the retryable error screen (`startSession`, any non-401/403/429 error).
    test('a failed /suspend is silent: the suspended screen shows, the session is kept, Resume works', async ({
      page,
    }) => {
      const api = await mockCallApi(page)
      await goLive(page)
      const stored = await page.evaluate((key) => localStorage.getItem(key), SESSION_KEY)
      expect(stored).not.toBeNull()

      api.failNext('suspend')
      await page.getByTestId('call-exit').click()
      await page.getByTestId('call-exit-confirm').click()

      const suspended = page.getByRole('heading', { name: /interview suspended/i })
      await expect(suspended).toBeVisible()
      await expect(suspended).toBeFocused()
      // The request WAS made and answered 500; the candidate is told nothing about it.
      await expect.poll(() => api.suspends().length).toBe(1)
      await expect(page.getByTestId('error-screen')).toHaveCount(0)
      await expect(page.getByRole('alert')).toHaveCount(0)
      expect(await page.evaluate((key) => localStorage.getItem(key), SESSION_KEY)).toBe(stored)
      expect(api.ends()).toBe(0)

      // The next /start tears the stale provider session down server-side, so Resume works.
      await page.getByRole('button', { name: /resume/i }).click()
      await expect(page.getByTestId('call-question')).toBeVisible({ timeout: 15000 })
      expect(api.starts()).toBe(2)
    })

    test('a failed /start on Resume lands on the retryable error screen and keeps the session', async ({
      page,
    }) => {
      const api = await mockCallApi(page)
      await goLive(page)
      const stored = await page.evaluate((key) => localStorage.getItem(key), SESSION_KEY)
      expect(stored).not.toBeNull()

      await page.getByTestId('call-exit').click()
      await page.getByTestId('call-exit-confirm').click()
      await expect(page.getByRole('heading', { name: /interview suspended/i })).toBeVisible()

      api.failNext('start')
      await page.getByRole('button', { name: /resume/i }).click()

      // Not a blank page, not a dead suspended screen: the error screen with its retry.
      const error = page.getByTestId('error-screen')
      await expect(error).toBeVisible({ timeout: 15000 })
      await expect(error).toContainText('An error occurred')
      await expect(page.getByTestId('retry-button')).toBeVisible()
      await expect(page.getByTestId('call-question')).toHaveCount(0)
      expect(api.starts()).toBe(2)

      // `error` is retryable: the stored session survives it and the page did not leave.
      expect(await page.evaluate((key) => localStorage.getItem(key), SESSION_KEY)).toBe(stored)
      expect(new URL(page.url()).pathname).toMatch(/\/interview\//)
      expect(api.ends()).toBe(0)

      // Retry goes back through /start, which now answers: the call is back.
      await page.getByTestId('retry-button').click()
      await expect(page.getByTestId('call-question')).toBeVisible({ timeout: 15000 })
      expect(api.starts()).toBe(3)
    })
  })

  test.describe('the help link', () => {
    test('an https support page opens in a new tab and says so', async ({ page }) => {
      await mockCallApi(page)
      await goLive(page)

      const help = page.getByTestId('call-help-link')
      await expect(help).toHaveAttribute('href', SUPPORT_URL)
      await expect(help).toHaveAttribute('target', '_blank')
      await expect(help).toHaveAttribute('rel', 'noopener noreferrer')
      await expect(help.locator('.sr-only')).toHaveText('(opens in a new tab)')
    })

    test('a mailto: target opens no tab and has no new-tab note', async ({ page }) => {
      // The server's configured URL is https:. The first document is rewritten so
      // the app boots as a deployment with no support URL configured, which falls
      // back to the shipped mailbox; nothing else about the page changes.
      // The rewrite must have matched: a silent no-op would leave the https URL in
      // place and this test would fail later with a misleading attribute message.
      const rewrite = { documents: 0, changed: 0, literalGone: 0 }
      await page.route('**/en/interview/*', async (route) => {
        if (route.request().resourceType() !== 'document') return route.fallback()
        const response = await route.fetch()
        const original = await response.text()
        const body = original.replace(`supportUrl:"${SUPPORT_URL}"`, 'supportUrl:""')
        rewrite.documents += 1
        if (body !== original) rewrite.changed += 1
        if (!body.includes(SUPPORT_URL)) rewrite.literalGone += 1
        const {
          'content-length': _length,
          'content-encoding': _encoding,
          ...headers
        } = response.headers()
        return route.fulfill({ response, body, headers })
      })
      await mockCallApi(page)
      await goLive(page)

      expect(rewrite.documents, 'no SSR document was intercepted').toBeGreaterThan(0)
      expect(rewrite.changed, 'the SSR document no longer carries supportUrl:"..."').toBe(
        rewrite.documents
      )
      expect(rewrite.literalGone, 'the https support URL is still in the document').toBe(
        rewrite.documents
      )
      const help = page.getByTestId('call-help-link')
      await expect(help).toHaveAttribute('href', /^mailto:/)
      await expect(help).not.toHaveAttribute('target', /.*/)
      await expect(help).not.toHaveAttribute('rel', /.*/)
      await expect(help.locator('.sr-only')).toHaveCount(0)
    })
  })

  test('Tab visits Captions, Microphone, Exit, the question, then the help link, never the self-view', async ({
    page,
    browserName,
  }) => {
    await mockCallApi(page)
    await goLive(page)

    // WebKit's plain Tab skips buttons AND links (observed: it stops only on the
    // scrollable question band) unless the system's "Press Tab to highlight each
    // item" is on; Option+Tab always visits every control. That is the platform's
    // default, not the stage's order, so WebKit is read with the modifier.
    const next = browserName === 'webkit' ? 'Alt+Tab' : 'Tab'
    const visited: string[] = []

    // Start from the top of the page the same way in every engine: WebKit would otherwise
    // resume from the question band that took focus at the competency start and wrap round.
    await page.getByTestId('call-header-title').click()

    for (let i = 0; i < 8; i++) {
      await page.keyboard.press(next)
      const where = await page.evaluate(() => {
        const el = document.activeElement
        if (!el || el === document.body) return 'body'
        if (el.closest('[data-slot="call-stage-self"]')) return 'SELF-VIEW'
        return el.getAttribute('data-testid') ?? el.tagName.toLowerCase()
      })
      visited.push(where)
    }

    expect(visited).not.toContain('SELF-VIEW')
    expect(visited).not.toContain('video')

    const order = [
      'call-header-captions',
      'call-header-mic',
      'call-exit',
      'call-question',
      'call-help-link',
    ].map((id) => visited.indexOf(id))
    expect(
      order.every((index) => index >= 0),
      `visited: ${visited.join(' > ')}`
    ).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))

    // The camera tile is inert in the DOM as well.
    await expect(page.locator('[data-slot="call-stage-self"] video')).toHaveAttribute(
      'tabindex',
      '-1'
    )
  })

  test.describe('reduced motion', () => {
    test.describe('reduce', () => {
      test.use({ contextOptions: { reducedMotion: 'reduce' } })

      test('the ring has no transition', async ({ page }) => {
        await mockCallApi(page)
        await goLive(page)

        const duration = await interviewerTile(page).evaluate(
          (el) => getComputedStyle(el).transitionDuration
        )
        expect(duration).toBe('0s')
      })
    })

    test.describe('no preference (control)', () => {
      test.use({ contextOptions: { reducedMotion: 'no-preference' } })

      test('the ring eases in over 150 ms', async ({ page }) => {
        await mockCallApi(page)
        await goLive(page)

        const duration = await interviewerTile(page).evaluate(
          (el) => getComputedStyle(el).transitionDuration
        )
        expect(duration).toBe('0.15s')
      })
    })
  })

  test('focus moves to the question band once per competency boundary, never per utterance', async ({
    page,
  }) => {
    const api = await mockCallApi(page)
    await goLive(page)
    const band = page.getByTestId('call-question')

    await page.evaluate(() => {
      const win = window as unknown as Record<string, number>
      win['__bandFocused'] = 0
      document.addEventListener(
        'focusin',
        (event) => {
          if ((event.target as Element).matches('[data-testid="call-question"]')) {
            win['__bandFocused'] = (win['__bandFocused'] ?? 0) + 1
          }
        },
        true
      )
    })
    const bandFocusCount = () =>
      page.evaluate(() => (window as unknown as Record<string, number>)['__bandFocused'] ?? 0)

    // The start of the interview is not a boundary.
    await say(page, 'First question.')
    await expect(band).toContainText('First question.')
    expect(await bandFocusCount()).toBe(0)

    // The next competency: /start answers with a new session id.
    api.startNextWith(2, 'COL')
    await drive(page, 'emitEndPhrase')

    await expect(band).toBeFocused({ timeout: 15000 })
    await expect(page.getByTestId('call-question-hint')).toBeVisible()
    expect(await bandFocusCount()).toBe(1)

    // A later utterance, with focus elsewhere, does not drag it back.
    await page.getByTestId('call-exit').focus()
    await say(page, 'Second question.')
    await expect(band).toContainText('Second question.')
    await expect(page.getByTestId('call-exit')).toBeFocused()
    expect(await bandFocusCount()).toBe(1)
  })

  test('a muted microphone shows the badge, and its Unmute action opens the microphone and removes it', async ({
    page,
  }) => {
    await mockCallApi(page)
    await goLive(page)
    const mic = page.getByTestId('call-header-mic')
    const badge = page.getByTestId('call-mic-muted-badge')
    await expect(badge).toHaveCount(0)

    await mic.click()
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('interviewer')

    await page.getByTestId('call-mic-muted-unmute').click()
    await expect(badge).toHaveCount(0)
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
  })

  test('a muted microphone stays muted across a competency boundary, and an open one stays open', async ({
    page,
  }) => {
    const api = await mockCallApi(page)
    await goLive(page)
    const mic = page.getByTestId('call-header-mic')
    await expect(mic).toHaveAttribute('aria-pressed', 'true')

    // Open: the boundary mutes it for its duration and gives it back as it was. The /start is
    // held so the forced-mute window is observed (disabled), not raced past.
    const releaseFirst = api.holdStart()
    api.startNextWith(2, 'COL')
    await drive(page, 'emitEndPhrase')
    await expect(mic).toHaveAttribute('aria-disabled', 'true', { timeout: 15000 })
    releaseFirst()
    await expect.poll(() => api.starts(), { timeout: 15000 }).toBe(2)
    await expect(mic).not.toHaveAttribute('aria-disabled', 'true', { timeout: 15000 })
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    // The boundary cleared the end phrase: the next competency's player is the live one only now.
    await expect(page.getByTestId('call-question-hint')).toBeVisible()

    // Muted by the candidate: still muted, still pressed-off, after the next boundary.
    await mic.click()
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    const releaseSecond = api.holdStart()
    api.startNextWith(3, 'LRN')
    await drive(page, 'emitEndPhrase')
    await expect(mic).toHaveAttribute('aria-disabled', 'true', { timeout: 15000 })
    releaseSecond()
    await expect.poll(() => api.starts(), { timeout: 15000 }).toBe(3)
    await expect(mic).not.toHaveAttribute('aria-disabled', 'true', { timeout: 15000 })
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
  })
})

for (const [label, colour] of [
  ['light #ffd400', '#ffd400'],
  ['dark #771aaf', '#771aaf'],
] as const) {
  test.describe(`the call screen is legible (axe) on the client colour — ${label}`, () => {
    test('live screen, open exit dialog and suspended screen', async ({ page }) => {
      await mockCallApi(page, colour)
      await goLive(page)

      await checkA11y(page)

      await page.getByTestId('call-exit').click()
      await expect(page.getByRole('dialog', { name: /leave the interview/i })).toBeVisible()
      await checkA11y(page)

      await page.getByTestId('call-exit-confirm').click()
      await expect(page.getByRole('heading', { name: /interview suspended/i })).toBeVisible()
      await checkA11y(page)
    })

    test('the full panel: answer bar, progress and duration; the competency list is hidden', async ({
      page,
    }) => {
      const api = await mockCallApi(page, colour)
      await goLiveFullPanel(page, api)
      await expect(page.getByTestId('call-answer-bar')).toBeVisible()
      await expect(page.getByTestId('call-panel-progress')).toBeVisible()
      await expect(page.getByTestId('call-storyboard')).toBeHidden()
      await expect(page.getByTestId('call-panel-duration')).toBeVisible()

      await checkA11y(page)
    })

    test('live screen with a caption, then with captions off', async ({ page }) => {
      await mockCallApi(page, colour)
      await goLive(page)
      await say(page, 'Tell me about a time you led a change.')
      await expect(page.getByTestId('call-question-speaker')).toBeVisible()
      await checkA11y(page)

      await page.getByTestId('call-header-captions').click()
      await checkA11y(page)
    })
  })
}

/** The captions overlay (live-interview-call-chrome D8, D17): off hides every visible word. */
test.describe('captions', () => {
  const FIRST_QUESTION = 'Tell me about a change you led.'

  test('the overlay sits on the interviewer tile, clear of the name chip and the own tile', async ({
    page,
  }) => {
    await mockCallApi(page)
    await goLive(page)
    await say(page, FIRST_QUESTION)

    const layer = await boxOf(page.locator('[data-slot="avatar-layer"]'))
    const overlay = await boxOf(page.getByTestId('call-question'))
    const own = await boxOf(page.locator('[data-slot="call-stage-self"]'))
    const chip = await boxOf(
      page.locator(
        '[data-slot="avatar-layer"] > [data-slot="call-tile"] [data-slot="call-tile-name"]'
      )
    )

    expect(overlay.left).toBeGreaterThanOrEqual(layer.left)
    expect(overlay.bottom).toBeLessThanOrEqual(layer.bottom)
    expect(overlay.right, 'clear of the own tile').toBeLessThanOrEqual(own.left)
    // The own tile is an overlay INSIDE the interviewer tile, bottom right, with a margin.
    expect(own.left).toBeGreaterThanOrEqual(layer.left)
    expect(own.top).toBeGreaterThanOrEqual(layer.top)
    expect(own.right, 'margin from the right edge').toBeLessThan(layer.right)
    expect(own.bottom, 'margin from the bottom edge').toBeLessThan(layer.bottom)
    expect(layer.right - own.right, 'bottom-right corner').toBeLessThan(24)
    expect(layer.bottom - own.bottom, 'bottom-right corner').toBeLessThan(24)
    expect(overlay.bottom, 'above the name chip').toBeLessThanOrEqual(chip.top)
    await expect(page.getByTestId('call-question-speaker')).toHaveText('AI interviewer:')
  })

  test('off hides every visible word but keeps the live region, and the choice is remembered', async ({
    page,
    context,
  }) => {
    await mockCallApi(page)
    await goLive(page)
    await say(page, FIRST_QUESTION)
    const region = page.getByRole('region', { name: 'Current question' })
    await expect(region).toContainText(FIRST_QUESTION)

    await page.getByTestId('call-header-captions').click()
    await expect(page.getByTestId('call-header-captions')).toHaveAttribute('aria-pressed', 'false')

    // Still in the accessibility tree and still written to, but nothing is drawn.
    await expect(region).toHaveCount(1)
    await expect(region).toContainText(FIRST_QUESTION)
    const box = await boxOf(page.getByTestId('call-question'))
    expect(box.right - box.left).toBeLessThanOrEqual(1)
    expect(box.bottom - box.top).toBeLessThanOrEqual(1)
    await expect(page.getByTestId('call-question')).not.toHaveAttribute('tabindex', /.*/)
    await say(page, 'A follow-up question.')
    await expect(region).toContainText('A follow-up question.')
    await expect(page.locator('[aria-live="polite"][aria-atomic="true"]')).toHaveCount(1)

    // A fresh page of the same browser context starts with captions off.
    const again = await context.newPage()
    await mockCallApi(again)
    await goLive(again)
    await expect(again.getByTestId('call-header-captions')).toHaveAttribute('aria-pressed', 'false')
    const hidden = await boxOf(again.getByTestId('call-question'))
    expect(hidden.right - hidden.left).toBeLessThanOrEqual(1)

    // And turning them back on shows the overlay again.
    await again.getByTestId('call-header-captions').click()
    const shown = await boxOf(again.getByTestId('call-question'))
    expect(shown.right - shown.left).toBeGreaterThan(100)
  })

  test('off does not move focus to the captions at a competency boundary', async ({ page }) => {
    const api = await mockCallApi(page)
    await goLive(page)
    await page.getByTestId('call-header-captions').click()

    api.startNextWith(2, 'COL')
    await drive(page, 'emitEndPhrase')
    await expect.poll(() => api.starts(), { timeout: 15000 }).toBe(2)
    await expect(page.getByTestId('call-panel-progress')).toBeVisible({ timeout: 15000 })

    await expect(page.getByTestId('call-question')).not.toBeFocused()
  })
})

// Served by the playwright.config.ts instance wired to the frame-policy stub: framing
// needs a CSP middleware that can resolve an allowed host.
const EMBED_SERVER = 'http://127.0.0.1:4176'

test.describe('inside the embed iframe', () => {
  test.use({ baseURL: EMBED_SERVER })
  const HOST = 'http://localhost:4175'

  interface EmbedMessage {
    type: string
    payload?: { height?: number; index?: number; total?: number }
  }

  test('the stage renders, question:changed is posted and the posted height settles', async ({
    page,
    baseURL,
  }) => {
    // The embed server's own origin, from the describe's baseURL, so the port lives in one place.
    const EMBED_SRC = new URL('/en/embed/allowed-token', baseURL).toString()
    const api = await mockCallApi(page)

    await mockEmbedRoutes(page)

    // The HOST side of the contract. It records every message from the iframe, and
    // does what a real host does with `resize`: sets the iframe to that height. That
    // is the feedback loop the stage must not feed.
    await page.addInitScript(() => {
      if (window.parent !== window) return
      const win = window as unknown as Record<string, unknown[]>
      win['__embedMessages'] = []
      window.addEventListener('message', (event) => {
        const data = event.data as { source?: string; type?: string; payload?: { height?: number } }
        if (data?.source !== 'beai-embed') return
        win['__embedMessages']!.push(data)
        if (data.type === 'resize' && data.payload?.height) {
          const frame = document.querySelector('iframe')
          if (frame) frame.style.height = `${data.payload.height}px`
        }
      })
    })

    const embedded = page.frameLocator('iframe')
    await reachLiveCall(embedded, () =>
      page.goto(`${HOST}/host?src=${encodeURIComponent(EMBED_SRC)}`)
    )

    // The stage, not the old screen, inside the frame.
    await expect(embedded.locator('[data-slot="call-layout"]')).toHaveAttribute(
      'data-embedded',
      'true'
    )
    await expect(embedded.getByTestId('call-panel')).toBeVisible()
    await expect(embedded.getByRole('button', { name: /^pause$/i })).toHaveCount(0)
    expect(api.starts()).toBe(1)

    const messages = () =>
      page.evaluate(
        () => (window as unknown as Record<string, EmbedMessage[]>)['__embedMessages'] ?? []
      )

    // question:changed is still posted when the first competency starts...
    const questionChanges = async () =>
      (await messages()).filter((m) => m.type === 'question:changed').map((m) => m.payload)
    await expect.poll(questionChanges).toEqual([{ index: 0, total: 0 }])

    // ...and at the next boundary, with the server's progress this time.
    api.startNextWith(2, 'COL')
    const frame = page.frames().find((candidate) => candidate.url().includes('/embed/'))!
    await callProvider(frame, 'emitEndPhrase')
    await expect.poll(questionChanges, { timeout: 15000 }).toEqual([
      { index: 0, total: 0 },
      { index: 1, total: 3 },
    ])
    await expect(embedded.getByTestId('call-question')).toBeFocused()

    // ...and the height settles: no new resize is posted over a quiet window, and
    // the last one posted is the frame's real height, so the host has nothing left
    // to correct. (Two CONSECUTIVE posts are never equal by design: the page does
    // not post an unchanged height.)
    //
    // No fixed sleeps. Quiescence is established in two steps:
    //   1. the posted count must be unchanged across STABLE_POLLS consecutive
    //      polls (a retrying condition, so a slow host just polls longer);
    //   2. then a window counted in ANIMATION FRAMES of the host page, not
    //      milliseconds. The loop this guards against is host sets the frame height,
    //      the frame re-lays out, its observer re-posts, which happens within a frame
    //      or two of the previous message, so FRAMES_QUIET frames with no new
    //      message rule it out whatever the host's speed (a slow host runs fewer
    //      frames per second and so waits longer, never shorter).
    const STABLE_POLLS = 5
    const FRAMES_QUIET = 60
    const resizeHeights = async () =>
      (await messages()).filter((m) => m.type === 'resize').map((m) => m.payload?.height ?? 0)

    let lastCount = -1
    let stablePolls = 0
    await expect
      .poll(
        async () => {
          const count = (await resizeHeights()).length
          stablePolls = count === lastCount ? stablePolls + 1 : 0
          lastCount = count
          return stablePolls
        },
        { intervals: [100], timeout: 15000 }
      )
      .toBeGreaterThanOrEqual(STABLE_POLLS)

    const before = await resizeHeights()
    await page.evaluate(
      (frames) =>
        new Promise<void>((resolve) => {
          const tick = (left: number) =>
            left === 0 ? resolve() : requestAnimationFrame(() => tick(left - 1))
          tick(frames)
        }),
      FRAMES_QUIET
    )
    const after = await resizeHeights()

    expect(before.length).toBeGreaterThan(0)
    expect(after, `heights posted: ${after.join(', ')}`).toEqual(before)

    const frameHeight = await embedded
      .locator('html')
      .evaluate((root) => Math.ceil(root.scrollHeight))
    expect(after.at(-1)).toBe(frameHeight)
  })
})

/** The embed exchange, and the frame policy the embedded page asks for client-side. */
async function mockEmbedRoutes(page: Page): Promise<void> {
  await page.route('**/api/embed/exchange*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: candidateJwt() }),
    })
  )
  await page.route('**/api/embed/frame-policy*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ allowed_domains: ['localhost:4175'] }),
    })
  )
}

/** Where an element sits, in the coordinates of the page that hosts it. */
interface Box {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

async function boxOf(target: Locator): Promise<Box> {
  // The rect in the element's OWN viewport, so a frame's offset in its host never leaks in.
  const rect = await target.evaluate((el) => {
    const { left, top, right, bottom, width, height } = el.getBoundingClientRect()
    return { left, top, right, bottom, width, height }
  })
  expect(rect.width, 'the element has no width: it is not rendered').toBeGreaterThan(0)
  return rect
}

/** How far a document's content reaches past its viewport, per axis (0 or less: it fits). */
async function overflowOf(root: Pick<Page, 'locator'>): Promise<{ x: number; y: number }> {
  return root.locator('html').evaluate((el) => ({
    x: el.scrollWidth - el.clientWidth,
    y: el.scrollHeight - el.clientHeight,
  }))
}

/**
 * The live call after the first competency ended: the server has now stated a total, so
 * the panel carries every section it ever shows (progress, duration, counter, Exit, help),
 * the tallest it gets. The question is a realistic three-line one that fits one caption page
 * (a longer utterance is paged, so one full page is the tallest the overlay gets).
 */
async function goLiveFullPanel(page: Page, api: CallApi): Promise<void> {
  await goLive(page)
  api.startNextWith(2, 'COL')
  await drive(page, 'emitEndPhrase')
  await expect.poll(() => api.starts(), { timeout: 15000 }).toBe(2)
  await expect(page.getByTestId('call-panel-progress')).toBeVisible({ timeout: 15000 })
  // The boundary cleared the end phrase: only then is the next utterance the question.
  await expect(page.getByTestId('call-question-hint')).toBeVisible()
  await say(
    page,
    'Tell me about a time you had to change your approach mid-project: what made you see it, and what would you do differently today?'
  )
  await expect(page.getByTestId('call-question')).toContainText('what would you do differently')
}

/**
 * The stage is on screen, not merely un-scrollable: the canvas clips what it overflows, so
 * a stage pushed wider than the viewport would leave the document with no scrollbar and
 * the panel cut off.
 */
async function expectStageInViewport(root: Pick<Page, 'getByTestId' | 'locator'>): Promise<void> {
  const viewport = await root.locator('html').evaluate((el) => ({ width: el.clientWidth }))
  for (const target of [
    root.locator('[data-slot="avatar-layer"]'),
    root.getByTestId('call-question'),
    root.getByTestId('call-panel'),
  ]) {
    const box = await boxOf(target)
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(viewport.width)
  }
}

test.describe('the call stage fits the viewport', () => {
  const HOSTED = [
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ] as const

  for (const [width, height] of HOSTED) {
    test(`hosted at ${width}x${height}: nothing scrolls, either way`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      const api = await mockCallApi(page)
      await goLiveFullPanel(page, api)

      // Polled: the tile's aspect box and the font settle a frame or two after mount.
      await expect.poll(() => overflowOf(page), { timeout: 8000 }).toEqual({ x: 0, y: 0 })
      await expectStageInViewport(page)
      // The whole stage, not only the document: the Exit control is reachable on screen.
      const exit = await boxOf(page.getByTestId('call-exit'))
      expect(exit.bottom).toBeLessThanOrEqual(height)
      const question = await boxOf(page.getByTestId('call-question'))
      expect(question.bottom).toBeLessThanOrEqual(height)
    })
  }

  test('1440x900: two columns, the panel beside the tile and 22 rem wide', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const api = await mockCallApi(page)
    await goLiveFullPanel(page, api)

    const layer = await boxOf(page.locator('[data-slot="avatar-layer"]'))
    const question = await boxOf(page.getByTestId('call-question'))
    const panel = await boxOf(page.getByTestId('call-panel'))
    expect(panel.left).toBeGreaterThanOrEqual(layer.right)
    expect(panel.left).toBeGreaterThanOrEqual(question.right)
    expect(Math.abs(panel.top - layer.top)).toBeLessThanOrEqual(1)
    expect(Math.round(panel.width)).toBe(352)
    // Exit lives in the call header, above the whole stage, not in the panel.
    const exit = await boxOf(page.getByTestId('call-exit'))
    expect(exit.bottom).toBeLessThanOrEqual(layer.top)
    await expect(page.getByTestId('call-panel').getByTestId('call-exit')).toHaveCount(0)
  })

  for (const [width, height] of HOSTED) {
    test(`hosted at ${width}x${height}: the panel takes the row, shows every section and clips nothing`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height })
      const api = await mockCallApi(page)
      await goLiveFullPanel(page, api)
      await expect.poll(() => overflowOf(page), { timeout: 8000 }).toEqual({ x: 0, y: 0 })

      const layer = await boxOf(page.locator('[data-slot="avatar-layer"]'))
      const panel = await boxOf(page.getByTestId('call-panel'))
      // The panel is exactly as tall as the video (top and bottom edges aligned) and never taller than the screen.
      expect(Math.abs(panel.height - layer.height)).toBeLessThanOrEqual(1)
      expect(panel.bottom).toBeLessThanOrEqual(height)
      for (const id of ['call-panel-answer', 'call-panel-path', 'call-panel-duration']) {
        await expect(page.getByTestId(id)).toBeVisible()
      }
      // The help link is the last thing in the panel. The panel is exactly the video's height, so a
      // short window scrolls it inside; once scrolled to, the link must sit inside the panel and on
      // screen: nothing above it pushed the column past its bottom edge.
      await page.getByTestId('call-help-link').scrollIntoViewIfNeeded()
      const help = await boxOf(page.getByTestId('call-help-link'))
      // A scroll position is a whole pixel while the content is fractional: allow that sub-pixel.
      expect(help.bottom).toBeLessThanOrEqual(panel.bottom + 1)
      expect(help.bottom).toBeLessThanOrEqual(height)
      // The help link spans the panel's inner width (a full-width button-looking link).
      expect(help.width).toBeGreaterThan(panel.width / 2)
      const path = await boxOf(page.getByTestId('call-panel-path'))
      expect(path.bottom).toBeLessThanOrEqual(panel.bottom)
    })
  }

  test('1100x800: one column, the panel is a strip under the tile', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 })
    const api = await mockCallApi(page)
    await goLiveFullPanel(page, api)

    await expect.poll(() => overflowOf(page), { timeout: 8000 }).toMatchObject({ x: 0 })
    await expectSingleColumn(page, { rows: true })
  })

  test('1024x768: one column, the strip shows the same sections and nothing overflows sideways', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    const api = await mockCallApi(page)
    await goLiveFullPanel(page, api)

    await expect.poll(() => overflowOf(page), { timeout: 8000 }).toMatchObject({ x: 0 })
    await expectSingleColumn(page, { rows: true })
    for (const id of ['call-panel-answer', 'call-panel-path', 'call-panel-duration']) {
      await expect(page.getByTestId(id)).toBeVisible()
    }
    await expect(page.getByTestId('call-help-link')).toBeVisible()
  })

  test.describe('embedded', () => {
    test.use({ baseURL: EMBED_SERVER })

    test('embedded in a 1280 px container: two columns, and the panel scrolls rather than overflowing', async ({
      page,
      baseURL,
    }) => {
      const embedSrc = new URL('/en/embed/allowed-token', baseURL).toString()
      const api = await mockCallApi(page)
      await mockEmbedRoutes(page)
      await page.addInitScript(() => {
        if (window.parent !== window) {
          Object.defineProperty(window.screen, 'width', { get: () => 1440 })
          return
        }
        // The frame is exactly as wide as the `xl` breakpoint, where the stage is two columns
        // and the 16:9 tile alone sets the row height.
        new MutationObserver(() => {
          const frame = document.querySelector('iframe')
          if (frame) frame.setAttribute('width', '1280')
        }).observe(document, { childList: true, subtree: true })
      })

      const embedded = page.frameLocator('iframe')
      await reachLiveCall(embedded, () =>
        page.goto(`http://localhost:4175/host?src=${encodeURIComponent(embedSrc)}`)
      )
      expect(await page.locator('iframe').evaluate((frame) => frame.clientWidth)).toBe(1280)

      api.startNextWith(2, 'COL')
      const frame = page.frames().find((candidate) => candidate.url().includes('/embed/'))!
      await callProvider(frame, 'emitEndPhrase')
      await expect(embedded.getByTestId('call-panel-progress')).toBeVisible({ timeout: 15000 })
      // A 125% browser text size: the rem-sized panel grows while the 16:9 tile gets no taller,
      // which is where the fixed sections can outgrow the row the tile sets.
      await embedded.locator('html').evaluate((root) => (root.style.fontSize = '20px'))

      await expect(async () => {
        const layer = await boxOf(embedded.locator('[data-slot="avatar-layer"]'))
        const cell = embedded.locator('[data-slot="call-stage-panel"]')
        const cellBox = await boxOf(cell)
        expect(cellBox.left, 'two columns: the panel is beside the tile').toBeGreaterThanOrEqual(
          layer.right
        )
        expect(cellBox.bottom, 'the panel cell never outgrows the tile row').toBeLessThanOrEqual(
          layer.bottom + 1
        )
        const fit = await embedded.getByTestId('call-panel').evaluate((el) => ({
          overflowing: el.scrollHeight > el.clientHeight + 1,
          overflowY: getComputedStyle(el).overflowY,
        }))
        // Content taller than the panel is only acceptable when the panel scrolls it.
        if (fit.overflowing) expect(['auto', 'scroll']).toContain(fit.overflowY)
      }).toPass({ timeout: 8000 })

      // Whatever its height, the last thing in the panel is reachable inside the panel.
      const help = embedded.getByTestId('call-help-link')
      await help.scrollIntoViewIfNeeded()
      const panelBox = await boxOf(embedded.getByTestId('call-panel'))
      const helpBox = await boxOf(help)
      expect(helpBox.top).toBeGreaterThanOrEqual(panelBox.top - 1)
      expect(helpBox.bottom).toBeLessThanOrEqual(panelBox.bottom + 1)
    })

    test('embedded in a 480 px container: one column, a strip, and no horizontal scroll', async ({
      page,
      baseURL,
    }) => {
      const embedSrc = new URL('/en/embed/allowed-token', baseURL).toString()
      const api = await mockCallApi(page)
      await mockEmbedRoutes(page)
      await page.addInitScript(() => {
        // Inside the frame the SA-11 gate judges `screen.width`. The pinned Linux WebKit
        // answered a 480 px frame with the unsupported screen, so the host's desktop screen
        // is stated outright instead of left to the engine.
        if (window.parent !== window) {
          Object.defineProperty(window.screen, 'width', { get: () => 1440 })
          return
        }
        // The host page frames the embed at 1100 px. Narrow the frame the moment it is
        // inserted, before the embedded document lays out, so the stage is never built wide.
        new MutationObserver(() => {
          const frame = document.querySelector('iframe')
          if (frame) frame.setAttribute('width', '480')
        }).observe(document, { childList: true, subtree: true })
      })

      const embedded = page.frameLocator('iframe')
      await reachLiveCall(embedded, () =>
        page.goto(`http://localhost:4175/host?src=${encodeURIComponent(embedSrc)}`)
      )
      expect(await page.locator('iframe').evaluate((frame) => frame.clientWidth)).toBe(480)

      api.startNextWith(2, 'COL')
      const frame = page.frames().find((candidate) => candidate.url().includes('/embed/'))!
      await callProvider(frame, 'emitEndPhrase')
      await expect(embedded.getByTestId('call-panel-progress')).toBeVisible({ timeout: 15000 })

      await expect.poll(() => overflowOf(embedded), { timeout: 8000 }).toMatchObject({ x: 0 })
      // The host page did not grow a scrollbar around the frame either.
      expect((await overflowOf(page)).x).toBeLessThanOrEqual(0)
      // Settled, not sampled once: the host grows the frame from each `resize` message, and a
      // read taken while the frame is still catching up (the container saw the stage scrolled
      // out of the frame's top) is a measurement of a layout that is not done yet.
      await expect(async () => expectSingleColumn(embedded, { rows: false })).toPass({
        timeout: 8000,
      })
    })
  })
})

/**
 * One column, the panel under the interviewer tile and as wide as the column. `rows`
 * adds what makes it a strip rather than a card: the sections are laid out side by side
 * (the path beside the answer time) instead of one per line, which is what the
 * two-column panel does.
 */
async function expectSingleColumn(
  root: Pick<Page, 'getByTestId' | 'locator'>,
  { rows }: { rows: boolean }
): Promise<void> {
  await expectStageInViewport(root)
  const layer = await boxOf(root.locator('[data-slot="avatar-layer"]'))
  const question = await boxOf(root.getByTestId('call-question'))
  const panel = await boxOf(root.getByTestId('call-panel'))
  expect(panel.top, 'the panel is under the tile').toBeGreaterThanOrEqual(layer.bottom)
  expect(Math.abs(panel.left - layer.left), 'same column').toBeLessThanOrEqual(1)
  expect(Math.abs(panel.width - layer.width), 'as wide as the column').toBeLessThanOrEqual(1)
  // The captions are an overlay on the tile: inside it, never outside.
  expect(question.left, 'the captions sit inside the tile').toBeGreaterThanOrEqual(layer.left)
  expect(question.right, 'the captions sit inside the tile').toBeLessThanOrEqual(layer.right)
  expect(question.bottom, 'the captions sit inside the tile').toBeLessThanOrEqual(layer.bottom)

  if (!rows) return
  const answer = await boxOf(root.getByTestId('call-panel-answer'))
  const path = await boxOf(root.getByTestId('call-panel-path'))
  expect(path.top, 'the answer time and the path share a row').toBeLessThan(answer.bottom)
  expect(path.left, 'the path is beside the answer time, not under it').toBeGreaterThanOrEqual(
    answer.right
  )
}

/**
 * The live call, pixel for pixel, at 1440x900 on a light and a dark client colour
 * (design D14, "Visual regression"; DESIGN §7.3). The self-view video is masked (a
 * canvas-backed stream, never the same two frames), and so are the two clocks that
 * count in real time; CSS animations are disabled. Baselines live next to this
 * spec for both browsers, darwin and linux, and are regenerated only in the pinned
 * container (`task e2e:update`).
 */
test.describe('the call stage, pixel for pixel', () => {
  for (const [slug, colour] of [
    ['ffd400', '#ffd400'],
    ['771aaf', '#771aaf'],
  ] as const) {
    test(`1440x900 on ${colour}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      const api = await mockCallApi(page, colour)
      await goLiveFullPanel(page, api)
      // The boundary left the question band focused: its ring is not what is pinned here.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await expect.poll(() => overflowOf(page)).toEqual({ x: 0, y: 0 })

      await expect(page).toHaveScreenshot(`call-stage-${slug}.png`, {
        animations: 'disabled',
        mask: [
          page.locator('[data-slot="call-stage-self"] video'),
          page.getByTestId('call-panel-duration-value'),
          page.getByTestId('call-panel').locator('time'),
        ],
      })
    })
  }
})

/** A candidate JWT the page can decode client-side, as the SSO fixture makes. */
function candidateJwt(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

  return [
    encode({ alg: 'HS256', typ: 'JWT' }),
    encode({
      typ: 'candidate',
      candidate_ref: 'cand-embed-001',
      project_id: 1,
      exp: Math.floor(Date.now() / 1000) + 7200,
    }),
    'e2e-fake-signature',
  ].join('.')
}
