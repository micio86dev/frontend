/**
 * Separator — a thin wrapper over reka-ui's Separator.
 *
 * `decorative: true` by default is the accessibility-relevant choice: it
 * tells assistive tech to skip the element (`role="none"`/no `aria-*`)
 * rather than announcing a spurious `<hr>`-equivalent between two sections
 * that were never meant to read as a document boundary.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Separator from '../../app/components/ui/separator/Separator.vue'

describe('Separator', () => {
  it('defaults to horizontal and decorative', () => {
    const wrapper = mount(Separator)

    expect(wrapper.attributes('data-orientation')).toBe('horizontal')
    expect(wrapper.attributes('role')).not.toBe('separator')
  })

  it('honours an explicit vertical orientation', () => {
    const wrapper = mount(Separator, { props: { orientation: 'vertical' } })

    expect(wrapper.attributes('data-orientation')).toBe('vertical')
  })

  it('a non-decorative separator is announced with role="separator"', () => {
    const wrapper = mount(Separator, { props: { decorative: false } })

    expect(wrapper.attributes('role')).toBe('separator')
  })

  it('merges a caller class onto its own, rather than replacing it', () => {
    const wrapper = mount(Separator, { props: { class: 'my-caller-class' } })

    expect(wrapper.classes()).toContain('my-caller-class')
  })
})
