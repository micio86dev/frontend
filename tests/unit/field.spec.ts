/**
 * Field — the group wrapper `FieldLabel`/inputs compose inside.
 *
 * Its only real logic is `orientation`, which drives both a Tailwind variant
 * class and a `data-orientation` attribute consumers style against. A wrong
 * default here changes the layout of every form field in the app at once.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Field from '../../app/components/ui/field/Field.vue'

describe('Field', () => {
  it('defaults to vertical orientation', () => {
    const wrapper = mount(Field, { slots: { default: 'x' } })

    expect(wrapper.attributes('data-orientation')).toBe('vertical')
  })

  it('honours an explicit orientation', () => {
    const wrapper = mount(Field, {
      props: { orientation: 'horizontal' },
      slots: { default: 'x' },
    })

    expect(wrapper.attributes('data-orientation')).toBe('horizontal')
  })

  it('merges a caller class onto its own, rather than replacing it', () => {
    const wrapper = mount(Field, { props: { class: 'my-caller-class' }, slots: { default: 'x' } })

    expect(wrapper.classes()).toContain('my-caller-class')
    expect(wrapper.attributes('role')).toBe('group')
  })
})
