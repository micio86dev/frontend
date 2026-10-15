/**
 * CallQuestion — the captions overlay on the interviewer's video
 * (candidate-interview-call-ui, UI-04; live-interview-call-chrome D8; DESIGN.md §7.3, §9.2).
 *
 * It used to be a white band under the tile; it is now the captions overlay, which the
 * candidate can turn off. The contract worth pinning is the screen-reader and keyboard
 * behaviour, plus the few classes that carry a guarantee (opaque backing, the 4.5:1 prefix
 * token, the inset that keeps it off the name chip and the own tile):
 *   - ONE persistent `aria-live="polite"` `aria-atomic="true"` region, so a new
 *     question is announced as a whole instead of being re-created per update;
 *   - the text stays until the next avatar utterance replaces it;
 *   - focus moves to the band at a competency boundary only, on the parent's
 *     explicit call, never because the text changed, and never out of an open
 *     dialog;
 *   - captions off hides every VISIBLE word (`sr-only`, no tabindex, no focus) while
 *     the region stays mounted and keeps being written to.
 *
 * `$t` is backed by the REAL `en.json`, so the assertions read the shipped copy.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import CallQuestion from '~/app/components/molecules/CallQuestion.vue'
import { captionPages, captionPageMs } from '~/app/utils/caption-pages'
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

function mountBand(text = '', extra: Record<string, unknown> = {}) {
  const wrapper = mount(CallQuestion, {
    props: { text, speakerName: 'Giulia', ...extra },
    attachTo: document.body,
    global: { mocks: { $t: resolveEn } },
  })
  mounted.push(wrapper)
  return wrapper
}

function region(wrapper: VueWrapper) {
  return wrapper.get('[data-testid="call-question"]')
}

/** The question text itself, without the speaker prefix. */
function shown(wrapper: VueWrapper) {
  return wrapper.get('[data-testid="call-question-text"]').text()
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

    expect(shown(wrapper)).toBe('Tell me about a time you led a change.')
    expect(region(wrapper).text()).not.toContain(HINT)
  })

  it('keeps the text until the next one replaces it', async () => {
    const wrapper = mountBand('First question')

    expect(shown(wrapper)).toBe('First question')

    await wrapper.setProps({ text: 'A follow-up' })

    expect(shown(wrapper)).toBe('A follow-up')
  })

  it('shows the listen hint while there is no text, and steps aside for the first one', async () => {
    const wrapper = mountBand('')

    expect(region(wrapper).text()).toBe(HINT)

    await wrapper.setProps({ text: 'Now a question' })

    expect(shown(wrapper)).toBe('Now a question')
  })

  it('returns to the hint when the text is cleared at a boundary', async () => {
    const wrapper = mountBand('Closing phrase of the previous competency')

    await wrapper.setProps({ text: '' })

    expect(region(wrapper).text()).toBe(HINT)
  })
})

