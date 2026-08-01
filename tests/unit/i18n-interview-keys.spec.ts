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
})
