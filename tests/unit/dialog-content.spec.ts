/**
 * DialogContent — the panel reka-ui's DialogRoot teleports to `document.body`.
 *
 * Mounted through a full `Dialog` composition rather than standalone:
 * `DialogContent`'s own children (`DialogOverlay`, the close button's
 * `DialogClose`) read reka-ui's dialog context, which only a `DialogRoot`
 * ancestor provides — mounting it alone throws.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { Dialog, DialogContent } from '../../app/components/ui/dialog'

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

// reka-ui's DialogRoot opens through its own reactive state and teleports
// DialogContent to `document.body`; that render lands a tick after mount, so
// every assertion here reads `document` rather than the returned wrapper.
async function mountOpenDialog(showCloseButton?: boolean) {
  const Host = defineComponent({
    setup: () => () =>
      h(Dialog, { defaultOpen: true }, () => [
        h(DialogContent, { showCloseButton }, () => 'Panel body'),
      ]),
  })

  wrapper = mount(Host, {
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key } },
  })
  await nextTick()
  await nextTick()
}

describe('DialogContent', () => {
  it('shows the close button by default', async () => {
    await mountOpenDialog()

    const closeLabel = document.querySelector('[data-slot="dialog-content"] button .sr-only')
    expect(closeLabel?.textContent).toBe('common.close')
  })

  it('hides the close button when explicitly disabled', async () => {
    await mountOpenDialog(false)

    expect(document.querySelector('[data-slot="dialog-content"] button')).toBeNull()
  })

  it('renders its slot content', async () => {
    await mountOpenDialog()

    expect(document.querySelector('[data-slot="dialog-content"]')?.textContent).toContain(
      'Panel body'
    )
  })
})
