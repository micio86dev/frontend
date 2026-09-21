/**
 * SelectContent — the dropdown panel reka-ui teleports to `document.body`
 * while the select is open.
 *
 * `position`/`align` are the two layout defaults ("item-aligned"/"center")
 * this component pins so every dropdown in the app opens the same way
 * unless a caller deliberately overrides it.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { Select, SelectContent, SelectItem, SelectTrigger } from '../../app/components/ui/select'

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

// Same teleport-timing note as dialog-content.spec.ts — assertions read
// `document`, one tick after mount, not the returned wrapper.
async function mountOpenSelect(position?: 'item-aligned' | 'popper') {
  const Host = defineComponent({
    setup: () => () =>
      h(Select, { open: true }, () => [
        h(SelectTrigger, {}, () => 'Pick one'),
        h(SelectContent, { position, 'data-testid': 'content' }, () => [
          h(SelectItem, { value: 'a' }, () => 'Option A'),
        ]),
      ]),
  })

  wrapper = mount(Host, { attachTo: document.body })
  await nextTick()
  await nextTick()
}

describe('SelectContent', () => {
  it('defaults position to "item-aligned"', async () => {
    await mountOpenSelect()

    // reka-ui's own SelectContent only forwards `position` to the DOM for
    // "popper" mode — "item-aligned" is its internal default, surfaced here
    // instead through this component's own `data-align-trigger` marker
    // (`:data-align-trigger="position === 'item-aligned'"`).
    expect(
      document.querySelector('[data-slot="select-content"]')?.getAttribute('data-align-trigger')
    ).toBe('true')
  })

  it('honours an explicit "popper" position', async () => {
    await mountOpenSelect('popper')

    expect(document.querySelector('[data-slot="select-content"]')?.getAttribute('position')).toBe(
      'popper'
    )
  })

  it('renders its slotted items while open', async () => {
    await mountOpenSelect()

    expect(document.querySelector('[data-slot="select-content"]')?.textContent).toContain(
      'Option A'
    )
  })
})
