/**
 * NoticeShell.vue — the shared shell behind the four standalone routes
 * (root landing, SA-11 gate, interview done, interview error).
 *
 * The contract worth pinning is the ACCESSIBILITY wiring, not the visuals:
 * every one of those routes locates its landmark and its heading through this
 * component, so a refactor that drops `role="main"` or breaks the
 * aria-labelledby -> <h1> link silently breaks four pages at once.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
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

  it('holds no empty action row when the slot renders nothing', () => {
    // A route that passes a slot whose only child is `v-if`-ed away (the
    // terminal's support link) must not leave a blank band in the surface.
    const wrapper = mountShell({}, { default: '<a v-if="false" href="#">x</a>' })

    expect(wrapper.find('[data-slot="notice-actions"]').exists()).toBe(false)
  })

  it('renders slotted actions', () => {
    const wrapper = mountShell({}, { default: '<button data-testid="go">Go</button>' })

    expect(wrapper.find('[data-slot="notice-actions"] [data-testid="go"]').exists()).toBe(true)
  })

  // The chip is the ONLY thing `tone` may change. If a tone ever starts
  // altering copy or structure, the four pages stop being one system.
  it.each([
    // A solid brand fill with the derived on-primary glyph: `bg-primary/10
    // text-primary` was invisible for a light client colour (DESIGN.md §3.1).
    ['info', 'text-on-primary'],
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

describe('NoticeShell — on the brand canvas', () => {
  it('renders its content on the canvas surface, never on the bare canvas', () => {
    const wrapper = mountShell()
    const surface = wrapper.get('[data-slot="brand-canvas-surface"]')

    expect(wrapper.classes()).toContain('bg-primary')
    expect(surface.find('h1').exists()).toBe(true)
    expect(surface.text()).toContain('A message')
  })

  it('never paints the info chip with the canvas colour on a tint of itself', () => {
    expect(mountShell({ tone: 'info' }).html()).not.toMatch(
      /bg-primary\/10|(^|\s)text-primary(\s|")/
    )
  })

  it('edges the info chip in primary-ink, so a light client colour still reads as a chip', () => {
    // #ffd400 on the white surface is 1.07:1: the glyph read, the chip did not.
    const chip = mountShell({ tone: 'info' }).get('span[aria-hidden="true"]')

    expect(chip.classes()).toContain('border')
    expect(chip.classes()).toContain('border-primary-ink')
  })
})

describe("NoticeShell — the organization's mark, or ours, but never nothing", () => {
  beforeEach(async () => {
    const { useCandidateBranding } = await import('../../app/composables/useCandidateBranding')
    useCandidateBranding().reset()
  })

  it('falls back to the BEAI wordmark when no logo is configured', async () => {
    // These four routes are the only BEAI surface most candidates ever see. A
    // blank brand band reads as a broken deployment at the exact moment the
    // person is deciding whether to trust the service — so "no logo
    // configured" must never mean "no logo at all" (CLAUDE.md ruling 9).
    const wrapper = mountShell()
    await flushPromises()

    expect(wrapper.find('[data-testid="brand-canvas-logo"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('BEAI')
  })

  it('renders the organization logo INSTEAD of the wordmark once one exists', async () => {
    const { useCandidateBranding } = await import('../../app/composables/useCandidateBranding')
    useCandidateBranding().prime({
      primary_color: null,
      logo_url: 'https://cdn.test/acme.png',
      name: null,
    })

    const wrapper = mountShell()
    await flushPromises()

    const logo = wrapper.get('[data-testid="brand-canvas-logo"]')

    expect(logo.attributes('src')).toBe('https://cdn.test/acme.png')
    // Decoration beside the tagline that follows: announcing an
    // organization's name to a candidate who already knows whose assessment
    // they are taking adds noise, not meaning.
    expect(logo.attributes('alt')).toBe('')
    expect(wrapper.text()).not.toContain('BEAI')
  })
})

/**
 * WHOSE assessment this is.
 *
 * The shell showed the organization's logo OR the BEAI wordmark and nothing
 * else, so a candidate invited by Acme reached a page that named nobody. The
 * name now sits beside the mark on every notice route.
 *
 * It does not replace `BEAI`. The product has a brand of its own and the
 * candidate is on OUR platform taking THEIR assessment — the page has to say
 * both, which is exactly what the logo/wordmark fallback already refuses to
 * compromise on.
 */
describe('NoticeShell — the organization is named, not just drawn', () => {
  beforeEach(async () => {
    const { useCandidateBranding } = await import('../../app/composables/useCandidateBranding')
    useCandidateBranding().reset()
  })

  it('names the organization beside the mark', async () => {
    const { useCandidateBranding } = await import('../../app/composables/useCandidateBranding')
    useCandidateBranding().prime({
      primary_color: null,
      logo_url: null,
      name: 'Acme Selezione',
    })

    const wrapper = mountShell()
    await flushPromises()

    expect(wrapper.get('[data-testid="brand-canvas-org"]').text()).toBe('Acme Selezione')
    // The product wordmark stays. Both, never one instead of the other.
    expect(wrapper.text()).toContain('BEAI')
  })

  it('names it alongside a configured logo too', async () => {
    // The logo carries `alt=""` because it is decoration; this line is the
    // accessible name, so with a logo configured it is the ONLY way a screen
    // reader learns whose assessment this is.
    const { useCandidateBranding } = await import('../../app/composables/useCandidateBranding')
    useCandidateBranding().prime({
      primary_color: null,
      logo_url: 'https://cdn.test/acme.png',
      name: 'Acme Selezione',
    })

    const wrapper = mountShell()
    await flushPromises()

    expect(wrapper.get('[data-testid="brand-canvas-org"]').text()).toBe('Acme Selezione')
  })

  it('renders NOTHING rather than an empty line when there is no name', async () => {
    const wrapper = mountShell()
    await flushPromises()

    expect(wrapper.find('[data-testid="brand-canvas-org"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('BEAI')
  })
})
