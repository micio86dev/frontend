/**
 * DialogFooter — a plain flex container, EXCEPT for its own optional close
 * button, which (unlike DialogContent's) defaults OFF: a footer with a
 * caller-supplied action row that also grows a second, redundant "Close"
 * would confuse which control actually submits.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { Dialog, DialogContent, DialogFooter } from '../../app/components/ui/dialog'

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

// Same teleport-timing note as dialog-content.spec.ts — assertions read
// `document`, one tick after mount, not the returned wrapper.
async function mountOpenFooter(showCloseButton?: boolean) {
  const Host = defineComponent({
    setup: () => () =>
      h(Dialog, { defaultOpen: true }, () => [
        h(DialogContent, { showCloseButton: false }, () => [
          h(DialogFooter, { showCloseButton }, () => 'Actions'),
        ]),
      ]),
  })

  wrapper = mount(Host, {
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key } },
  })
  await nextTick()
  await nextTick()
}

describe('DialogFooter', () => {
  it('renders no close button by default', async () => {
    await mountOpenFooter()

    expect(document.querySelector('[data-slot="dialog-footer"] button')).toBeNull()
  })

  it('renders a labelled close button when explicitly enabled', async () => {
    await mountOpenFooter(true)

    const button = document.querySelector('[data-slot="dialog-footer"] button')
    expect(button?.textContent).toBe('common.close')
  })

  it('renders its slot content alongside an enabled close button', async () => {
    await mountOpenFooter(true)

    expect(document.querySelector('[data-slot="dialog-footer"]')?.textContent).toContain('Actions')
  })
})
