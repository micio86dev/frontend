import { test, expect, type Frame, type Locator, type Page } from '@playwright/test'
import { checkA11y } from './fixtures/a11y'
import { injectCallMedia, setFakeMicLevel } from './fixtures/device-mocks'
import { mockBrandedInterview } from './fixtures/branded-interview'

/**
 * The candidate call screen, end to end, with `candidateCallUi` switched ON
 * (candidate-interview-call-ui, UI-10).
 *
 * Runs only in the `chromium-call` and `webkit-call` projects, against the third
 * web server of `playwright.config.ts`: the SAME build as the main suite, started
 * with `NUXT_PUBLIC_CANDIDATE_CALL_UI=true`. The main suite keeps testing the old
 * screen until the flag is flipped, so the two never share a server.
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
  await page.route('**/api/candidate/interview/start', (route) => {
    starts += 1
    calls.push('start')
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
  page.locator('[data-slot="avatar-layer"] [data-slot="call-tile"]')
const selfTile = (page: Page) =>
  page.locator('[data-slot="call-stage-self"] [data-slot="call-tile"]')

test.describe('the call stage with candidateCallUi on', () => {
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

  test('Tab visits the question, Exit, then the help link, and never the self-view', async ({
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

    const order = ['call-question', 'call-exit', 'call-help-link'].map((id) => visited.indexOf(id))
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
  })
}

test.describe('inside the embed iframe', () => {
  const HOST = 'http://localhost:4175'

  interface EmbedMessage {
    type: string
    payload?: { height?: number; index?: number; total?: number }
  }

  test('the stage renders, question:changed is posted and the posted height settles', async ({
    page,
    baseURL,
  }) => {
    // The call server's own origin, from the project, so the port lives in one place.
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
 * the tallest it gets. The question is a realistic three-line one.
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
    'Tell me about a time you had to change your approach in the middle of a project. What made you realise it, what did you do next, and what would you do differently today?'
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

  test('1440x900: two columns, the panel beside the tile and 18 rem wide', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const api = await mockCallApi(page)
    await goLiveFullPanel(page, api)

    const layer = await boxOf(page.locator('[data-slot="avatar-layer"]'))
    const question = await boxOf(page.getByTestId('call-question'))
    const panel = await boxOf(page.getByTestId('call-panel'))
    expect(panel.left).toBeGreaterThanOrEqual(layer.right)
    expect(panel.left).toBeGreaterThanOrEqual(question.right)
    expect(Math.abs(panel.top - layer.top)).toBeLessThanOrEqual(1)
    expect(Math.round(panel.width)).toBe(288)
    // Beside the tile the panel's sections are stacked: Exit is below the progress.
    const progress = await boxOf(page.getByTestId('call-panel-progress'))
    const exit = await boxOf(page.getByTestId('call-exit'))
    expect(exit.top).toBeGreaterThanOrEqual(progress.bottom)
  })

  test('1100x800: one column, the panel is a strip under the question band', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 })
    const api = await mockCallApi(page)
    await goLiveFullPanel(page, api)

    await expect.poll(() => overflowOf(page), { timeout: 8000 }).toMatchObject({ x: 0 })
    await expectSingleColumn(page, { rows: true })
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
    await expectSingleColumn(embedded, { rows: false })
  })
})

/**
 * One column, the panel under the question band and as wide as the column. `rows`
 * adds what makes it a strip rather than a card: the sections are laid out in rows
 * (the duration shares a row with the progress) instead of one per line, which is
 * what the two-column panel does.
 */
async function expectSingleColumn(
  root: Pick<Page, 'getByTestId' | 'locator'>,
  { rows }: { rows: boolean }
): Promise<void> {
  await expectStageInViewport(root)
  const layer = await boxOf(root.locator('[data-slot="avatar-layer"]'))
  const question = await boxOf(root.getByTestId('call-question'))
  const panel = await boxOf(root.getByTestId('call-panel'))
  expect(panel.top, 'the panel is under the question band').toBeGreaterThanOrEqual(question.bottom)
  expect(Math.abs(panel.left - question.left), 'same column').toBeLessThanOrEqual(1)
  expect(Math.abs(panel.width - question.width), 'as wide as the column').toBeLessThanOrEqual(1)
  expect(Math.abs(question.width - layer.width), 'the tile is in that column').toBeLessThanOrEqual(
    1
  )

  if (!rows) return
  const progress = await boxOf(root.getByTestId('call-panel-progress'))
  const duration = await boxOf(root.getByTestId('call-panel-duration'))
  expect(duration.top, 'the duration shares a row with the progress').toBeLessThan(progress.bottom)
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
