/**
 * BrandCanvas.vue — the candidate flow's shell (DESIGN.md §7.0.1).
 *
 * What is pinned here is what keeps the canvas legible on ANY client colour:
 * the canvas paints `bg-primary` with `text-on-primary`, content lives on an
 * elevated white surface, and no canvas-level element carries a class that
 * assumes a white page (`text-foreground`, `text-muted-foreground`) or is the
 * canvas colour itself (`text-primary`). The visuals beyond that are reviewed
 * in screenshots, not asserted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import BrandCanvas from '../../app/components/organisms/BrandCanvas.vue'
import { useCandidateBranding } from '../../app/composables/useCandidateBranding'

// Hoisted above the imports by Vitest, so the composable sees the mock.
const { candidateFetchMock } = vi.hoisted(() => ({ candidateFetchMock: vi.fn() }))

vi.mock('../../app/utils/candidate-api', () => ({
  candidateFetch: candidateFetchMock,
}))

const tMock = (key: string) => key

function mountCanvas(props: Record<string, unknown> = {}, slot = '<p>Surface content</p>') {
  return mount(BrandCanvas, {
    props: { testId: 'a-page', headingId: 'a-heading', ...props },
    slots: { default: slot },
    global: { mocks: { $t: tMock } },
  })
}

function rootToken(token: string): string {
  return document.documentElement.style.getPropertyValue(token)
}

/** Every element of the canvas that is NOT inside the elevated surface. */
function canvasElements(wrapper: VueWrapper): Element[] {
  const surface = wrapper.get('[data-slot="brand-canvas-surface"]').element

  return [wrapper.element, ...wrapper.element.querySelectorAll('*')].filter(
    (node) => node !== surface && !surface.contains(node)
  )
}

const WHITE_PAGE_CLASSES =
  /(^|\s)(text-primary|text-foreground|text-muted-foreground|bg-background)(\s|$)/

beforeEach(() => {
  useCandidateBranding().reset()
  candidateFetchMock.mockReset()
  candidateFetchMock.mockRejectedValue(new Error('no session'))
})

