/**
 * i18n interview flow keys — Task 5.2 RED
 *
 * Asserts all required interview-flow i18n keys are present in both it.json and en.json.
 * Spec: D1, D11, "Flow screens — localized states" requirement.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../')

function loadLocale(locale: string): Record<string, unknown> {
  const raw = readFileSync(resolve(ROOT, `i18n/locales/${locale}.json`), 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

function getNestedKey(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

const REQUIRED_KEYS = [
  'interview.consent.title',
  'interview.consent.body',
  'interview.consent.accept',
  'interview.device_check.title',
  'interview.device_check.camera_ok',
  'interview.device_check.mic_ok',
  'interview.device_check.camera_error',
  'interview.device_check.mic_error',
  'interview.device_check.continue',
  // Slice 5 (device-check-preview-and-device-selection, D11) — instructional
  // copy, mic-meter non-visual equivalent, browser-neutral recovery (D7), and
  // the micUnavailable dead-end fix (D6).
  'interview.device_check.camera_instruction',
  'interview.device_check.mic_instruction',
  'interview.device_check.mic_detected',
  'interview.device_check.mic_unavailable',
  'interview.device_check.recovery_title',
  'interview.device_check.recovery_instructions',
  'interview.device_check.retry',
  'interview.live.timer_label',
  'interview.live.skip',
  'interview.live.pause',
  'interview.end_of_question.title',
  'interview.end_of_question.next',
  'interview.end_of_question.pause',
  'interview.paused.title',
  'interview.paused.resume',
  'interview.done.title',
  'interview.done.body',
  'interview.error.title',
  'interview.error.retry',
  'interview.terminal.403.title',
  'interview.terminal.403.body',
  'interview.terminal.absent_phrase.title',
  'interview.terminal.absent_phrase.body',
  'interview.terminal.absent_phrase.contact',
  // candidate-session-auth Phase 3 (Task 3.5/3.6) — new honest failure copy.
  // session_expired MUST NOT suggest requesting/using a new link will help
  // (D-F) — enforced structurally below, not just by key presence.
  'interview.terminal.session_expired.title',
  'interview.terminal.session_expired.body',
  'interview.terminal.spent_link.title',
  'interview.terminal.spent_link.body',
]

describe('i18n interview flow keys', () => {
  const locales = ['it', 'en']

  for (const locale of locales) {
    describe(`locale: ${locale}`, () => {
      const data = loadLocale(locale)

      for (const key of REQUIRED_KEYS) {
        it(`has key "${key}"`, () => {
          const value = getNestedKey(data, key)
          expect(value, `Missing key "${key}" in ${locale}.json`).toBeDefined()
          expect(typeof value, `Key "${key}" in ${locale}.json is not a string`).toBe('string')
          expect(value as string, `Key "${key}" in ${locale}.json is empty`).not.toBe('')
        })
      }
    })
  }

  // ---------------------------------------------------------------------------
  // D-F: the expired-session terminal MUST NOT imply a new link will help — a
  // candidate whose session expired after pausing has no self-serve path back
  // in (a fresh sso-link is refused at the exchange pre-flight read for any
  // non-`in_attesa` status). Enforced structurally, not just by key presence.
  // ---------------------------------------------------------------------------

  describe('session_expired copy never suggests a new link will help (D-F)', () => {
    const linkWordPattern = /\blink\b/i

    for (const locale of locales) {
      it(`${locale}.json — session_expired body does not mention "link"`, () => {
        const data = loadLocale(locale)
        const body = getNestedKey(data, 'interview.terminal.session_expired.body') as string
        expect(body).not.toMatch(linkWordPattern)
      })

      it(`${locale}.json — session_expired title does not mention "link"`, () => {
        const data = loadLocale(locale)
        const title = getNestedKey(data, 'interview.terminal.session_expired.title') as string
        expect(title).not.toMatch(linkWordPattern)
      })
    }
  })
})
