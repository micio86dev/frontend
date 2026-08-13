/**
 * NoticeShell.vue — the shared shell behind the four standalone routes
 * (root landing, SA-11 gate, interview done, interview error).
 *
 * The contract worth pinning is the ACCESSIBILITY wiring, not the visuals:
 * every one of those routes locates its landmark and its heading through this
 * component, so a refactor that drops `role="main"` or breaks the
 * aria-labelledby -> <h1> link silently breaks four pages at once.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NoticeShell from '../../app/components/molecules/NoticeShell.vue'

const tMock = (key: string) => key

function mountShell(props: Partial<Record<string, string>> = {}, slots = {}) {
  return mount(NoticeShell, {
    props: {
      title: 'A title',
      message: 'A message',
      headingId: 'a-heading',
      testId: 'a-page',
      ...props,
    },
    slots,
    global: { mocks: { $t: tMock } },
  })
}

describe('NoticeShell', () => {
  it('renders the title as the page <h1> and the message beside it', () => {
    const wrapper = mountShell()

    expect(wrapper.get('h1').text()).toBe('A title')
    expect(wrapper.text()).toContain('A message')
  })

  it('labels the main landmark with its own heading', () => {
    const wrapper = mountShell()
    const main = wrapper.get('main')

    expect(main.attributes('aria-labelledby')).toBe('a-heading')
    expect(wrapper.get('#a-heading').element.tagName).toBe('H1')
  })

  it('puts the test id on the landmark, not on a decorative wrapper', () => {
    const wrapper = mountShell()

    expect(wrapper.get('[data-testid="a-page"]').element.tagName).toBe('MAIN')
  })

  it('renders the brand tagline through i18n rather than a hardcoded literal', () => {
    expect(mountShell().text()).toContain('shell.tagline')
  })

  it('renders no action affordance unless one is passed in', () => {
    expect(mountShell().findAll('button')).toHaveLength(0)
  })

  it('renders slotted actions', () => {
    const wrapper = mountShell({}, { default: '<button data-testid="go">Go</button>' })

    expect(wrapper.find('[data-testid="go"]').exists()).toBe(true)
  })

  // The chip is the ONLY thing `tone` may change. If a tone ever starts
  // altering copy or structure, the four pages stop being one system.
  it.each([
    ['info', 'text-primary'],
    ['success', 'text-success-dark'],
    ['warning', 'text-warning-dark'],
    ['danger', 'text-destructive'],
  ])('tints the %s chip without changing the content structure', (tone, expectedClass) => {
    const wrapper = mountShell({ tone })

    expect(wrapper.html()).toContain(expectedClass)
    expect(wrapper.get('h1').text()).toBe('A title')
    expect(wrapper.findAll('h1')).toHaveLength(1)
  })

  it('hides the decorative chip and brand glows from assistive tech', () => {
    const wrapper = mountShell()

    for (const node of wrapper.findAll('svg')) {
      // The icon is decorative: its meaning is already carried by the heading.
      expect(node.element.closest('[aria-hidden="true"]')).not.toBeNull()
    }
  })
})
