/**
 * Input and FieldError — the two form primitives the reusable identity form
 * composes (DESIGN.md §16.19), vendored byte-for-byte from the backoffice.
 *
 * Honest TDD note: vendoring adds no new behaviour of its own. These smoke tests
 * prove the components exist in the frontend and keep the contract the form relies
 * on: `FieldError` announces through `role="alert"` and keeps the id the control's
 * `aria-describedby` points at; `Input` is a real `<input>` that forwards the
 * attributes the form sets (autocomplete, aria-*, required, type) and v-models.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { Input } from '../../../../app/components/ui/input'
import { FieldError } from '../../../../app/components/ui/field'

describe('FieldError', () => {
  it('renders its slot with role="alert" and keeps the caller id', () => {
    const wrapper = mount(FieldError, {
      attrs: { id: 'reusable-identity-name-error' },
      slots: { default: 'Enter your name.' },
    })

    expect(wrapper.attributes('role')).toBe('alert')
    expect(wrapper.attributes('id')).toBe('reusable-identity-name-error')
    expect(wrapper.text()).toBe('Enter your name.')
  })

  it('renders a single error from the errors prop', () => {
    const wrapper = mount(FieldError, { props: { errors: ['Enter your email.'] } })

    expect(wrapper.attributes('role')).toBe('alert')
    expect(wrapper.text()).toBe('Enter your email.')
  })

  it('renders nothing at all when there is no error and no slot', () => {
    const wrapper = mount(FieldError, { props: { errors: [] } })

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it.each([
    ['undefined entries', [undefined]],
    ['several undefined entries', [undefined, undefined]],
    ['an empty string', ['']],
    ['an object with no message', [{ message: undefined }]],
    ['a mix of all of them', [undefined, '', { message: undefined }]],
  ])('renders nothing at all when every entry is falsy: %s', (_label, errors) => {
    const wrapper = mount(FieldError, { props: { errors } })

    // An empty role="alert" is announced as nothing by some readers and as noise by
    // others, and an empty <ul> is a list landmark with no items.
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.find('ul').exists()).toBe(false)
    expect(wrapper.html()).toBe('<!--v-if-->')
  })

  it('lists two DISTINCT errors as list items, in order', () => {
    const wrapper = mount(FieldError, { props: { errors: ['Too short.', 'Needs a digit.'] } })

    expect(wrapper.attributes('role')).toBe('alert')
    expect(wrapper.findAll('li').map((li) => li.text())).toEqual(['Too short.', 'Needs a digit.'])
  })

  it('shows two IDENTICAL errors once, as plain text and not as a one-item list', () => {
    const wrapper = mount(FieldError, {
      props: { errors: ['Enter your name.', 'Enter your name.'] },
    })

    expect(wrapper.text()).toBe('Enter your name.')
    expect(wrapper.find('ul').exists()).toBe(false)
  })

  it('de-duplicates by message across string and object entries', () => {
    const wrapper = mount(FieldError, {
      props: { errors: ['Same.', { message: 'Same.' }, { message: 'Other.' }] },
    })

    expect(wrapper.findAll('li').map((li) => li.text())).toEqual(['Same.', 'Other.'])
  })

  it('ignores a falsy entry among real ones', () => {
    const wrapper = mount(FieldError, { props: { errors: [undefined, 'Only this.', ''] } })

    expect(wrapper.text()).toBe('Only this.')
    expect(wrapper.find('ul').exists()).toBe(false)
  })

  it('keeps each list item with its own message when the errors change (keyed on the message)', async () => {
    const wrapper = mount(FieldError, { props: { errors: ['First.', 'Second.'] } })
    const second = wrapper.findAll('li')[1]?.element

    await wrapper.setProps({ errors: ['Zeroth.', 'First.', 'Second.'] })

    // With an index key the node that held "Second." is reused for "First."; with the
    // message as the key it is the same element, moved.
    const items = wrapper.findAll('li')
    expect(items.map((li) => li.text())).toEqual(['Zeroth.', 'First.', 'Second.'])
    expect(items[2]?.element).toBe(second)
  })
})

describe('Input', () => {
  it('renders a real <input> that forwards the attributes the form sets', () => {
    const wrapper = mount(Input, {
      attrs: {
        id: 'reusable-identity-email',
        type: 'email',
        autocomplete: 'email',
        required: true,
        'aria-invalid': 'true',
        'aria-describedby': 'reusable-identity-email-error',
      },
    })

    const input = wrapper.get('input')
    expect(input.attributes('id')).toBe('reusable-identity-email')
    expect(input.attributes('type')).toBe('email')
    expect(input.attributes('autocomplete')).toBe('email')
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(input.attributes('aria-describedby')).toBe('reusable-identity-email-error')
    expect(input.element.required).toBe(true)
  })

  it('emits update:modelValue with the typed value', async () => {
    const wrapper = mount(Input, { props: { modelValue: '' } })

    await wrapper.get('input').setValue('Ada Lovelace')

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['Ada Lovelace'])
  })

  it('shows not-allowed on a disabled input, so it must not also be pointer-events-none', () => {
    // DESIGN.md section 5: disabled states use `cursor: not-allowed`, vendored source
    // included. An element with `pointer-events: none` is never the hit-test target,
    // so the browser takes the cursor from whatever sits beneath it and
    // `cursor-not-allowed` could never render. `disabled` already blocks interaction
    // natively, so dropping `pointer-events-none` costs no protection. This asserts
    // the RENDERED class list: a source grep cannot see a `cn()` call that dropped
    // the base list.
    const classes = mount(Input, { attrs: { disabled: true } })
      .get('input')
      .classes()

    expect(classes).toContain('disabled:cursor-not-allowed')
    expect(classes).not.toContain('disabled:pointer-events-none')
  })

  it('reflects the modelValue it is given', () => {
    const wrapper = mount(Input, { props: { modelValue: 'ada@example.com' } })

    expect(wrapper.get('input').element.value).toBe('ada@example.com')
  })
})