describe('CallQuestion — a long utterance is paged', () => {
  // Distinct sentences, so every page differs and a wrong page is visible.
  const LONG = Array.from(
    { length: 8 },
    (_, i) => `Sentence number ${i + 1} of the welcome, said by the interviewer today.`
  ).join(' ')

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the first page, then the next ones at the speech pace, and keeps the last', async () => {
    vi.useFakeTimers()
    const pages = captionPages(LONG)
    const wrapper = mountBand(LONG)

    expect(pages.length).toBeGreaterThan(2)
    expect(shown(wrapper)).toBe(pages[0])

    for (let i = 1; i < pages.length; i++) {
      await vi.advanceTimersByTimeAsync(captionPageMs(pages[i - 1]!))
      expect(shown(wrapper)).toBe(pages[i])
    }

    await vi.advanceTimersByTimeAsync(60_000)
    expect(shown(wrapper)).toBe(pages.at(-1))
  })

  it('starts again from the first page of a new utterance', async () => {
    vi.useFakeTimers()
    const wrapper = mountBand(LONG)

    await vi.advanceTimersByTimeAsync(captionPageMs(captionPages(LONG)[0]!))
    await wrapper.setProps({ text: 'A follow-up' })
    await vi.advanceTimersByTimeAsync(60_000)

    expect(shown(wrapper)).toBe('A follow-up')
  })

  it('starts again from the first page when the same utterance is said again', async () => {
    vi.useFakeTimers()
    const pages = captionPages(LONG)
    const wrapper = mountBand(LONG, { utteranceKey: 1 })

    await vi.advanceTimersByTimeAsync(captionPageMs(pages[0]!))
    expect(shown(wrapper)).toBe(pages[1])

    await wrapper.setProps({ utteranceKey: 2 })

    expect(shown(wrapper)).toBe(pages[0])
  })

  it('leaves no page timer behind once unmounted', () => {
    vi.useFakeTimers()
    const wrapper = mountBand(LONG)

    expect(vi.getTimerCount()).toBe(1)
    wrapper.unmount()
    mounted.splice(mounted.indexOf(wrapper), 1)

    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows the page being said when captions are turned back on', async () => {
    vi.useFakeTimers()
    const pages = captionPages(LONG)
    const wrapper = mountBand(LONG, { visible: false })

    await vi.advanceTimersByTimeAsync(captionPageMs(pages[0]!))
    await wrapper.setProps({ visible: true })

    expect(shown(wrapper)).toBe(pages[1])
  })

  it('writes the whole utterance at once while captions are off', () => {
    const wrapper = mountBand(LONG, { visible: false })

    expect(shown(wrapper)).toBe(LONG)
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

describe('CallQuestion — the speaker prefix', () => {
  it('starts each caption with the interviewer name, in the 4.5:1 caption token', () => {
    const wrapper = mountBand('Tell me about a change.', { speakerName: 'Giulia' })
    const prefix = wrapper.get('[data-testid="call-question-speaker"]')

    expect(prefix.text()).toBe('Giulia:')
    expect(prefix.classes()).toContain('text-primary-caption')
    expect(prefix.classes()).toContain('font-semibold')
    expect(region(wrapper).text().replace(/\s+/g, ' ')).toBe('Giulia: Tell me about a change.')
  })

  it('shows the name it is handed, including the generic fallback', () => {
    expect(
      mountBand('A question', { speakerName: 'AI interviewer' })
        .get('[data-testid="call-question-speaker"]')
        .text()
    ).toBe('AI interviewer:')
  })

  it('renders a name and a text containing markup as text only', () => {
    const wrapper = mountBand('<img src=x onerror="alert(1)">', {
      speakerName: '<b>Giulia</b>',
    })

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('b').exists()).toBe(false)
    expect(wrapper.get('[data-testid="call-question-speaker"]').text()).toBe('<b>Giulia</b>:')
    expect(shown(wrapper)).toBe('<img src=x onerror="alert(1)">')
  })

  it('carries no prefix on the listen hint', () => {
    const wrapper = mountBand('')

    expect(wrapper.find('[data-testid="call-question-speaker"]').exists()).toBe(false)
    expect(region(wrapper).text()).toBe(HINT)
  })
})

describe('CallQuestion — the overlay', () => {
  it('is on by default: visible, focusable, over the video on an opaque backing', () => {
    const wrapper = mountBand('A question')
    const classes = region(wrapper).classes()

    expect(classes).not.toContain('sr-only')
    expect(region(wrapper).attributes('tabindex')).toBe('0')
    expect(classes).toContain('absolute')
    expect(classes).toContain('z-20')
    // Opaque: any translucency composites against unknown video and voids the contrast guarantee.
    expect(classes).toContain('bg-avatar-bg')
    expect(classes.join(' ')).not.toMatch(/bg-avatar-bg\/|bg-black\/|opacity-/)
    expect(classes).toContain('text-white')
    expect(classes).toContain('max-h-[6rem]')
    expect(classes).toContain('overflow-y-auto')
  })

  it('stays clear of the name chip (bottom left) and of the own tile (bottom right)', () => {
    const classes = region(mountBand('A question')).classes()

    expect(classes).toContain('left-3')
    expect(classes).toContain('bottom-11')
    // The own tile is `w-[clamp(9rem,18%,14rem)]` with a 0.75rem margin: inset by that plus a gap.
    expect(classes).toContain('right-[calc(clamp(9rem,18%,14rem)+1.5rem)]')
  })
})

describe('CallQuestion — captions off', () => {
  it('hides every visible word but keeps the one live region mounted and written to', () => {
    const wrapper = mountBand('A question', { visible: false })

    expect(region(wrapper).classes()).toContain('sr-only')
    expect(region(wrapper).classes()).not.toContain('bg-avatar-bg')
    expect(region(wrapper).attributes('tabindex')).toBeUndefined()
    expect(region(wrapper).text()).toContain('A question')
    expect(wrapper.findAll('[aria-live]')).toHaveLength(1)
    expect(region(wrapper).attributes('aria-live')).toBe('polite')
    expect(region(wrapper).attributes('aria-atomic')).toBe('true')
    expect(region(wrapper).attributes('aria-label')).toBe(REGION_LABEL)
  })

  it('keeps writing new questions into the hidden region, announced politely', async () => {
    const wrapper = mountBand('First', { visible: false })
    const before = region(wrapper).element

    await wrapper.setProps({ text: 'Second' })

    expect(region(wrapper).element).toBe(before)
    expect(shown(wrapper)).toBe('Second')
  })

  it('carries the listen hint for assistive technology when it is off', () => {
    const wrapper = mountBand('', { visible: false })

    expect(region(wrapper).text()).toBe(HINT)
    expect(region(wrapper).classes()).toContain('sr-only')
  })

  it('shows the latest question at once when turned back on', async () => {
    const wrapper = mountBand('The latest', { visible: false })

    await wrapper.setProps({ visible: true })

    expect(region(wrapper).classes()).not.toContain('sr-only')
    expect(region(wrapper).attributes('tabindex')).toBe('0')
    expect(shown(wrapper)).toBe('The latest')
  })

  it('does not move focus at a boundary while off, and does while on', async () => {
    const wrapper = mountBand('A question', { visible: false })
    const focus = vi.spyOn(region(wrapper).element as HTMLElement, 'focus')

    boundary(wrapper)
    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(region(wrapper).element)

    await wrapper.setProps({ visible: true })
    boundary(wrapper)
    expect(focus).toHaveBeenCalledTimes(1)
  })
})
