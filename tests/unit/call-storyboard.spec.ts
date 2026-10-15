/**
 * CallStoryboard — the named path of competencies in the interview panel
 * (live-interview-call-chrome D14 section 2; spec "The Panel Shows The Named Path Of Competencies").
 *
 * Pinned here: outline order, the status carried by an icon AND text (never colour alone),
 * `aria-current="step"` on the current item only, the clamp of "domanda k di n", and that a
 * name is text while a code is never part of the component. `$t` is backed by the REAL
 * `it.json` / `en.json` so the assertions read the shipped copy.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import CallStoryboard from '~/app/components/molecules/CallStoryboard.vue'
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

function translator(locale: unknown) {
  return (key: string, params: Record<string, string | number> = {}): string =>
    lookup(locale, key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))
}

type Status = 'done' | 'current' | 'upcoming' | 'retry'
interface Item {
  name: string
  ordinal: number
  status: Status
  primaryTotal: number
}

const item = (ordinal: number, name: string, status: Status, primaryTotal = 3): Item => ({
  name,
  ordinal,
  status,
  primaryTotal,
})

const THREE: Item[] = [
  item(1, 'Pensiero strategico', 'done'),
  item(2, 'Orientamento al risultato', 'current'),
  item(3, 'Collaborazione', 'upcoming'),
]

const mounted: VueWrapper[] = []

function mountStoryboard(
  items: Item[] = THREE,
  primaryIndex: number | null = 2,
  locale: unknown = it_
) {
  const wrapper = mount(CallStoryboard, {
    props: { items, primaryIndex },
    global: { mocks: { $t: translator(locale) } },
  })
  mounted.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

const rows = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="call-storyboard-item"]')

describe('CallStoryboard - order and status', () => {
  it('is an ordered list of the names in outline order', () => {
    const wrapper = mountStoryboard()

    expect(wrapper.element.tagName).toBe('OL')
    expect(rows(wrapper)).toHaveLength(3)
    expect(
      rows(wrapper).map((row) => row.get('[data-testid="call-storyboard-name"]').text())
    ).toEqual(['Pensiero strategico', 'Orientamento al risultato', 'Collaborazione'])
  })

  it('marks the current item with aria-current="step" and no other', () => {
    const wrapper = mountStoryboard()

    expect(rows(wrapper).map((row) => row.attributes('aria-current'))).toEqual([
      undefined,
      'step',
      undefined,
    ])
  })

  it('marks no item current when none is (every competency closed)', () => {
    const wrapper = mountStoryboard([item(1, 'A', 'done'), item(2, 'B', 'done')], null)

    expect(wrapper.find('[aria-current]').exists()).toBe(false)
  })

  it('done: a check mark and the hidden text "Completata"', () => {
    const wrapper = mountStoryboard()
    const done = rows(wrapper)[0]!

    expect(done.find('[data-icon="check"]').exists()).toBe(true)
    expect(done.get('.sr-only').text()).toBe('Completata')
    expect(rows(wrapper)[2]!.find('[data-icon="check"]').exists()).toBe(false)
  })

  it('upcoming: its 1-based ordinal as a numeral, no icon', () => {
    const wrapper = mountStoryboard()
    const upcoming = rows(wrapper)[2]!

    expect(upcoming.get('[data-testid="call-storyboard-marker"]').text()).toBe('3')
    expect(upcoming.find('svg').exists()).toBe(false)
  })

  it('retry: a retry icon and text, different from upcoming by text and not by colour', () => {
    const wrapper = mountStoryboard([item(1, 'A', 'retry'), item(2, 'B', 'upcoming')], null)
    const [retry, upcoming] = rows(wrapper)

    expect(retry!.find('[data-icon="retry"]').exists()).toBe(true)
    expect(retry!.text()).toContain('Da ripetere')
    expect(upcoming!.text()).not.toContain('Da ripetere')
    expect(upcoming!.find('[data-icon="retry"]').exists()).toBe(false)
  })

  it('reads the English copy', () => {
    const wrapper = mountStoryboard(
      [item(1, 'A', 'done'), item(2, 'B', 'current'), item(3, 'C', 'retry')],
      2,
      en
    )

    expect(rows(wrapper)[0]!.get('.sr-only').text()).toBe('Completed')
    expect(rows(wrapper)[1]!.text()).toContain('In progress · question 2 of 3')
    expect(rows(wrapper)[2]!.text()).toContain('To repeat')
  })
})

describe('CallStoryboard - the "domanda k di n" counter', () => {
  const current = (wrapper: VueWrapper) =>
    rows(wrapper)[1]!.get('[data-testid="call-storyboard-line"]')

  it.each([
    [2, 3, 'In corso · domanda 2 di 3'],
    [1, 3, 'In corso · domanda 1 di 3'],
    [0, 3, 'In corso · domanda 1 di 3'],
    [5, 3, 'In corso · domanda 3 di 3'],
    [-4, 3, 'In corso · domanda 1 di 3'],
    [1, 1, 'In corso · domanda 1 di 1'],
    [null, 3, 'In corso'],
    [2, 0, 'In corso'],
    [null, 0, 'In corso'],
    [Number.NaN, 3, 'In corso'],
  ])('index %s of %s reads "%s"', (primaryIndex, primaryTotal, expected) => {
    const wrapper = mountStoryboard(
      [item(1, 'A', 'done'), item(2, 'B', 'current', primaryTotal), item(3, 'C', 'upcoming')],
      primaryIndex
    )

    expect(current(wrapper).text()).toBe(expected)
  })

  it('a verbatim re-ask (same index) keeps "domanda 2 di 3"; the next response moves it', async () => {
    const wrapper = mountStoryboard(THREE, 2)
    expect(current(wrapper).text()).toBe('In corso · domanda 2 di 3')

    await wrapper.setProps({ primaryIndex: 2 })
    expect(current(wrapper).text()).toBe('In corso · domanda 2 di 3')

    await wrapper.setProps({ primaryIndex: 3 })
    expect(current(wrapper).text()).toBe('In corso · domanda 3 di 3')
  })

  it('only the current item carries a counter', () => {
    const wrapper = mountStoryboard()

    expect(wrapper.text().match(/domanda/g)).toHaveLength(1)
    expect(rows(wrapper)[0]!.find('[data-testid="call-storyboard-line"]').exists()).toBe(false)
    expect(rows(wrapper)[2]!.find('[data-testid="call-storyboard-line"]').exists()).toBe(false)
  })
})

describe('CallStoryboard - names are text, codes are not part of it', () => {
  it('renders markup in a name inert', () => {
    const wrapper = mountStoryboard([item(1, '<img src=x onerror=alert(1)><b>x</b>', 'current')])

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('b').exists()).toBe(false)
    expect(wrapper.get('[data-testid="call-storyboard-name"]').text()).toBe(
      '<img src=x onerror=alert(1)><b>x</b>'
    )
  })

  it('the source names no code field and the DOM shows nothing but names and statuses', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/components/molecules/CallStoryboard.vue'),
      'utf-8'
    )
    const withoutComments = source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

    expect(withoutComments).not.toMatch(/\bcode\b|competency_code|competencyCode/i)
    expect(mountStoryboard().html()).not.toMatch(/\bcode\b/i)
  })
})

describe('CallStoryboard - the internal scroll', () => {
  function overflow(wrapper: VueWrapper, scrollHeight: number, clientHeight: number) {
    const el = wrapper.element as HTMLElement
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
  }

  it('is not a tab stop while everything fits', () => {
    const wrapper = mountStoryboard()

    expect(wrapper.attributes('tabindex')).toBeUndefined()
  })

  it('becomes keyboard reachable (tabindex 0) only when its content overflows, and drops it again', async () => {
    const wrapper = mountStoryboard()

    overflow(wrapper, 400, 200)
    await wrapper.setProps({ items: [...THREE, item(4, 'Quarta', 'upcoming')] })
    expect(wrapper.attributes('tabindex')).toBe('0')

    overflow(wrapper, 200, 200)
    await wrapper.setProps({ items: THREE })
    expect(wrapper.attributes('tabindex')).toBeUndefined()
  })
})

describe('CallStoryboard - locale parity', () => {
  it.each([
    ['it', it_],
    ['en', en],
  ])('%s has every storyboard key as a string', (_name, locale) => {
    for (const key of ['label', 'done', 'retry', 'current', 'current_counted', 'unnamed']) {
      expect(lookup(locale, `interview.call.storyboard.${key}`).length).toBeGreaterThan(0)
    }
  })
})
