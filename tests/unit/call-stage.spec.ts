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

function mountStage(props: { live: boolean; embedded?: boolean }, withSelf = true) {
  mounts = 0
  return mount(CallStage, {
    props,
    slots: {
      layer: ({ live }: { live: boolean }) => h(Layer, { live }),
      question: () => h('div', { 'data-testid': 'q' }, 'question'),
      panel: () => h('div', { 'data-testid': 'p' }, 'panel'),
      ...(withSelf ? { self: () => h('div', { 'data-testid': 's' }, 'self') } : {}),
    },
  })
}

describe('CallStage', () => {
  it('lays the layer out beside the stage parts only while live', async () => {
    const wrapper = mountStage({ live: false })
    const layout = wrapper.get('[data-slot="call-layout"]')

    expect(layout.find('[data-slot="avatar-layer"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="q"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="p"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="s"]').exists()).toBe(false)
    // Not live: no box of its own, so the layer lays out exactly as it did without the stage.
    expect(layout.classes()).toContain('contents')

    await wrapper.setProps({ live: true })

    expect(layout.classes()).toContain('grid')
    expect(layout.classes()).not.toContain('contents')
    expect(wrapper.find('[data-testid="q"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="p"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="s"]').exists()).toBe(true)
  })

  it('makes every stage part a sibling of the layer inside the layout', () => {
    const wrapper = mountStage({ live: true })
    const layout = wrapper.get('[data-slot="call-layout"]').element
    const layer = layout.querySelector('[data-slot="avatar-layer"]')!

    expect(layer.parentElement).toBe(layout)
    for (const id of ['q', 'p', 's']) {
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

  it('draws no own-camera cell when no self slot is given', () => {
    const wrapper = mountStage({ live: true }, false)

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
