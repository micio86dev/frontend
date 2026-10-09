import { test, expect, type Page } from '@playwright/test'
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
  /** The next competency: every `/start` from now on answers with it. */
  startNextWith: (sessionId: number, competency: string) => void
}

/** The branded interview routes, the call-screen media, and the counters the specs read. */
async function mockCallApi(page: Page, primaryColor: string | null = '#771aaf'): Promise<CallApi> {
  await mockBrandedInterview(page, primaryColor)
  await injectCallMedia(page)

  let starts = 0
  let ends = 0
  const suspends: unknown[] = []
  let next = startResponse(1, 'COM')

  // LIFO: registered after the branded fixture's own /start, so these answer.
  await page.route('**/api/candidate/interview/start', (route) => {
    starts += 1
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(next),
    })
  })
  await page.route('**/api/candidate/interview/end', (route) => {
    ends += 1
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
    startNextWith: (sessionId, competency) => {
      next = startResponse(sessionId, competency)
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

type ProviderCall = 'emitSpeaking' | 'emitListening' | 'emitEndPhrase'

/** Drives the newest in-page mock provider. */
async function drive(page: Page, call: ProviderCall): Promise<void> {
  await page.evaluate((method) => {
    const provider = (window as unknown as Record<string, Record<string, () => void>>)[
      '__mockInterviewProvider'
    ]!
    provider[method]!()
  }, call)
}

/** One transcript entry from the newest mock provider: the avatar's unless a role is given. */
async function say(page: Page, text: string, role: 'avatar' | 'user' = 'avatar'): Promise<void> {
  await page.evaluate(
    ({ text: entry, role: speaker }) => {
      const provider = (window as unknown as Record<string, Record<string, unknown>>)[
        '__mockInterviewProvider'
      ]!
      ;(provider['emitTranscript'] as (text: string, role: string) => void)(entry, speaker)
    },
    { text, role }
  )
}

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

    // The avatar yields: its ring is held briefly, then goes out.
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

      await page.waitForTimeout(300)
      expect(api.suspends()).toHaveLength(0)
      expect(api.starts()).toBe(1)
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
      await page.route('**/en/interview/*', async (route) => {
        if (route.request().resourceType() !== 'document') return route.fallback()
        const response = await route.fetch()
        const body = (await response.text()).replace(`supportUrl:"${SUPPORT_URL}"`, 'supportUrl:""')
        const {
          'content-length': _length,
          'content-encoding': _encoding,
          ...headers
        } = response.headers()
        return route.fulfill({ response, body, headers })
      })
      await mockCallApi(page)
      await goLive(page)

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
  const EMBED_SRC = 'http://127.0.0.1:4177/en/embed/allowed-token'

  interface EmbedMessage {
    type: string
    payload?: { height?: number; index?: number; total?: number }
  }

  test('the stage renders, question:changed is posted and the posted height settles', async ({
    page,
  }) => {
    const api = await mockCallApi(page)

    // The embed exchange, and the frame policy the page asks for client-side.
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
    await frame.evaluate(() => {
      const provider = (window as unknown as Record<string, Record<string, () => void>>)[
        '__mockInterviewProvider'
      ]!
      provider['emitEndPhrase']!()
    })
    await expect.poll(questionChanges, { timeout: 15000 }).toEqual([
      { index: 0, total: 0 },
      { index: 1, total: 3 },
    ])
    await expect(embedded.getByTestId('call-question')).toBeFocused()

    // ...and the height settles: no new resize is posted over a quiet window, and
    // the last one posted is the frame's real height, so the host has nothing left
    // to correct. (Two CONSECUTIVE posts are never equal by design: the page does
    // not post an unchanged height.)
    const resizeHeights = async () =>
      (await messages()).filter((m) => m.type === 'resize').map((m) => m.payload?.height ?? 0)
    await page.waitForTimeout(500)
    const before = await resizeHeights()
    await page.waitForTimeout(1500)
    const after = await resizeHeights()

    expect(before.length).toBeGreaterThan(0)
    expect(after, `heights posted: ${after.join(', ')}`).toEqual(before)

    const frameHeight = await embedded
      .locator('html')
      .evaluate((root) => Math.ceil(root.scrollHeight))
    expect(after.at(-1)).toBe(frameHeight)
  })
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
