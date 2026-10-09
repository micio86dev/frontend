/**
 * The terminal page's contact link follows the configured support URL
 * (candidate-interview-call-ui, UI-08; design D10).
 *
 * Kept apart from terminal-page.spec.ts on purpose: that spec pins the page's
 * copy and runs without a runtime config; this one re-stubs `useRuntimeConfig`
 * because it asserts the href the config produces.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

async function mountTerminal(supportUrl?: unknown) {
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useHead', vi.fn())
  vi.stubGlobal(
    'useI18n',
    vi.fn(() => ({ t: (key: string) => key }))
  )
  vi.stubGlobal(
    'useRoute',
    vi.fn(() => ({ query: { reason: 'absent_phrase' }, params: {} }))
  )
  vi.stubGlobal(
    'useRuntimeConfig',
    vi.fn(() => ({ public: supportUrl === undefined ? {} : { supportUrl } }))
  )
  const { default: Page } = await import('~/app/pages/interview/terminal.vue')

  return mount(Page, { global: { mocks: { $t: (key: string) => key } } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('terminal page support link', () => {
  it('stays on the default mailbox when no support URL is configured', async () => {
    const wrapper = await mountTerminal()

    expect(wrapper.get('[data-testid="terminal-contact"]').attributes('href')).toBe(
      'mailto:support@beai.app'
    )
  })

  it('follows a configured support URL', async () => {
    const wrapper = await mountTerminal('https://help.example.com/contact')

    expect(wrapper.get('[data-testid="terminal-contact"]').attributes('href')).toBe(
      'https://help.example.com/contact'
    )
  })

  it('refuses an unsafe configured value', async () => {
    const wrapper = await mountTerminal('javascript:alert(1)')

    expect(wrapper.get('[data-testid="terminal-contact"]').attributes('href')).toBe(
      'mailto:support@beai.app'
    )
  })
})