describe('BrandCanvas — who fetches the branding', () => {
  it('reads the session branding itself when nobody has yet', async () => {
    mountCanvas()
    await flushPromises()

    expect(candidateFetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not read it on an entry route before the token exchange', async () => {
    // There is no candidate session yet, so the read could only fail, and a
    // failed read settles "no branding" for every later page.
    mountCanvas({ loadBranding: false })
    await flushPromises()

    expect(candidateFetchMock).not.toHaveBeenCalled()
  })
})

describe('BrandCanvas — landmark and surface', () => {
  it('puts the test id and the heading link on the main landmark', () => {
    const wrapper = mountCanvas()
    const main = wrapper.get('main')

    expect(main.attributes('data-testid')).toBe('a-page')
    expect(main.attributes('aria-labelledby')).toBe('a-heading')
  })

  it('renders the slot inside one elevated white surface', () => {
    const wrapper = mountCanvas()
    const surface = wrapper.get('[data-slot="brand-canvas-surface"]')

    expect(surface.text()).toContain('Surface content')
    expect(surface.classes()).toContain('bg-card')
    expect(surface.classes()).toContain('shadow-surface')
    expect(surface.classes()).toContain('rounded-surface')
  })

  it.each([
    ['both given', { headingId: 'a-heading', ariaLabel: 'Interview' }, 'a-heading', undefined],
    ['only a heading', { headingId: 'a-heading', ariaLabel: undefined }, 'a-heading', undefined],
    ['only a label', { headingId: undefined, ariaLabel: 'Interview' }, undefined, 'Interview'],
    ['neither', { headingId: undefined, ariaLabel: undefined }, undefined, undefined],
  ])('names the landmark with exactly one mechanism (%s)', (_name, props, labelledby, label) => {
    // aria-labelledby silently wins over aria-label, so rendering both is a lie
    // about which name a screen reader announces: the heading wins, once.
    const main = mountCanvas(props).get('main')

    expect(main.attributes('aria-labelledby')).toBe(labelledby)
    expect(main.attributes('aria-label')).toBe(label)
  })

  it('marks the landmark busy only when asked to', () => {
    expect(mountCanvas().get('main').attributes('aria-busy')).toBeUndefined()
    expect(mountCanvas({ busy: true }).get('main').attributes('aria-busy')).toBe('true')
  })

  it('renders the tagline in the footer through i18n', () => {
    expect(mountCanvas().get('footer').text()).toContain('shell.tagline')
  })
})

describe('BrandCanvas — the canvas is the client colour, and stays legible on it', () => {
  it('paints the canvas with the primary and draws on it with on-primary', () => {
    const wrapper = mountCanvas()

    expect(wrapper.classes()).toContain('bg-primary')
    expect(wrapper.classes()).toContain('text-on-primary')
  })

  it('never puts a white-page or canvas-coloured text class on the canvas itself', async () => {
    useCandidateBranding().prime({
      primary_color: '#ffd400',
      logo_url: 'https://cdn.test/acme.png',
      name: 'Acme',
    })
    const wrapper = mountCanvas()
    await flushPromises()

    for (const node of canvasElements(wrapper)) {
      expect(node.getAttribute('class') ?? '', node.outerHTML.slice(0, 120)).not.toMatch(
        WHITE_PAGE_CLASSES
      )
    }
  })

  it('keeps the decorative layer out of the accessibility tree', () => {
    const decor = mountCanvas().get('[data-slot="brand-canvas-decor"]')

    expect(decor.attributes('aria-hidden')).toBe('true')
  })

  it.each([
    ['#ffd400', '#000000'],
    ['#771aaf', '#ffffff'],
  ])('with a %s client the canvas text token resolves to %s', async (color, expected) => {
    useCandidateBranding().prime({ primary_color: color, logo_url: null, name: null })
    mountCanvas()
    await flushPromises()

    expect(rootToken('--color-primary')).toBe(color)
    expect(rootToken('--color-on-primary')).toBe(expected)
  })

  it('with no client colour falls back to the stylesheet (Quint) defaults', async () => {
    useCandidateBranding().prime({ primary_color: null, logo_url: null, name: null })
    mountCanvas()
    await flushPromises()

    expect(rootToken('--color-primary')).toBe('')
    expect(rootToken('--color-on-primary')).toBe('')
  })

  it('the decorative layer paints with the canvas tone only', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/components/organisms/BrandCanvas.vue'),
      'utf-8'
    )
    const style = source.slice(source.indexOf('<style'))

    expect(style).toContain('var(--color-canvas-tone)')
    // No other colour token, literal or color-mix() in the decoration.
    expect(style).not.toMatch(/var\(--color-(?!canvas-tone)[a-z-]+\)/)
    expect(style).not.toMatch(/#[0-9a-f]{3,8}\b|color-mix\(/i)
  })

  it('animates every canvas surface only under prefers-reduced-motion: no-preference', () => {
    // Global, not scoped to this component: the interview states render their
    // own surfaces on the canvas, and they enter the same way (DESIGN.md §10).
    const css = readFileSync(resolve(__dirname, '../../app/assets/css/main.css'), 'utf-8')
    const guardAt = css.indexOf('@media (prefers-reduced-motion: no-preference)')
    const block = css.slice(guardAt, css.indexOf('}\n}', guardAt))

    expect(guardAt).toBeGreaterThanOrEqual(0)
    expect(block).toContain('.brand-canvas__surface')
    expect(block).toContain('animation:')
    expect(css.slice(0, guardAt)).not.toMatch(/\.brand-canvas__surface\s*\{[^}]*animation:/)
  })

  it('keeps the footer clear of the analytics consent banner while it is open', () => {
    // The banner floats over the bottom of the canvas and publishes its height;
    // the canvas reserves that much room so neither ever covers the other.
    const source = readFileSync(
      resolve(__dirname, '../../app/components/organisms/BrandCanvas.vue'),
      'utf-8'
    )

    expect(source.slice(source.indexOf('<style'))).toMatch(
      /padding-bottom:\s*var\(--consent-banner-clearance,\s*0px\)/
    )
  })
})

