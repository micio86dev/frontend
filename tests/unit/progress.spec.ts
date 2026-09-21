/**
 * Progress — a thin wrapper over reka-ui's ProgressRoot/ProgressIndicator.
 *
 * `modelValue` drives the indicator's `translateX` directly (see the
 * component's own template), so a wrong default silently renders a "0%"
 * bar as "100% missing" instead — the transform math inverts the percentage.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Progress from '../../app/components/ui/progress/Progress.vue'

describe('Progress', () => {
  it('defaults modelValue to 0 — an empty bar, not an unset one', () => {
    const wrapper = mount(Progress)

    const indicator = wrapper.find('[data-slot="progress-indicator"]')
    expect(indicator.attributes('style')).toContain('translateX(-100%)')
  })

  it('reflects an explicit modelValue in the indicator transform', () => {
    const wrapper = mount(Progress, { props: { modelValue: 40 } })

    const indicator = wrapper.find('[data-slot="progress-indicator"]')
    expect(indicator.attributes('style')).toContain('translateX(-60%)')
  })

  it('merges a caller class onto the root, rather than replacing it', () => {
    const wrapper = mount(Progress, { props: { class: 'my-caller-class' } })

    expect(wrapper.classes()).toContain('my-caller-class')
  })
})
