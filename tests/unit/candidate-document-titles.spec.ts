/**
 * Every candidate route state has a localized, non-empty document title
 * (WCAG 2.4.2 Page Titled, axe `document-title`).
 *
 * A source guard plus a locale check: a page loaded directly (not navigated to
 * from a titled one) has only what its own `useHead` sets.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import en from '../../i18n/locales/en.json'
import it_ from '../../i18n/locales/it.json'

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf-8')

function lookup(messages: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], messages)
}

const TERMINAL_REASONS = [
  '403',
  'absent_phrase',
  'session_expired',
  'spent_link',
  'link_used',
  'link_invalid',
  'link_reopen',
] as const

const PAGES = [
  'app/pages/i/[token].vue',
  'app/pages/interview/[token].vue',
  'app/pages/interview/done.vue',
  'app/pages/interview/error.vue',
  'app/pages/interview/terminal.vue',
  'app/pages/embed/[token].vue',
] as const

describe.each(PAGES)('%s sets a localized title', (path) => {
  const source = read(path)
  const head = source.slice(source.indexOf('useHead('))

  it('passes a title built from i18n to useHead', () => {
    expect(head).toMatch(/title:\s*(computed\(|t\(|tTitle\()/)
    expect(head).not.toMatch(/title:\s*['"]/)
  })
})

it('terminal titles every reason, not only link_reopen', () => {
  expect(read('app/pages/interview/terminal.vue')).toContain(
    't(`interview.terminal.${reason.value}.title`)'
  )
})

describe('title keys exist in both locales', () => {
  const keys = [
    'interview.document_title',
    'interview.done.title',
    'interview.error.title',
    ...TERMINAL_REASONS.map((r) => `interview.terminal.${r}.title`),
  ]

  it.each(keys)('%s is a non-empty string in it and en', (key) => {
    for (const messages of [en, it_]) {
      const value = lookup(messages, key)
      expect(typeof value).toBe('string')
      expect((value as string).trim().length).toBeGreaterThan(0)
    }
  })
})
