/**
 * app/pages/interview/terminal.vue: the `link_invalid` copy.
 *
 * Several entries end on this reason (a hosted link's exchange 401, a reusable
 * link's 404, malformed fragment or missing session), and a reusable link never
 * expires, so the copy must not claim expiry: it has to be true for all of them.
 * The page is entry-kind agnostic, it only reads `?reason=`, so one render per
 * locale covers every entry. Which entry navigates here is asserted where the
 * navigation happens: hosted-entry.spec.ts and reusable-entry-page.spec.ts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { toValue } from 'vue'
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
  const useHead = vi.fn()
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useHead', useHead)
  vi.stubGlobal(
    'useI18n',
    vi.fn(() => ({ t: translator(loadLocale(locale)) }))
  )
  vi.stubGlobal(
    'useRoute',
    vi.fn(() => ({ query, params: {} }))
  )
  // afterEach unstubs every global, wiping the shared setup.ts stub; the page
  // reads the support URL through useRuntimeConfig(). Unset means the default.
  vi.stubGlobal(
    'useRuntimeConfig',
    vi.fn(() => ({ public: {} }))
  )
  const { default: Page } = await import('~/app/pages/interview/terminal.vue')
  const wrapper = mount(Page, { global: { mocks: { $t: translator(loadLocale(locale)) } } })
  return Object.assign(wrapper, {
    /** The document title the page asked `useHead` for, resolved. */
    documentTitle: (): unknown => {
      const input = useHead.mock.calls
        .map((call) => call[0] as { title?: unknown })
        .find((c) => 'title' in c)
      return input === undefined ? undefined : toValue(input.title as never)
    },
  })
}

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

const QUERY = { reason: 'link_invalid' }

describe('terminal page — link_invalid copy', () => {
  for (const locale of ['en', 'it'] as const) {
    describe(`locale: ${locale}`, () => {
      it('shows the pinned headline and body', async () => {
        const wrapper = await mountTerminal(locale, QUERY)

        expect(wrapper.get('h1').text()).toBe(EXPECTED[locale].title)
        expect(wrapper.get('main p').text()).toBe(EXPECTED[locale].body)
      })

      it('never claims the link expired', async () => {
        const wrapper = await mountTerminal(locale, QUERY)

        expect(wrapper.text()).not.toMatch(EXPIRY_CLAIM[locale])
      })

      it('is an accessible region: the landmark is labelled by the page heading', async () => {
        const wrapper = await mountTerminal(locale, QUERY)

        expect(wrapper.get('h1').attributes('id')).toBe('terminal-page-heading')
        expect(wrapper.get('main').attributes('aria-labelledby')).toBe('terminal-page-heading')
        expect(wrapper.find('a').exists()).toBe(false)
      })
    })
  }
})

/**
 * `link_reopen` (reusable-link-visitor-identity): the visitor reloaded while the
 * identity form was shown, so the link token (kept in memory only) is gone. The link
 * itself is fine, so this must NOT be `link_invalid`, and there is nothing to retry
 * from here: the visitor has to open the link again.
 */
const REOPEN: Record<'en' | 'it', { title: string; body: string }> = {
  en: {
    title: 'Please open the link again',
    body: 'This page was reloaded, so your interview link is no longer here. Open the link again (scan the QR code or use the message you received) to start.',
  },
  it: {
    title: 'Apri di nuovo il link',
    body: 'Questa pagina è stata ricaricata, quindi il link del tuo colloquio non è più qui. Riapri il link (inquadra di nuovo il codice QR oppure usa il messaggio ricevuto) per iniziare.',
  },
}

describe('terminal page: link_reopen copy', () => {
  for (const locale of ['en', 'it'] as const) {
    describe(`locale: ${locale}`, () => {
      const query = { reason: 'link_reopen' }

      it('shows the pinned reopen headline and body', async () => {
        const wrapper = await mountTerminal(locale, query)

        expect(wrapper.get('h1').text()).toBe(REOPEN[locale].title)
        expect(wrapper.get('main p').text()).toBe(REOPEN[locale].body)
      })

      it('is not the link_invalid state, whose copy would be untrue here', async () => {
        const wrapper = await mountTerminal(locale, query)

        expect(wrapper.text()).not.toContain(EXPECTED[locale].title)
        expect(wrapper.text()).not.toContain(EXPECTED[locale].body)
      })

      it('offers no retry, link or button: the visitor must open the link again', async () => {
        const wrapper = await mountTerminal(locale, query)

        expect(wrapper.find('a').exists()).toBe(false)
        expect(wrapper.find('button').exists()).toBe(false)
        expect(wrapper.find('form').exists()).toBe(false)
        expect(wrapper.find('input').exists()).toBe(false)
      })

      it('is an accessible region labelled by the page heading', async () => {
        const wrapper = await mountTerminal(locale, query)

        expect(wrapper.get('h1').attributes('id')).toBe('terminal-page-heading')
        expect(wrapper.get('main').attributes('aria-labelledby')).toBe('terminal-page-heading')
      })

      it('sets a localized document title (WCAG 2.4.2) that matches the heading', async () => {
        const wrapper = await mountTerminal(locale, query)

        expect(wrapper.documentTitle()).toBe(REOPEN[locale].title)
      })
    })
  }

  it('does not set a reopen title for any other reason', async () => {
    for (const reason of ['link_invalid', '403', 'spent_link']) {
      const wrapper = await mountTerminal('en', { reason })

      expect(wrapper.documentTitle()).not.toBe(REOPEN.en.title)
    }
  })

  it('an unknown reason keeps its existing fallback (the 403 copy), never the reopen copy', async () => {
    const wrapper = await mountTerminal('en', { reason: 'definitely-not-a-reason' })

    expect(wrapper.text()).not.toContain(REOPEN.en.title)
    expect(wrapper.get('h1').text()).toBe('Session Not Authorized')
  })
})

/**
 * The one terminal that offers a way out: `absent_phrase` (service
 * unavailable) links to support. It sits on the white canvas surface, where
 * `text-primary` would be the raw client colour (yellow on white is 1.07:1),
 * so the link uses the brand ink, held at 4.5:1 on white (DESIGN.md §3.1).
 */
describe('terminal page: on the brand canvas', () => {
  it('renders on the canvas, not on a white page of its own', async () => {
    const wrapper = await mountTerminal('en', { reason: 'link_invalid' })

    expect(wrapper.find('[data-slot="brand-canvas-surface"] h1').exists()).toBe(true)
    expect(wrapper.get('main').attributes('data-testid')).toBe('terminal-page')
  })

  it('draws the support link in the brand ink, never in the canvas colour', async () => {
    const wrapper = await mountTerminal('en', { reason: 'absent_phrase' })
    const link = wrapper.get('[data-testid="terminal-contact"]')

    expect(link.classes()).toContain('text-primary-ink')
    expect(link.classes()).not.toContain('text-primary')
  })
})
