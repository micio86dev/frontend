/**
 * Button — the loading state is one statement, not three.
 *
 * A submit that is in flight has to say so three ways at once: a spinner so it
 * is visible, `disabled` so a second click cannot fire the same request twice,
 * and `aria-busy` so the state exists for someone who cannot see the spinner.
 * They live on one prop precisely so no call site can ship one without the
 * others — which is what happened before, with five hand-copied
 * disabled-while-saving buttons and not one spinner among them.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { Button } from '../../app/components/ui/button'

describe('Button — loading', () => {
  it('shows a spinner, disables itself, and announces aria-busy', () => {
    const wrapper = mount(Button, { props: { loading: true }, slots: { default: 'Save' } })

    expect(wrapper.find('[data-testid="button-spinner"]').exists()).toBe(true)
    expect(wrapper.attributes('disabled')).toBeDefined()
    expect(wrapper.attributes('aria-busy')).toBe('true')
  })

  it('keeps its own label while busy', () => {
    // Swapping the label to "Saving…" moves the control under the pointer
    // about to click it, and re-announces it to a screen reader as a different
    // button. `aria-busy` carries the state instead.
    const wrapper = mount(Button, { props: { loading: true }, slots: { default: 'Save' } })

    expect(wrapper.text()).toContain('Save')
  })

  it('is inert in every sense when idle', () => {
    const wrapper = mount(Button, { slots: { default: 'Save' } })

    expect(wrapper.find('[data-testid="button-spinner"]').exists()).toBe(false)
    expect(wrapper.attributes('disabled')).toBeUndefined()
    expect(wrapper.attributes('aria-busy')).toBeUndefined()
  })

  it('still honours a plain disabled, with no spinner', () => {
    // Unavailable is not the same as working. A spinner on a control that is
    // merely not applicable would promise something is happening.
    const wrapper = mount(Button, { props: { disabled: true }, slots: { default: 'Save' } })

    expect(wrapper.attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="button-spinner"]').exists()).toBe(false)
    expect(wrapper.attributes('aria-busy')).toBeUndefined()
  })
})
