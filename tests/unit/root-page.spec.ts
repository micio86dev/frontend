/**
 * app/pages/index.vue — the root landing (informational dead end).
 *
 * Most of this file asserts what the page must NOT contain. That is deliberate:
 * the orientation copy is trivial and unlikely to break, whereas the pressure to
 * turn a root route into a login screen is constant and reasonable-sounding.
 *
 * BEAI has no candidate account, enrolment belongs to the calling system, and
 * BEAI holds no candidate contact data — so a form here would offer a flow that
 * does not exist, and a support address would route confused people to an
 * organization that cannot identify them.
 *
 * A comment saying "do not add a login here" survives until somebody disagrees
 * with it in a hurry. A test does not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'

const tMock = (key: string) => key

describe('pages/index.vue', () => {
  beforeEach(() => {
    vi.stubGlobal('definePageMeta', vi.fn())
    vi.stubGlobal('useHead', vi.fn())
  })

  async function mountRoot() {
    const RootPage = (await import('../../app/pages/index.vue')).default

    return mount(RootPage, {
      global: {
        mocks: { $t: tMock },
        stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } },
      },
    })
  }

  it('renders the orientation copy from i18n', async () => {
    const wrapper = await mountRoot()

    expect(wrapper.text()).toContain('root.title')
    expect(wrapper.text()).toContain('root.message')
  })

  it('exposes a main landmark labelled by its own heading', async () => {
    const wrapper = await mountRoot()
    const main = wrapper.get('[role="main"]')

    const labelledBy = main.attributes('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    expect(wrapper.get(`#${labelledBy}`).element.tagName).toBe('H1')
  })

  it('contains NO form control — this route offers no flow to submit', async () => {
    const wrapper = await mountRoot()

    expect(wrapper.findAll('input')).toHaveLength(0)
    expect(wrapper.findAll('form')).toHaveLength(0)
    expect(wrapper.findAll('textarea')).toHaveLength(0)
    expect(wrapper.findAll('select')).toHaveLength(0)
    expect(wrapper.findAll('button')).toHaveLength(0)
  })

  it('renders no mailto link', async () => {
    const wrapper = await mountRoot()

    expect(wrapper.findAll('a[href^="mailto:"]')).toHaveLength(0)
  })

  it.each(['it', 'en'])(
    'the %s copy offers no login, sign-up or support affordance',
    async (locale) => {
      // Asserted against the REAL locale file, not the mounted component. $t is
      // mocked to echo its key, so checking wrapper.text() here would only ever
      // inspect the string "root.message" and would pass no matter what the
      // copy said — a test that cannot fail.
      const messages = (await import(`../../i18n/locales/${locale}.json`)).default
      const copy = `${messages.root.title} ${messages.root.message}`.toLowerCase()

      expect(copy.length).toBeGreaterThan(0)

      // A candidate has no BEAI account, and BEAI is not their support channel —
      // the party that sent them the link is the only one who can identify them.
      for (const forbidden of ['login', 'log in', 'accedi con', 'sign up', 'registrat', '@']) {
        expect(copy).not.toContain(forbidden)
      }
    }
  )

  it('renders without making any request', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('$fetch', fetchSpy)
    vi.stubGlobal('fetch', fetchSpy)

    await mountRoot()

    // A static screen. If this ever needs data, that is a different page.
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
