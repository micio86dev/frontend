/**
 * app/pages/interview/terminal.vue — the `link_invalid` copy.
 *
 * `link_invalid` is the one terminal reason shared by every entry that ends on
 * "this link will never work": a single-use hosted link (`/i/{token}`: expired,
 * mis-signed, wrong audience, malformed or already invalid), an embed exchange
 * (401/404) and, since reusable interview links, a reusable link (`/r/...`)
 * that is unknown, malformed or disabled. A reusable link NEVER expires, so the
 * copy must not claim expiry: it has to be true for every one of those cases.
 *
 * The page itself is entry-agnostic (it only reads `?reason=`), so the two
 * entry kinds are pinned here by the exact route each one lands on.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type Messages = Record<string, unknown>

function loadLocale(locale: 'en' | 'it'): Messages {
  const raw = readFileSync(resolve(__dirname, `../../i18n/locales/${locale}.json`), 'utf-8')
  return JSON.parse(raw) as Messages
}

function translator(messages: Messages): (key: string) => string {
  return (key: string): string => {
    let current: unknown = messages
    for (const part of key.split('.')) {
      if (current === null || typeof current !== 'object') return key
      current = (current as Messages)[part]
    }
    return typeof current === 'string' ? current : key
  }
}

async function mountTerminal(locale: 'en' | 'it', query: Record<string, string>) {
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useHead', vi.fn())
  vi.stubGlobal(
    'useRoute',
    vi.fn(() => ({ query, params: {} }))
  )
  const { default: Page } = await import('~/app/pages/interview/terminal.vue')
  return mount(Page, { global: { mocks: { $t: translator(loadLocale(locale)) } } })
}

/**
 * The two entry kinds that end on this reason, by the route each one replaces
 * to (asserted in hosted-entry.spec.ts and reusable-entry-page.spec.ts).
 */
const ENTRY_KINDS: ReadonlyArray<[string, Record<string, string>]> = [
  [
    'single-use hosted link (/i/{token}, 401 token_invalid)',
    Object.fromEntries(new URLSearchParams('reason=link_invalid')),
  ],
  [
    'reusable link (/interview/reusable, 404, malformed or disabled)',
    Object.fromEntries(new URLSearchParams('reason=link_invalid')),
  ],
]

const EXPECTED: Record<'en' | 'it', { title: string; body: string }> = {
  en: {
    title: 'This Link Is No Longer Valid',
    body: 'This interview link is not valid or is no longer active. Please ask whoever sent it to you for a new link.',
  },
  it: {
    title: 'Questo link non è più valido',
    body: 'Questo link per il colloquio non è valido o non è più attivo. Chiedi un nuovo link a chi te lo ha inviato.',
  },
}

/** A reusable link never expires, so neither locale may say the link "expired". */
const EXPIRY_CLAIM: Record<'en' | 'it', RegExp> = {
  en: /expire/i,
  it: /scad/i,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('terminal page — link_invalid copy', () => {
  for (const locale of ['en', 'it'] as const) {
    describe(`locale: ${locale}`, () => {
      it.each(ENTRY_KINDS)('%s: shows the pinned headline and body', async (_kind, query) => {
        const wrapper = await mountTerminal(locale, query)

        expect(wrapper.get('h1').text()).toBe(EXPECTED[locale].title)
        expect(wrapper.get('section p').text()).toBe(EXPECTED[locale].body)
      })

      it.each(ENTRY_KINDS)('%s: never claims the link expired', async (_kind, query) => {
        const wrapper = await mountTerminal(locale, query)

        expect(wrapper.text()).not.toMatch(EXPIRY_CLAIM[locale])
      })

      it('is an accessible region: the section is labelled by the page heading', async () => {
        const wrapper = await mountTerminal(locale, { reason: 'link_invalid' })

        const heading = wrapper.get('h1')
        expect(heading.attributes('id')).toBe('terminal-page-heading')
        expect(wrapper.get('section').attributes('aria-labelledby')).toBe('terminal-page-heading')
        expect(wrapper.find('a').exists()).toBe(false)
      })
    })
  }
})
