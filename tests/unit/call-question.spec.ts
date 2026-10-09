/**
 * CallQuestion — the written question band of the candidate call screen
 * (candidate-interview-call-ui, UI-04; design D6; DESIGN.md §7.3 and §9.2).
 *
 * The contract worth pinning is the screen-reader and keyboard behaviour, not
 * the visuals:
 *   - ONE persistent `aria-live="polite"` `aria-atomic="true"` region, so a new
 *     question is announced as a whole instead of being re-created per update;
 *   - the text stays until the next avatar utterance replaces it;
 *   - focus moves to the band at a competency boundary only, on the parent's
 *     explicit call, never because the text changed, and never out of an open
 *     dialog.
 *
 * `$t` is backed by the REAL `en.json`, so the assertions read the shipped copy.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import CallQuestion from '~/app/components/molecules/CallQuestion.vue'
import en from '../../i18n/locales/en.json'

function resolveEn(key: string): string {
  const found = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      en
    )
  if (typeof found !== 'string') throw new Error(`en.json has no string at "${key}"`)
  return found
}

const HINT = resolveEn('interview.live.listen_hint')
const REGION_LABEL = resolveEn('interview.call.question_region')

const mounted: VueWrapper[] = []
const extras: HTMLElement[] = []

function mountBand(text = '') {
  const wrapper = mount(CallQuestion, {
    props: { text },
    attachTo: document.body,
    global: { mocks: { $t: resolveEn } },
  })
  mounted.push(wrapper)
  return wrapper
}

function region(wrapper: VueWrapper) {
  return wrapper.get('[data-testid="call-question"]')
}

function boundary(wrapper: VueWrapper) {
  ;(wrapper.vm as unknown as { focusOnBoundary: () => void }).focusOnBoundary()
}

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  while (extras.length) extras.pop()!.remove()
  vi.restoreAllMocks()
})

describe('CallQuestion — what it shows', () => {
  it("shows the avatar's text", () => {
    const wrapper = mountBand('Tell me about a time you led a change.')

    expect(region(wrapper).text()).toBe('Tell me about a time you led a change.')
    expect(region(wrapper).text()).not.toContain(HINT)
  })

  it('keeps the text until the next one replaces it', async () => {
    const wrapper = mountBand('First question')

    expect(region(wrapper).text()).toBe('First question')

    await wrapper.setProps({ text: 'A follow-up' })

    expect(region(wrapper).text()).toBe('A follow-up')
  })

  it('shows the listen hint while there is no text, and steps aside for the first one', async () => {
    const wrapper = mountBand('')

    expect(region(wrapper).text()).toBe(HINT)

    await wrapper.setProps({ text: 'Now a question' })

    expect(region(wrapper).text()).toBe('Now a question')
  })

  it('returns to the hint when the text is cleared at a boundary', async () => {
    const wrapper = mountBand('Closing phrase of the previous competency')

    await wrapper.setProps({ text: '' })

    expect(region(wrapper).text()).toBe(HINT)
  })
})

describe('CallQuestion — the live region', () => {
  it('is one polite, atomic region labelled "Current question"', () => {
    const wrapper = mountBand('A question')
    const live = wrapper.findAll('[aria-live]')

    expect(live).toHaveLength(1)
    expect(live[0]!.element).toBe(region(wrapper).element)
    expect(region(wrapper).attributes('aria-live')).toBe('polite')
    expect(region(wrapper).attributes('aria-atomic')).toBe('true')
    expect(region(wrapper).attributes('aria-label')).toBe(REGION_LABEL)
    expect(REGION_LABEL).toBe('Current question')
  })

  it('stays the same mounted element across hint, text and replacement', async () => {
    const wrapper = mountBand('')
    const before = region(wrapper).element

    await wrapper.setProps({ text: 'One' })
    await wrapper.setProps({ text: 'Two' })
    await wrapper.setProps({ text: '' })

    expect(region(wrapper).element).toBe(before)
    expect(wrapper.findAll('[aria-live]')).toHaveLength(1)
    expect(region(wrapper).attributes('aria-atomic')).toBe('true')
  })

  it('is keyboard reachable because it can scroll', () => {
    expect(region(mountBand('A question')).attributes('tabindex')).toBe('0')
  })
})

describe('CallQuestion — focus at a competency boundary', () => {
  it('focuses the band when the parent crosses a boundary', () => {
    const wrapper = mountBand('A question')

    boundary(wrapper)

    expect(document.activeElement).toBe(region(wrapper).element)
  })

  it('never moves focus because the text changed', async () => {
    const wrapper = mountBand('First')
    const focus = vi.spyOn(region(wrapper).element as HTMLElement, 'focus')

    await wrapper.setProps({ text: 'Second' })
    await wrapper.setProps({ text: '' })
    await wrapper.setProps({ text: 'Third' })

    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(region(wrapper).element)
  })

  it('focuses once per boundary call', () => {
    const wrapper = mountBand('A question')
    const focus = vi.spyOn(region(wrapper).element as HTMLElement, 'focus')

    boundary(wrapper)

    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('does not steal focus from an open dialog', () => {
    const wrapper = mountBand('A question')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-state', 'open')
    const confirm = document.createElement('button')
    dialog.appendChild(confirm)
    document.body.appendChild(dialog)
    extras.push(dialog)
    confirm.focus()
    const focus = vi.spyOn(region(wrapper).element as HTMLElement, 'focus')

    boundary(wrapper)

    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(confirm)
  })

  it('treats a dialog with no data-state as open, and does not steal focus from it', () => {
    // The guard excludes only an explicit `data-state="closed"`: a dialog-role
    // element that carries no state at all is assumed open (conservative).
    const wrapper = mountBand('A question')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const confirm = document.createElement('button')
    dialog.appendChild(confirm)
    document.body.appendChild(dialog)
    extras.push(dialog)
    confirm.focus()
    const focus = vi.spyOn(region(wrapper).element as HTMLElement, 'focus')

    boundary(wrapper)

    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(confirm)
  })

  it('focuses again once the dialog has closed', () => {
    const wrapper = mountBand('A question')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'alertdialog')
    dialog.setAttribute('data-state', 'closed')
    document.body.appendChild(dialog)
    extras.push(dialog)

    boundary(wrapper)

    expect(document.activeElement).toBe(region(wrapper).element)
  })
})
