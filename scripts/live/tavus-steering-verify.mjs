#!/usr/bin/env node
/**
 * LIVE Tavus steering spike (SPIKE-01, L1-L8). Spends real Tavus credits.
 *
 * Joins ONE existing Tavus conversation as a Daily participant (video off, mic off,
 * headless chromium with fake devices), exercises the data-channel interactions and
 * prints a JSON summary. It never creates or ends a conversation: the caller does
 * that from the api container, so the Tavus key never reaches this process.
 *
 * Usage (run with node; Playwright resolves from frontend/node_modules):
 *   node scripts/live/tavus-steering-verify.mjs --scenario=steer --url=<conversation_url> --id=<conversation_id>
 *   node scripts/live/tavus-steering-verify.mjs --scenario=leave --url=... --id=...
 *   node scripts/live/tavus-steering-verify.mjs --scenario=observe --url=... --id=... --secs=300
 *
 * Scenarios:
 *   steer   respond / append / overwrite schedule (L1-L5), then keeps observing (L6).
 *   leave   joins, hears the greeting, leaves the room (L7: the caller polls the status).
 *   observe joins and only logs (L6 without sending anything).
 *
 * Envelope (documented at docs.tavus.io, Interactions Protocol):
 *   { message_type: 'conversation', event_type, conversation_id, properties: {...} }
 *   sent with call.sendAppMessage(envelope, '*').
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chromium } from '@playwright/test'

const require = createRequire(import.meta.url)
const dailyBundle = readFileSync(require.resolve('@daily-co/daily-js/dist/daily.js'), 'utf8')

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=')
    return [k, v.join('=') || 'true']
  })
)

const scenario = args.scenario ?? 'steer'
const roomUrl = args.url
const conversationId = args.id
const observeSecs = Number(args.secs ?? 300)
const outDir = args.out ?? join(tmpdir(), 'tavus-steering-spike')

if (!roomUrl || !conversationId) {
  console.error('missing --url or --id')
  process.exit(2)
}

const redactId = (s) => (typeof s === 'string' && s.length > 4 ? `***${s.slice(-4)}` : s)

// Tiny secure-context page (localhost) so getUserMedia / WebRTC behave like the app.
const server = createServer((req, res) => {
  if (req.url === '/daily.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end(dailyBundle)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(
    '<!doctype html><html><body><video id="v" autoplay playsinline></video><script src="/daily.js"></script></body></html>'
  )
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://localhost:${server.address().port}`

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
})
const context = await browser.newContext({ permissions: ['microphone', 'camera'] })
const page = await context.newPage()
page.on('pageerror', (e) => console.error('PAGEERROR', String(e).slice(0, 200)))
await page.goto(origin)

// All Daily events are recorded in the page with a host-comparable epoch timestamp.
await page.evaluate(() => {
  window.__log = []
  const push = (ev, data) => window.__log.push({ epoch: Date.now() / 1000, ev, data })
  window.__push = push
  const call = window.Daily.createCallObject({ audioSource: true, videoSource: false })
  window.__call = call
  const events = [
    'loading',
    'loaded',
    'joining-meeting',
    'joined-meeting',
    'left-meeting',
    'error',
    'nonfatal-error',
    'participant-joined',
    'participant-left',
    'participant-updated',
    'track-started',
    'track-stopped',
    'app-message',
    'network-connection',
    'camera-error',
    'meeting-session-state-updated',
    'recording-started',
    'recording-stopped',
    'receive-settings-updated',
    'call-instance-destroyed',
  ]
  for (const ev of events) {
    call.on(ev, (e) => {
      let data
      try {
        if (ev === 'track-started' || ev === 'track-stopped') {
          data = {
            local: e?.participant?.local,
            user_name: e?.participant?.user_name,
            kind: e?.track?.kind,
          }
        } else if (
          ev === 'participant-joined' ||
          ev === 'participant-left' ||
          ev === 'participant-updated'
        ) {
          data = {
            local: e?.participant?.local,
            user_name: e?.participant?.user_name,
            session_id: e?.participant?.session_id?.slice?.(-4),
            reason: e?.reason,
          }
        } else if (ev === 'app-message') {
          data = { fromId: e?.fromId?.slice?.(-4), data: e?.data }
        } else if (ev === 'camera-error' || ev === 'error' || ev === 'nonfatal-error') {
          data = JSON.parse(JSON.stringify(e, (k, v) => (typeof v === 'function' ? undefined : v)))
          if (data?.error?.msg)
            data = { type: data.type ?? data.errorMsg, msg: data.errorMsg ?? data.error?.msg }
        } else {
          data = JSON.parse(JSON.stringify(e ?? null))
        }
      } catch {
        data = String(e)
      }
      push(ev, data)
    })
  }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowSec = () => Date.now() / 1000
const timeline = [] // host-side actions: {epoch, action, ...}
const act = (action, extra = {}) => {
  const rec = { epoch: nowSec(), action, ...extra }
  timeline.push(rec)
  console.log(
    `[action] ${new Date(rec.epoch * 1000).toISOString()} ${action} ${JSON.stringify(extra).slice(0, 200)}`
  )
}

const envelope = (event_type, properties) => ({
  message_type: 'conversation',
  event_type,
  conversation_id: conversationId,
  ...(properties ? { properties } : {}),
})

async function send(label, event_type, properties) {
  const msg = envelope(event_type, properties)
  act(label, { event_type, properties })
  try {
    const r = await page.evaluate((m) => {
      try {
        const ret = window.__call.sendAppMessage(m, '*')
        return { ok: true, ret: ret === undefined ? null : String(ret) }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    }, msg)
    timeline.push({ epoch: nowSec(), action: `${label}:result`, ...r })
    return r
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

const respond = (label, text) => send(label, 'conversation.respond', { text })
const append = (label, context) => send(label, 'conversation.append_llm_context', { context })
const overwrite = (label, context) => send(label, 'conversation.overwrite_llm_context', { context })

const joinStart = nowSec()
act('join', { url: '<redacted>', id: redactId(conversationId) })
let joinResult
try {
  joinResult = await page.evaluate(async (url) => {
    try {
      await window.__call.join({ url, startVideoOff: true, startAudioOff: true })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }, roomUrl)
} catch (e) {
  joinResult = { ok: false, error: String(e) }
}
const joinedAt = nowSec()
act('join:result', { ...joinResult, ms: Math.round((joinedAt - joinStart) * 1000) })

const rel = (epoch) => Number((epoch - joinedAt).toFixed(1))
const sleepUntil = async (secAfterJoin) => {
  const wait = joinedAt + secAfterJoin - nowSec()
  if (wait > 0) await sleep(wait * 1000)
}
const eventsSoFar = async () => page.evaluate(() => window.__log)
const hasEnded = async () =>
  (await eventsSoFar()).some((e) => e.ev === 'left-meeting' || e.ev === 'call-instance-destroyed')

if (joinResult.ok) {
  if (scenario === 'steer') {
    await sleepUntil(15)
    await respond('S1-respond-ready', 'Reply with only the word READY.')
    await sleepUntil(35)
    await append(
      'S2-append-charlie',
      'TOPIC CHARLIE codeword SCARLET. Do not begin TOPIC BRAVO until told by code.'
    )
    // 25 s of deliberate silence: L3 (does append alone make the avatar speak?)
    await sleepUntil(60)
    await respond(
      'S3-respond-charlie-alpha',
      'What is the codeword for TOPIC CHARLIE, and what is the codeword for TOPIC ALPHA?'
    )
    await sleepUntil(82)
    await respond('S4a-respond-begin-bravo-no-code', 'Please begin TOPIC BRAVO.')
    await sleepUntil(102)
    await respond('S4b-respond-code-bravo', 'Code BRAVO.')
    await sleepUntil(122)
    await overwrite('S5-overwrite-delta', 'TOPIC DELTA codeword VIOLET. Say nothing until asked.')
    await sleepUntil(148)
    await respond(
      'S6-respond-delta-alpha',
      'What is the codeword for TOPIC DELTA, and what is the codeword for TOPIC ALPHA? If you do not know one, say unknown.'
    )
    await sleepUntil(175)
    act('scripted-phase-done')
    // keep observing for L6 until the room closes on its own or the cap is reached
    while (nowSec() - joinedAt < observeSecs && !(await hasEnded())) await sleep(1000)
  } else if (scenario === 'observe') {
    while (nowSec() - joinedAt < observeSecs && !(await hasEnded())) await sleep(1000)
  } else if (scenario === 'leave') {
    await sleepUntil(Number(args.leaveAfter ?? 12))
    const leftAt = nowSec()
    act('leave:begin')
    await page.evaluate(async () => {
      try {
        await window.__call.leave()
      } catch (e) {
        window.__push('leave-error', String(e))
      }
    })
    act('leave:done', { leftEpoch: leftAt, ms: Math.round((nowSec() - leftAt) * 1000) })
    await sleep(2000)
  }
}

const log = await eventsSoFar()
await page
  .evaluate(async () => {
    try {
      await window.__call.destroy()
    } catch {
      // already destroyed: nothing to clean up
    }
  })
  .catch(() => {})
await browser.close()
server.close()

// ---- summary -------------------------------------------------------------
const trim = (v, n = 400) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s && s.length > n ? `${s.slice(0, n)}...` : s
}

const appMessages = log
  .filter((e) => e.ev === 'app-message')
  .map((e) => ({ t: rel(e.epoch), data: e.data?.data }))
const utterances = appMessages
  .filter((m) => m.data?.event_type === 'conversation.utterance')
  .map((m) => ({
    t: m.t,
    role: m.data?.properties?.role,
    speech: m.data?.properties?.speech,
    inference_id: redactId(m.data?.inference_id ?? m.data?.properties?.inference_id),
    turn_idx: m.data?.turn_idx ?? m.data?.properties?.turn_idx,
    keys: Object.keys(m.data ?? {}),
    propKeys: Object.keys(m.data?.properties ?? {}),
  }))

const eventTypeCounts = {}
for (const m of appMessages)
  eventTypeCounts[m.data?.event_type ?? 'unknown'] =
    (eventTypeCounts[m.data?.event_type ?? 'unknown'] ?? 0) + 1

const summary = {
  scenario,
  conversation: redactId(conversationId),
  join: { ...joinResult, joinedMs: Math.round((joinedAt - joinStart) * 1000) },
  actions: timeline.map((a) => ({
    t: rel(a.epoch),
    epochAbs: Number(a.epoch.toFixed(2)),
    ...Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'epoch')),
  })),
  eventTypeCounts,
  utterances,
  lifecycle: log
    .filter((e) => !['app-message', 'network-connection'].includes(e.ev))
    .map((e) => ({
      t: rel(e.epoch),
      epochAbs: Number(e.epoch.toFixed(2)),
      ev: e.ev,
      data: trim(e.data, 200),
    })),
  nonUtteranceAppMessages: appMessages
    .filter((m) => m.data?.event_type !== 'conversation.utterance')
    .map((m) => ({ t: m.t, msg: trim(m.data, 500) })),
}

mkdirSync(outDir, { recursive: true })
const file = join(outDir, `${scenario}-${Math.round(joinStart)}.json`)
writeFileSync(file, JSON.stringify({ summary, rawAppMessages: appMessages }, null, 2))
console.log('SUMMARY_JSON_FILE', file)
console.log(JSON.stringify(summary, null, 2))