describe('BrandCanvas — bare mode, for the interview that brings its own surfaces', () => {
  it('renders the slot straight in the landmark, stacked, when surface is off', () => {
    const wrapper = mountCanvas({ surface: false, headingId: undefined, ariaLabel: 'Interview' })
    const main = wrapper.get('main')

    expect(wrapper.find('[data-slot="brand-canvas-surface"]').exists()).toBe(false)
    expect(main.text()).toContain('Surface content')
    expect(main.classes()).toContain('flex-col')
    expect(main.attributes('aria-label')).toBe('Interview')
    expect(main.attributes('aria-labelledby')).toBeUndefined()
  })

  it('drops the tagline footer when asked to', () => {
    expect(mountCanvas({ footer: false }).find('footer').exists()).toBe(false)
  })

  it('renders trailing header chrome at the end of the header', () => {
    const wrapper = mount(BrandCanvas, {
      props: { testId: 'a-page' },
      slots: { default: '<p>x</p>', 'header-end': '<span data-testid="chrome">2 / 5</span>' },
      global: { mocks: { $t: tMock } },
    })

    expect(wrapper.get('header').find('[data-testid="chrome"]').exists()).toBe(true)
  })
})

describe("BrandCanvas — the organization's mark, or ours, but never nothing", () => {
  it('shows the BEAI wordmark when no logo is configured', async () => {
    const wrapper = mountCanvas()
    await flushPromises()

    expect(wrapper.find('[data-testid="brand-canvas-logo"]').exists()).toBe(false)
    expect(wrapper.get('header').text()).toContain('BEAI')
  })

  it('draws a configured logo on a white plate instead of the wordmark', async () => {
    useCandidateBranding().prime({
      primary_color: '#771aaf',
      logo_url: 'https://cdn.test/acme.png',
      name: null,
    })
    const wrapper = mountCanvas()
    await flushPromises()

    const logo = wrapper.get('[data-testid="brand-canvas-logo"]')

    expect(logo.attributes('src')).toBe('https://cdn.test/acme.png')
    expect(logo.attributes('alt')).toBe('')
    // A logo in the brand colour would vanish straight on a canvas of that colour.
    expect(logo.element.parentElement?.className).toContain('bg-card')
    // A light logo on its white plate on a light canvas needs an edge to sit on.
    expect(logo.element.parentElement?.className).toMatch(/(^|\s)border(\s|$)/)
    expect(wrapper.get('header').text()).not.toContain('BEAI')
  })

  it('names the organization beside the mark when it is known', async () => {
    useCandidateBranding().prime({ primary_color: null, logo_url: null, name: 'Acme Selezione' })
    const wrapper = mountCanvas()
    await flushPromises()

    expect(wrapper.get('[data-testid="brand-canvas-org"]').text()).toBe('Acme Selezione')
  })

  it('keeps the logo decorative when the name beside it already says who it is', async () => {
    useCandidateBranding().prime({
      primary_color: null,
      logo_url: 'https://cdn.test/acme.png',
      name: 'Acme Selezione',
    })
    const wrapper = mountCanvas()
    await flushPromises()

    expect(wrapper.get('[data-testid="brand-canvas-logo"]').attributes('alt')).toBe('')
  })

  it('renders no empty organization line when the name is unknown', async () => {
    const wrapper = mountCanvas()
    await flushPromises()

    expect(wrapper.find('[data-testid="brand-canvas-org"]').exists()).toBe(false)
  })
})
