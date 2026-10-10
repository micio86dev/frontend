import { test, expect, type Page } from '@playwright/test'
import { injectDeviceMocks } from './fixtures/device-mocks'

/**
 * Single-session Tavus interview (tavus-single-session-interview, FE-07).
 *
 * One Tavus conversation serves several competencies: the first `/start` is
 * fresh, every later boundary is a `/start` that names the live conversation
 * and gets a `continuation` back, and the browser steers the avatar over the
 * data channel (append, then respond). The API is route-mocked by a tiny
 * stateful server below; the provider is the mock of `app/providers/factory.ts`,
 * whose steering recorder fills `window.__mockSteeringLog`.
 *
 * NOT expressible with route mocks, so not asserted here: the echo filter (the
 * respond trigger's user-role echo never reaching `/utterance`). It lives in
 * `TavusProvider`, behind Daily's data channel, which a browser test cannot
 * reach without a real conversation; the provider unit tests own it.
 */

const CODES = ['COM', 'STG', 'INN'] as const
const CLOSING = 'Thanks, I think that covers it, so shall we move on?'

type MockWin = {
  __mockInterviewProvider: {
    emitEndPhrase: () => void
    emitTranscript: (text: string, role: 'user' | 'avatar') => void
  }
}
type StartBody = { live_conversation_id?: string } | null
type Recorder = {
  starts: StartBody[]
  startReplies: Array<Record<string, unknown>>
  ends: number
  utterances: string[]
}

function b64(input: string): string {
  return Buffer.from(input).toString('base64url')
}

function candidateJwt(): string {
  const exp = Math.floor(Date.now() / 1000) + 7200
  const payload = { typ: 'candidate', candidate_ref: 'cand-ss', project_id: 1, exp }
  return `${b64('{"alg":"HS256","typ":"JWT"}')}.${b64(JSON.stringify(payload))}.sig`
}

/** Stateful stand-in for the interview endpoints: three competencies, one Tavus conversation. */
async function mockApi(page: Page, opts: { ttl?: number; closingDue?: boolean } = {}) {
  const rec: Recorder = { starts: [], startReplies: [], ends: 0, utterances: [] }
  let cursor = 0
  let conversations = 0

  const question = {
    question_index: 0,
    total_questions: 3,
    end_phrase: 'Let us move on to the next question.',
    final_phrase: 'Thank you for your time.',
  }
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })

  await page.route('**/api/sso/exchange*', (r) => r.fulfill(json({ access_token: candidateJwt() })))
  await page.route('**/api/candidate/interview/start', (r) => {
    const body = (r.request().postDataJSON() ?? null) as StartBody
    rec.starts.push(body)
    const base = {
      session_id: cursor + 1,
      provider: 'tavus',
      audio_only: false,
      question_context: { ...question, competency_code: CODES[cursor] },
    }
    const reply = body?.live_conversation_id
      ? {
          ...base,
          continuation: {
            conversation_id: body.live_conversation_id,
            competency_code: CODES[cursor],
          },
        }
      : {
          ...base,
          provider_token: 'tavus-token',
          conversation_url: 'https://tavus.example.test/room',
          conversation_id: `conv-${++conversations}`,
          ...(opts.ttl ? { conversation_ttl_seconds: opts.ttl } : {}),
        }
    rec.startReplies.push(reply)
    return r.fulfill(json(reply, 201))
  })
  await page.route('**/api/candidate/interview/end', (r) => {
    rec.ends++
    cursor++
    return r.fulfill(
      json({ ended_competencies: cursor, total_competencies: 3, next_action: 'continue' })
    )
  })
  await page.route('**/api/candidate/interview/utterance', (r) => {
    const text = (r.request().postDataJSON() as { text: string }).text
    rec.utterances.push(text)
    return r.fulfill(
      json(
        { status: 'ok', ...(opts.closingDue && text === CLOSING ? { boundary_due: true } : {}) },
        202
      )
    )
  })
  for (const name of ['integrity', 'snapshot']) {
    await page.route(`**/api/candidate/interview/${name}`, (r) =>
      r.fulfill(json({ status: 'ok' }, 202))
    )
  }
  await page.route('**/api/candidate/interview/suspend', (r) => r.fulfill(json({ status: 'ok' })))
  return rec
}

const exitButton = (page: Page) =>
  page.getByRole('button', { name: /^exit, you can resume later$/i })

/** From the entry URL to the live call screen. */
async function reachLive(page: Page, url = `/en/interview/tok-ss`) {
  await page.goto(url)
  await page.getByRole('button', { name: /accept and continue/i }).click()
  const start = page.getByRole('button', { name: /start the interview/i })
  await expect(start).toBeEnabled({ timeout: 8000 })
  await start.click()
  await expect(exitButton(page)).toBeVisible({ timeout: 15000 })
}

const steeringLog = (page: Page) =>
  page.evaluate(() =>
    (
      (
        window as unknown as {
          __mockSteeringLog?: Array<{ event_type: string; conversation_id: string }>
        }
      ).__mockSteeringLog ?? []
    ).map((m) => `${m.event_type}@${m.conversation_id}`)
  )

