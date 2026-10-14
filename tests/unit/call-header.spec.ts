/**
 * CallHeader — the live call's top bar content (live-interview-call-chrome, D13;
 * DESIGN.md §7.0.1, §7.3).
 *
 * What is pinned here: the DOM and tab order (title, clock, Sottotitoli, Microfono,
 * Esci), exactly three controls and no Camera / "Ripeti domanda" / Pausa, a clock
 * with an accessible name that is NOT a live region, `aria-pressed` toggles with a
 * constant visible label and a swapping icon, a microphone that is `aria-disabled`
 * (still focusable) while an interview-owned mute is in force, 44 px targets and
 * it/en key parity.
 *
 * `$t` is backed by the REAL `it.json` / `en.json`, so the assertions read the
 * shipped copy.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import CallHeader from '~/app/components/organisms/CallHeader.vue'
import en from '../../i18n/locales/en.json'
import it_ from '../../i18n/locales/it.json'

function lookup(locale: unknown, key: string): string {
  const found = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      locale
    )
  if (typeof found !== 'string') throw new Error(`locale has no string at "${key}"`)
  return found
}

const translator =
  (locale: unknown) =>
  (key: string, params: Record<string, string | number> = {}): string =>
    lookup(locale, key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))

const BASE = {
  title: 'Colloquio di assessment · Responsabile Vendite',
  elapsedSeconds: 192,
  captionsEnabled: true,
  micMuted: false,
  micDisabled: false,
}

const mounted: VueWrapper[] = []

function mountHeader(props: Record<string, unknown> = {}, locale: unknown = it_) {
  const wrapper = mount(CallHeader, {
    props: { ...BASE, ...props },
    slots: { exit: '<button data-testid="slot-exit">Esci</button>' },
    global: { mocks: { $t: translator(locale) } },
  })
  mounted.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

const captions = (w: VueWrapper) => w.get('[data-testid="call-header-captions"]')
const mic = (w: VueWrapper) => w.get('[data-testid="call-header-mic"]')

describe('CallHeader — composition', () => {
  it('renders the title, the clock and the three controls in this DOM order', () => {
    const wrapper = mountHeader()
    const order = [
      '[data-testid="call-header-title"]',
      '[data-testid="call-header-clock"]',
      '[data-testid="call-header-captions"]',
      '[data-testid="call-header-mic"]',
      '[data-testid="slot-exit"]',
    ].map((selector) => wrapper.get(selector).element)

    for (let i = 1; i < order.length; i++) {
      // 4 = DOCUMENT_POSITION_FOLLOWING: the later element comes after the earlier one.
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & 4).toBe(4)
    }
  })

  it('shows the already-localized title it is handed, verbatim', () => {
    const wrapper = mountHeader({ title: 'Assessment interview · Potential' })

    expect(wrapper.get('[data-testid="call-header-title"]').text()).toBe(
      'Assessment interview · Potential'
    )
  })

  it('has exactly the two toggles plus the Exit slot: no Camera, Ripeti domanda or Pausa', () => {
    const wrapper = mountHeader()
    const names = wrapper.findAll('button').map((b) => b.text())

    expect(names).toEqual(['Sottotitoli', 'Microfono', 'Esci'])
    for (const forbidden of [/camera/i, /fotocamera/i, /ripeti/i, /repeat/i, /pausa/i, /pause/i]) {
      expect(wrapper.text()).not.toMatch(forbidden)
    }
  })

  it('reads the same controls in English', () => {
    const wrapper = mountHeader({}, en)

    expect(wrapper.findAll('button').map((b) => b.text())).toEqual([
      'Captions',
      'Microphone',
      'Esci',
    ])
  })
})

describe('CallHeader — the clock', () => {
  it('is a plain <time> with an sr-only "Tempo trascorso" prefix, not a live region', () => {
    const wrapper = mountHeader({ elapsedSeconds: 192 })
    const clock = wrapper.get('[data-testid="call-header-clock"]')

    expect(clock.get('span.sr-only').text()).toBe('Tempo trascorso')
    expect(clock.get('time').text()).toBe('03:12')
    // Collapsed the way an accessibility tree reads it: the prefix and the time are separate words.
    expect(clock.text().replace(/\s+/g, ' ')).toBe('Tempo trascorso 03:12')
    expect(wrapper.find('[aria-live]').exists()).toBe(false)
    expect(wrapper.find('[role]').exists()).toBe(false)
  })

  it('does not wrap minutes at 60', () => {
    expect(mountHeader({ elapsedSeconds: 5400 }).get('time').text()).toBe('90:00')
  })

  it('is named in English too', () => {
    expect(mountHeader({}, en).get('[data-testid="call-header-clock"] span.sr-only').text()).toBe(
      'Elapsed time'
    )
  })
})

describe('CallHeader — the toggles', () => {
  it('reports captions pressed when on and unpressed when off, with a constant label', () => {
    const on = captions(mountHeader({ captionsEnabled: true }))
    const off = captions(mountHeader({ captionsEnabled: false }))

    expect(on.attributes('aria-pressed')).toBe('true')
    expect(off.attributes('aria-pressed')).toBe('false')
    expect(on.text()).toBe('Sottotitoli')
    expect(off.text()).toBe('Sottotitoli')
  })

  it('swaps the captions icon with the state, so it is never colour alone', () => {
    const on = captions(mountHeader({ captionsEnabled: true })).get('[data-icon]')
    const off = captions(mountHeader({ captionsEnabled: false })).get('[data-icon]')

    expect(on.attributes('data-icon')).toBe('captions')
    expect(off.attributes('data-icon')).toBe('captions-off')
    expect(on.attributes('aria-hidden')).toBe('true')
  })

  it('reports the microphone pressed when open and unpressed with a slashed icon when muted', () => {
    const open = mic(mountHeader({ micMuted: false }))
    const muted = mic(mountHeader({ micMuted: true }))

    expect(open.attributes('aria-pressed')).toBe('true')
    expect(open.get('[data-icon]').attributes('data-icon')).toBe('mic')
    expect(muted.attributes('aria-pressed')).toBe('false')
    expect(muted.get('[data-icon]').attributes('data-icon')).toBe('mic-off')
    expect(muted.text()).toBe('Microfono')
  })

  it('emits toggle-captions and toggle-mic on click', async () => {
    const wrapper = mountHeader()

    await captions(wrapper).trigger('click')
    await mic(wrapper).trigger('click')
    await mic(wrapper).trigger('click')

    expect(wrapper.emitted('toggle-captions')).toHaveLength(1)
    expect(wrapper.emitted('toggle-mic')).toHaveLength(2)
  })

  it('keeps the microphone focusable but inert (aria-disabled) while an interview mute is in force', async () => {
    const wrapper = mountHeader({ micMuted: true, micDisabled: true })
    const button = mic(wrapper)

    expect(button.attributes('aria-disabled')).toBe('true')
    // Not `disabled`: it stays in the tab order and its state is still announced.
    expect(button.attributes('disabled')).toBeUndefined()
    expect(button.attributes('aria-pressed')).toBe('false')

    await button.trigger('click')
    expect(wrapper.emitted('toggle-mic')).toBeUndefined()
  })

  it('is not aria-disabled when the microphone can be changed', () => {
    expect(mic(mountHeader({ micDisabled: false })).attributes('aria-disabled')).toBeUndefined()
  })

  it('gives every control a 44 px target', () => {
    const wrapper = mountHeader()

    for (const control of [captions(wrapper), mic(wrapper)]) {
      expect(control.classes()).toContain('h-(--spacing-control)')
    }
  })
})

describe('CallHeader — copy', () => {
  const KEYS = [
    'interview.call.header.title',
    'interview.call.header.title_with_subject',
    'interview.call.header.potential',
    'interview.call.header.elapsed_sr',
    'interview.call.header.captions',
    'interview.call.header.microphone',
    'interview.call.exit.short',
  ]

  it.each(KEYS)('%s exists in both languages', (key) => {
    expect(lookup(it_, key).trim()).not.toBe('')
    expect(lookup(en, key).trim()).not.toBe('')
  })

  it('composes the documented titles', () => {
    expect(translator(it_)('interview.call.header.title_with_subject', { subject: 'X' })).toBe(
      'Colloquio di assessment · X'
    )
    expect(translator(en)('interview.call.header.title_with_subject', { subject: 'X' })).toBe(
      'Assessment interview · X'
    )
    expect(lookup(it_, 'interview.call.header.title')).toBe('Colloquio di assessment')
    expect(lookup(en, 'interview.call.header.title')).toBe('Assessment interview')
    expect(lookup(it_, 'interview.call.header.potential')).toBe('Potenziale')
    expect(lookup(en, 'interview.call.header.potential')).toBe('Potential')
  })
})
