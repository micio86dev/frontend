/**
 * SelectTrigger — mounted through a full `Select` composition: it reads
 * reka-ui's select context, which only a `SelectRoot` ancestor provides.
 *
 * `size` is the one behavioural prop: it drives `data-size`, which the
 * component's own Tailwind classes key off (`data-[size=default]:h-8`,
 * `data-[size=sm]:h-7`) to pick the trigger's height.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { Select, SelectTrigger } from '../../app/components/ui/select'

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

function mountTrigger(size?: 'sm' | 'default') {
  const Host = defineComponent({
    setup: () => () =>
      h(Select, {}, () => [h(SelectTrigger, { size, 'data-testid': 'trigger' }, () => 'Pick one')]),
  })

  wrapper = mount(Host, { attachTo: document.body })
  return wrapper
}

describe('SelectTrigger', () => {
  it('defaults data-size to "default"', () => {
    mountTrigger()

    expect(document.querySelector('[data-testid="trigger"]')?.getAttribute('data-size')).toBe(
      'default'
    )
  })

  it('honours an explicit "sm" size', () => {
    mountTrigger('sm')

    expect(document.querySelector('[data-testid="trigger"]')?.getAttribute('data-size')).toBe('sm')
  })

  it('renders its slot content', () => {
    mountTrigger()

    expect(document.querySelector('[data-testid="trigger"]')?.textContent).toContain('Pick one')
  })
})