const APPEND = 'conversation.append_llm_context'
const RESPOND = 'conversation.respond'

test.describe('Single-session Tavus interview', () => {
  test.beforeEach(async ({ page }) => {
    await injectDeviceMocks(page)
  })

  test('three competencies: one fresh /start, two continuations, append then respond at each boundary', async ({
    page,
  }) => {
    const rec = await mockApi(page)
    await reachLive(page)
    expect(rec.starts).toEqual([null])

    // First boundary: the avatar says its closing phrase.
    await page.evaluate(() =>
      (window as unknown as MockWin).__mockInterviewProvider.emitEndPhrase()
    )
    await expect.poll(() => rec.starts.length).toBe(2)
    await expect.poll(async () => (await steeringLog(page)).length).toBe(2)

    // Second boundary.
    await page.evaluate(() =>
      (window as unknown as MockWin).__mockInterviewProvider.emitEndPhrase()
    )
    await expect.poll(() => rec.starts.length).toBe(3)
    await expect.poll(async () => (await steeringLog(page)).length).toBe(4)

    // Exactly one fresh /start; the others name the live conversation and got a continuation.
    expect(rec.starts).toEqual([
      null,
      { live_conversation_id: 'conv-1' },
      { live_conversation_id: 'conv-1' },
    ])
    expect(rec.startReplies.map((r) => Boolean(r['continuation']))).toEqual([false, true, true])
    expect(rec.startReplies.map((r) => r['session_id'])).toEqual([1, 2, 3])
    expect(await steeringLog(page)).toEqual([
      `${APPEND}@conv-1`,
      `${RESPOND}@conv-1`,
      `${APPEND}@conv-1`,
      `${RESPOND}@conv-1`,
    ])
    // A continuation never replaces the conversation: still one call screen, still live.
    await expect(exitButton(page)).toBeVisible()
  })

  test('a paraphrased closing line advances through boundary_due, not the end phrase', async ({
    page,
  }) => {
    const rec = await mockApi(page, { closingDue: true })
    await reachLive(page)

    await page.evaluate(
      (text) =>
        (window as unknown as MockWin).__mockInterviewProvider.emitTranscript(text, 'avatar'),
      CLOSING
    )

    await expect.poll(() => rec.starts.length).toBe(2)
    expect(rec.utterances).toContain(CLOSING)
    expect(rec.starts[1]).toEqual({ live_conversation_id: 'conv-1' })
    expect(rec.ends).toBe(1)
    await expect.poll(async () => (await steeringLog(page)).length).toBe(2)
  })

  test('a reload issues a fresh /start without live_conversation_id', async ({ page }) => {
    const rec = await mockApi(page)
    await reachLive(page)
    await page.evaluate(() =>
      (window as unknown as MockWin).__mockInterviewProvider.emitEndPhrase()
    )
    await expect.poll(() => rec.starts.length).toBe(2)

    await page.reload()
    await page.getByRole('button', { name: /accept and continue/i }).click()
    const start = page.getByRole('button', { name: /start the interview/i })
    await expect(start).toBeEnabled({ timeout: 8000 })
    await start.click()
    await expect(exitButton(page)).toBeVisible({ timeout: 15000 })

    expect(rec.starts).toHaveLength(3)
    expect(rec.starts[2]).toBeNull()
    expect(rec.startReplies[2]?.['continuation']).toBeUndefined()
    expect(rec.startReplies[2]?.['conversation_id']).toBe('conv-2')
  })

  test('pause and resume issue a fresh conversation', async ({ page }) => {
    const rec = await mockApi(page)
    await reachLive(page)

    await exitButton(page).click()
    await page.getByRole('button', { name: /^suspend and leave$/i }).click()
    await page.getByRole('button', { name: /^resume$/i }).click()
    await expect(exitButton(page)).toBeVisible({ timeout: 10000 })

    expect(rec.starts).toEqual([null, null])
    expect(rec.startReplies.map((r) => r['conversation_id'])).toEqual(['conv-1', 'conv-2'])
    expect(rec.startReplies.every((r) => r['continuation'] === undefined)).toBe(true)
    expect(await steeringLog(page)).toEqual([])
  })

  test('the ceiling handover replaces the conversation but keeps the competency', async ({
    page,
  }) => {
    // 130 s of life minus the 120 s lead: the age timer fires after 10 s of page time.
    const rec = await mockApi(page, { ttl: 130 })
    await page.clock.install()
    await reachLive(page)
    expect(rec.starts).toEqual([null])

    await page.clock.fastForward(11_000)

    await expect.poll(() => rec.starts.length).toBe(2)
    // Fresh (the old conversation is not asserted as live), on the SAME in_corso row.
    expect(rec.starts[1]).toBeNull()
    expect(rec.startReplies[1]?.['session_id']).toBe(rec.startReplies[0]?.['session_id'])
    expect(rec.startReplies[1]?.['conversation_id']).toBe('conv-2')
    // No boundary: nothing ended, nothing steered, the candidate never left the live screen.
    expect(rec.ends).toBe(0)
    expect(await steeringLog(page)).toEqual([])
    await expect(exitButton(page)).toBeVisible()
  })
})
