/**
 * CallStage — the layout that wraps the avatar player layer
 * (candidate-interview-call-ui D2, D3, D13; DESIGN.md §7.3).
 *
 * The component is presentational: it places what it is given. What these cases
 * hold is the part that must never regress: the layer slot is rendered by ONE
 * element that survives every change of `live` (re-parenting it would unmount a
 * player and `stop()` a provider session), the stage parts exist only while live,
 * and an embedded stage carries no viewport-height unit.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import CallStage from '~/app/components/organisms/CallStage.vue'

const VIEWPORT_HEIGHT_UNIT = /\d(?:vh|dvh|svh|lvh)(?![a-z])/i

let mounts = 0
const Layer = defineComponent({
  props: { live: { type: Boolean, default: false } },
  setup(props) {
    mounts += 1
    return () => h('div', { 'data-slot': 'avatar-layer', 'data-live': String(props.live) })
  },
})

function mountStage(props: { live: boolean; embedded?: boolean }) {
  mounts = 0
  return mount(CallStage, {
    props,
    slots: {
      layer: ({ live }: { live: boolean }) => h(Layer, { live }),
      panel: () => h('div', { 'data-testid': 'p' }, 'panel'),
    },
  })
}

describe('CallStage', () => {
  it('lays the layer out beside the stage parts only while live', async () => {
    const wrapper = mountStage({ live: false })
    const layout = wrapper.get('[data-slot="call-layout"]')

    expect(layout.find('[data-slot="avatar-layer"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="p"]').exists()).toBe(false)
    // Not live: no box of its own, so the layer lays out exactly as it did without the stage.
    expect(layout.classes()).toContain('contents')

    await wrapper.setProps({ live: true })

    expect(layout.classes()).toContain('grid')
    expect(layout.classes()).not.toContain('contents')
    expect(wrapper.find('[data-testid="p"]').exists()).toBe(true)
  })

  it('makes every stage part a sibling of the layer inside the layout', () => {
    const wrapper = mountStage({ live: true })
    const layout = wrapper.get('[data-slot="call-layout"]').element
    const layer = layout.querySelector('[data-slot="avatar-layer"]')!

    expect(layer.parentElement).toBe(layout)
    for (const id of ['p']) {
      expect(wrapper.get(`[data-testid="${id}"]`).element.parentElement!.parentElement).toBe(layout)
    }
  })

  it('keeps the very same layer element, and the same instance, when live flips both ways', async () => {
    const wrapper = mountStage({ live: false })
    const before = wrapper.get('[data-slot="avatar-layer"]').element

    await wrapper.setProps({ live: true })
    expect(wrapper.get('[data-slot="avatar-layer"]').element).toBe(before)
    expect(wrapper.get('[data-slot="avatar-layer"]').attributes('data-live')).toBe('true')

    await wrapper.setProps({ live: false })
    expect(wrapper.get('[data-slot="avatar-layer"]').element).toBe(before)
    expect(mounts).toBe(1)
  })

  it('has no question slot or grid area: the captions are an overlay inside the layer', () => {
    const wrapper = mount(CallStage, {
      props: { live: true },
      slots: {
        layer: () => h('div', { 'data-slot': 'avatar-layer' }),
        question: () => h('div', { 'data-testid': 'q' }, 'question'),
        panel: () => h('div', { 'data-testid': 'p' }, 'panel'),
      },
    })

    expect(wrapper.find('[data-testid="q"]').exists()).toBe(false)
    expect(wrapper.find('[data-slot="call-stage-question"]').exists()).toBe(false)
    expect(wrapper.get('[data-slot="call-layout"]').attributes('class')).not.toMatch(/question/)
  })

  it('draws no own-camera cell: the own tile is an overlay inside the layer, not a stage part', () => {
    const wrapper = mountStage({ live: true })

    expect(wrapper.find('[data-slot="call-stage-self"]').exists()).toBe(false)
  })

  it('caps the hosted stage by the viewport height so it fits without scrolling', () => {
    const wrapper = mountStage({ live: true, embedded: false })

    expect(wrapper.get('[data-slot="call-layout"]').attributes('class')).toMatch(
      VIEWPORT_HEIGHT_UNIT
    )
  })

  it('uses no viewport-height unit when embedded: the host sizes the iframe from the content', () => {
    const wrapper = mountStage({ live: true, embedded: true })

    expect(wrapper.html()).not.toMatch(VIEWPORT_HEIGHT_UNIT)
    expect(wrapper.get('[data-slot="call-layout"]').attributes('data-embedded')).toBe('true')
  })
})

// live-interview-call-chrome D15: one row at `xl`, the wider 22 rem panel beside the video that
// takes the row's height without ever setting it, a one-column strip below `xl`.
describe('CallStage - the grid and the panel cell', () => {
  const layoutClasses = (props: { live: boolean; embedded?: boolean }) =>
    mountStage(props).get('[data-slot="call-layout"]').classes()
  const panelCell = () => mountStage({ live: true }).get('[data-slot="call-stage-panel"]')

  it('is ONE row at xl: the layer, then the panel column of --spacing-call-panel', () => {
    const classes = layoutClasses({ live: true })

    expect(classes).toContain('xl:grid-cols-[minmax(0,1fr)_var(--spacing-call-panel)]')
    expect(classes).toContain("xl:[grid-template-areas:'layer_panel']")
    // The old second row ("rest") existed only to let the panel run under the question band.
    expect(classes.join(' ')).not.toMatch(/rest_panel|grid-rows-\[auto_1fr\]/)
  })

  it("is one column below xl: 'layer' then 'panel'", () => {
    const classes = layoutClasses({ live: true })

    expect(classes).toContain('grid-cols-[minmax(0,1fr)]')
    expect(classes).toContain("[grid-template-areas:'layer'_'panel']")
  })

  it('lets the panel cell fill the row without setting its height (h-0 plus min-h-full)', () => {
    const classes = panelCell().classes()

    expect(classes).toEqual(
      expect.arrayContaining(['xl:h-0', 'xl:min-h-full', '[grid-area:panel]'])
    )
    // `self-start` would size the cell to its content and let the panel set the row height.
    expect(classes).not.toContain('xl:self-start')
  })

  it('stacks the panel in a column so the Percorso section can take the leftover height', () => {
    expect(panelCell().classes()).toEqual(expect.arrayContaining(['xl:flex', 'xl:flex-col']))
  })

  it('does not reserve panel height below xl: the strip sizes to its content', () => {
    const classes = panelCell().classes()

    expect(classes.filter((c) => /^(?:h-|min-h-)/.test(c))).toEqual([])
  })
})

describe('CallStage - the hosted height cap', () => {
  const classes = () =>
    mountStage({ live: true, embedded: false }).get('[data-slot="call-layout"]').classes()

  it('subtracts 9rem of chrome beside the panel and 22rem when the panel is a strip', () => {
    const cap = classes().filter((c) => c.includes('100dvh'))

    expect(cap).toContain('max-w-[min(100%,max(30rem,calc((100dvh_-_22rem)*16/9)))]')
    expect(cap).toContain(
      'xl:max-w-[min(100%,max(30rem,calc((100dvh_-_9rem)*16/9_+_var(--spacing-call-panel)_+_1.5rem)))]'
    )
  })

  it('gives the panel the viewport height even when the 16:9 tile is width-limited', () => {
    expect(classes()).toContain('xl:min-h-[calc(100dvh_-_9rem)]')
  })

  it('embedded: neither the cap nor the min-height, so the host can size the iframe', () => {
    const embedded = mountStage({ live: true, embedded: true })
      .get('[data-slot="call-layout"]')
      .classes()

    expect(embedded.filter((c) => /dvh|vh/.test(c))).toEqual([])
    expect(embedded).toContain('xl:grid-cols-[minmax(0,1fr)_var(--spacing-call-panel)]')
  })
})
