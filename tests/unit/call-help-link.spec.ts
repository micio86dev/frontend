/**
 * CallHelpLink — «Problemi con audio o video?» (candidate-interview-call-ui,
 * UI-08; design D10; DESIGN.md §7.3).
 *
 * The contract is the link's attributes per scheme: an `https:` support page
 * opens in a new tab, so it must carry `rel="noopener noreferrer"` and tell a
 * screen-reader user it opens elsewhere; a `mailto:` target opens the mail
 * client and must carry neither. `$t` is backed by the REAL `en.json`.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import CallHelpLink from '~/app/components/molecules/CallHelpLink.vue'
import en from '../../i18n/locales/en.json'

function resolveEn(key: string): string {
  const found = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      en
    )
  if (typeof found !== 'string') throw new Error(`en.json has no string at "${key}"`)
  return found
}

const mounted: VueWrapper[] = []

function mountLink(supportUrl: unknown) {
  vi.stubGlobal(
    'useRuntimeConfig',
    vi.fn(() => ({ public: { supportUrl } }))
  )
  const wrapper = mount(CallHelpLink, { global: { mocks: { $t: resolveEn } } })
  mounted.push(wrapper)
  return wrapper.get('[data-testid="call-help-link"]')
}

afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  vi.unstubAllGlobals()
})

describe('CallHelpLink', () => {
  it('is an anchor labelled by interview.call.help.label', () => {
    const link = mountLink('https://help.example.com/')

    expect(link.element.tagName).toBe('A')
    expect(link.text()).toContain(resolveEn('interview.call.help.label'))
  })

  it('opens an https support page in a new tab, safely, and says so to screen readers', () => {
    const link = mountLink('https://help.example.com/audio')

    expect(link.attributes('href')).toBe('https://help.example.com/audio')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener noreferrer')

    const note = link.get('.sr-only')
    expect(note.text()).toBe(resolveEn('interview.call.help.new_tab'))
  })

  it('renders neither target nor rel nor the new-tab note for a mailto target', () => {
    const link = mountLink('mailto:help@example.com')

    expect(link.attributes('href')).toBe('mailto:help@example.com')
    expect(link.attributes('target')).toBeUndefined()
    expect(link.attributes('rel')).toBeUndefined()
    expect(link.find('.sr-only').exists()).toBe(false)
  })

  it('falls back to the default mailbox, without target or rel, when nothing is configured', () => {
    const link = mountLink('')

    expect(link.attributes('href')).toBe('mailto:support@beai.app')
    expect(link.attributes('target')).toBeUndefined()
    expect(link.attributes('rel')).toBeUndefined()
  })

  it('never links to an unsafe scheme', () => {
    const link = mountLink('javascript:alert(1)')

    expect(link.attributes('href')).toBe('mailto:support@beai.app')
    expect(link.attributes('target')).toBeUndefined()
  })

  it('is a 44 px target in the brand ink with a visible 2 px focus ring', () => {
    const link = mountLink('https://help.example.com/')

    expect(link.classes()).toContain('min-h-(--spacing-control)')
    expect(link.classes()).toContain('text-primary-ink')
    expect(link.classes()).toContain('underline')
    expect(link.classes()).toContain('focus-visible:ring-2')
    expect(link.classes()).toContain('focus-visible:ring-primary-ink')
  })
})
