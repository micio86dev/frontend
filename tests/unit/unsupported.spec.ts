/**
 * Unit tests for the unsupported-browser gate page (SA-11).
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import UnsupportedPage from '../../app/pages/unsupported.vue'

describe('UnsupportedPage (SA-11 gate)', () => {
  it('renders the unsupported-gate data-testid element', () => {
    const wrapper = mount(UnsupportedPage, {
      global: {
        mocks: {
          $t: (key: string) => {
            const translations: Record<string, string> = {
              'unsupported.title': 'Browser non supportato',
              'unsupported.message': 'Accedi da un computer desktop.',
            }
            return translations[key] ?? key
          },
        },
      },
    })
    expect(wrapper.find('[data-testid="unsupported-gate"]').exists()).toBe(true)
  })

  it('renders the title heading', () => {
    const wrapper = mount(UnsupportedPage, {
      global: {
        mocks: {
          $t: (key: string) => {
            const t: Record<string, string> = {
              'unsupported.title': 'Browser non supportato',
              'unsupported.message': 'Accedi da un computer desktop.',
            }
            return t[key] ?? key
          },
        },
      },
    })
    expect(wrapper.find('h1').exists()).toBe(true)
    expect(wrapper.find('h1').text()).toBe('Browser non supportato')
  })

  it('does NOT render the health-status element', () => {
    const wrapper = mount(UnsupportedPage, {
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    })
    expect(wrapper.find('[data-testid="health-status"]').exists()).toBe(false)
  })
})

describe('the supported-browser list', () => {
  it('names every browser the product actually supports', async () => {
    // The one screen whose job is naming them, and Opera was missing —
    // CLAUDE.md's NFR lists Chrome/Edge/Opera/Safari, and an Opera user was
    // being told to switch to a browser they were already using.
    const [en, it] = await Promise.all([
      import('../../i18n/locales/en.json'),
      import('../../i18n/locales/it.json'),
    ])

    for (const bundle of [en.default, it.default]) {
      for (const browser of ['Chrome', 'Edge', 'Opera', 'Safari']) {
        expect(bundle.unsupported.message).toContain(browser)
      }
    }
  })
})
