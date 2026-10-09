/**
 * CallPanel — the side panel of the candidate call screen
 * (candidate-interview-call-ui, UI-06; design D7, D8; DESIGN.md §7.3, §9.3).
 *
 * What is pinned here is the arithmetic and what the panel must NEVER say:
 *   - "Domanda n di total" with `n` clamped to `total`, and a progress bar whose
 *     `aria-valuetext` is exactly the visible text;
 *   - a duration stated as a MAXIMUM (`total x 300 s`), minutes never wrapped at 60;
 *   - no competency code or name anywhere, even when the surrounding store holds
 *     one: a candidate must not be able to read, or have read to them, which
 *     competency is being assessed;
 *   - Exit before the help link in DOM order.
 *
 * `$t` is backed by the REAL `it.json` / `en.json`, with `{param}` interpolation,
 * so the assertions read the shipped copy.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import CallPanel from '~/app/components/organisms/CallPanel.vue'
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

const mounted: VueWrapper[] = []

function mountPanel(
  props: Record<string, unknown> = { ended: 1, total: 5, elapsedSeconds: 192 },
  locale: unknown = it_,
  slots: Record<string, string> = {
    exit: '<button data-testid="slot-exit">Exit</button>',
    help: '<a data-testid="slot-help" href="#">Help</a>',
  }
) {
  const wrapper = mount(CallPanel, {
    props,
    slots,
    global: { mocks: { $t: translator(locale) } },
  })
  mounted.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  vi.useRealTimers()
})

function bar(wrapper: VueWrapper) {
  return wrapper.get('[role="progressbar"]')
}

describe('CallPanel — progress', () => {
  it('reads "Domanda 2 di 5" for ended = 1, total = 5', () => {
    const wrapper = mountPanel()

    expect(wrapper.get('[data-testid="call-panel-progress-text"]').text()).toBe('Domanda 2 di 5')
  })

  it('reads "Question 2 of 5" in English', () => {
    const wrapper = mountPanel({ ended: 1, total: 5, elapsedSeconds: 0 }, en)

    expect(wrapper.get('[data-testid="call-panel-progress-text"]').text()).toBe('Question 2 of 5')
  })

  it('reports the bar as ended / total with a valuetext equal to the visible text', () => {
    const wrapper = mountPanel()

    expect(bar(wrapper).attributes('aria-valuenow')).toBe('1')
    expect(bar(wrapper).attributes('aria-valuemax')).toBe('5')
    expect(bar(wrapper).attributes('aria-valuemin')).toBe('0')
    expect(bar(wrapper).attributes('aria-valuetext')).toBe('Domanda 2 di 5')
  })

  it('starts at question 1 when nothing has ended yet', () => {
    const wrapper = mountPanel({ ended: null, total: 5, elapsedSeconds: 0 })

    expect(wrapper.get('[data-testid="call-panel-progress-text"]').text()).toBe('Domanda 1 di 5')
    expect(bar(wrapper).attributes('aria-valuenow')).toBe('0')
  })

  it('never shows n above total, even when every competency has ended', () => {
    const wrapper = mountPanel({ ended: 5, total: 5, elapsedSeconds: 0 })

    expect(wrapper.get('[data-testid="call-panel-progress-text"]').text()).toBe('Domanda 5 di 5')
    expect(bar(wrapper).attributes('aria-valuetext')).toBe('Domanda 5 di 5')
    expect(bar(wrapper).attributes('aria-valuenow')).toBe('5')
  })

  it('never shows n above total when the server count overshoots', () => {
    const wrapper = mountPanel({ ended: 9, total: 5, elapsedSeconds: 0 })

    expect(wrapper.get('[data-testid="call-panel-progress-text"]').text()).toBe('Domanda 5 di 5')
    expect(bar(wrapper).attributes('aria-valuenow')).toBe('5')
  })

  it('does not print the bar counts a second time next to the sentence', () => {
    const wrapper = mountPanel()

    expect(wrapper.text()).not.toContain('1 / 5')
    expect(wrapper.text()).not.toContain('20%')
  })
})

describe('CallPanel — duration', () => {
  it('reads "03:12 / 25:00" for 192 s elapsed out of 5 competencies', () => {
    const wrapper = mountPanel({ ended: 1, total: 5, elapsedSeconds: 192 })

    expect(wrapper.get('[data-testid="call-panel-duration-value"]').text()).toBe('03:12 / 25:00')
  })

  it('reads 90:00 as the total for 18 competencies', () => {
    const wrapper = mountPanel({ ended: 0, total: 18, elapsedSeconds: 0 })

    expect(wrapper.get('[data-testid="call-panel-duration-value"]').text()).toBe('00:00 / 90:00')
  })

  it('does not wrap minutes at 60 on the elapsed side either', () => {
    const wrapper = mountPanel({ ended: 12, total: 18, elapsedSeconds: 3725 })

    expect(wrapper.get('[data-testid="call-panel-duration-value"]').text()).toBe('62:05 / 90:00')
  })

  it('gives screen readers the stated maximum, and hides the visual figure from them', () => {
    const wrapper = mountPanel({ ended: 1, total: 5, elapsedSeconds: 192 })

    expect(wrapper.get('[data-testid="call-panel-duration-value"]').attributes('aria-hidden')).toBe(
      'true'
    )
    expect(wrapper.get('[data-testid="call-panel-duration-sr"]').text()).toBe(
      '03:12 trascorsi su un massimo di 25:00'
    )
  })

  it('reads the English screen-reader text', () => {
    const wrapper = mountPanel({ ended: 1, total: 5, elapsedSeconds: 192 }, en)

    expect(wrapper.get('[data-testid="call-panel-duration-sr"]').text()).toBe(
      '03:12 elapsed out of a maximum of 25:00'
    )
  })

  it('labels the figure', () => {
    const wrapper = mountPanel()

    expect(wrapper.get('[data-testid="call-panel-duration"]').text()).toContain('Durata')
  })

  it('derives the total from a per-question limit that can be overridden', () => {
    const wrapper = mountPanel({
      ended: 0,
      total: 2,
      elapsedSeconds: 0,
      secondsPerQuestion: 60,
    })

    expect(wrapper.get('[data-testid="call-panel-duration-value"]').text()).toBe('00:00 / 02:00')
  })
})

describe('CallPanel — until the server states a total', () => {
  it.each([null, 0, -1])('hides the progress and the duration for total = %s', (total) => {
    const wrapper = mountPanel({ ended: null, total, elapsedSeconds: 12 })

    expect(wrapper.find('[data-testid="call-panel-progress"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="call-panel-duration"]').exists()).toBe(false)
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
  })

  it('still offers Exit and help, so the candidate is never locked in during the first question', () => {
    const wrapper = mountPanel({ ended: null, total: null, elapsedSeconds: 0 })

    expect(wrapper.find('[data-testid="call-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="slot-exit"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="slot-help"]').exists()).toBe(true)
  })
})

describe('CallPanel — landmark and order', () => {
  it('is an <aside> named by interview.call.panel_label', () => {
    const wrapper = mountPanel()
    const aside = wrapper.get('aside')

    expect(aside.attributes('aria-label')).toBe('Avanzamento del colloquio')
    expect(aside.attributes('data-testid')).toBe('call-panel')
  })

  it('puts Exit before the help link in DOM order', () => {
    const wrapper = mountPanel()
    const html = wrapper.html()

    expect(html.indexOf('data-testid="slot-exit"')).toBeGreaterThan(-1)
    expect(html.indexOf('data-testid="slot-exit"')).toBeLessThan(
      html.indexOf('data-testid="slot-help"')
    )
  })

  it('puts progress, then duration, then the question timer, then Exit', () => {
    const wrapper = mountPanel({ ended: 1, total: 5, elapsedSeconds: 0, questionSeconds: 300 })
    const html = wrapper.html()
    const positions = [
      'data-testid="call-panel-progress"',
      'data-testid="call-panel-duration"',
      'role="timer"',
      'data-testid="slot-exit"',
    ].map((needle) => html.indexOf(needle))

    expect(positions.every((p) => p > -1)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })
})

describe('CallPanel — the question timer', () => {
  it('renders no timer unless a remaining time is handed in', () => {
    const wrapper = mountPanel()

    expect(wrapper.find('[role="timer"]').exists()).toBe(false)
  })

  it('renders one counter labelled "Tempo rimanente per questa domanda"', () => {
    const wrapper = mountPanel({ ended: 1, total: 5, elapsedSeconds: 0, questionSeconds: 252 })
    const timers = wrapper.findAll('[role="timer"]')

    expect(timers).toHaveLength(1)
    expect(timers[0]!.text()).toBe('04:12')
    expect(timers[0]!.attributes('aria-label')).toBe('Tempo rimanente per questa domanda')
    expect(wrapper.text()).toContain('Tempo rimanente per questa domanda')
  })

  it('forwards every tick of the counter with its remaining seconds', async () => {
    vi.useFakeTimers()
    const wrapper = mountPanel({ ended: 1, total: 5, elapsedSeconds: 0, questionSeconds: 3 })

    expect(wrapper.emitted('tick')).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.emitted('tick')).toEqual([[2]])
    expect(wrapper.emitted('expired')).toBeUndefined()

    // The final 0 is reported too, before the expiry.
    await vi.advanceTimersByTimeAsync(2000)
    expect(wrapper.emitted('tick')).toEqual([[2], [1], [0]])
    expect(wrapper.emitted('expired')).toHaveLength(1)
  })

  it('starts the counter again when the timer key changes, and not otherwise', async () => {
    vi.useFakeTimers()
    const wrapper = mountPanel({
      ended: 0,
      total: 5,
      elapsedSeconds: 0,
      questionSeconds: 300,
      timerKey: 41,
    })
    const shown = () => wrapper.get('[role="timer"]').text()

    await vi.advanceTimersByTimeAsync(3000)
    expect(shown()).toBe('04:57')

    // The same competency session re-rendering with a fresh remaining time must not rewind it.
    await wrapper.setProps({ questionSeconds: 297 })
    expect(shown()).toBe('04:57')

    // A new competency session (a handover keeps the screen live) is a new question: a full clock.
    await wrapper.setProps({ questionSeconds: 300, timerKey: 42 })
    expect(shown()).toBe('05:00')
  })

  it('forwards tick and expired from the counter', async () => {
    const wrapper = mountPanel({ ended: 1, total: 5, elapsedSeconds: 0, questionSeconds: 0 })

    // seconds = 0 expires on mount, which is the shortest path to the event.
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('expired')).toBeTruthy()
  })
})

// A candidate must not learn which competency is being assessed. The panel is
// handed progress NUMBERS only; this proves that even when the store the page
// reads from holds a code and a name, nothing of them can surface, in an element,
// an attribute or an accessible name.
describe('CallPanel — never names a competency', () => {
  const store = reactive({
    endedCompetencies: 1 as number | null,
    totalCompetencies: 5 as number | null,
    competencyCode: 'COL',
    competencyName: 'Collaboration',
    competency_code: 'COL',
  })

  function mountFromStore() {
    const Host = defineComponent({
      setup: () => () =>
        h(
          CallPanel,
          {
            ended: store.endedCompetencies,
            total: store.totalCompetencies,
            elapsedSeconds: 192,
            questionSeconds: 250,
          },
          { exit: () => h('button', 'Exit'), help: () => h('a', 'Help') }
        ),
    })
    const wrapper = mount(Host, { global: { mocks: { $t: translator(en) } } })
    mounted.push(wrapper)
    return wrapper
  }

  function everyAttributeValue(root: Element): string[] {
    return [root, ...Array.from(root.querySelectorAll('*'))].flatMap((el) =>
      Array.from(el.attributes).map((attr) => `${attr.name}=${attr.value}`)
    )
  }

  it('renders no code or name in any text node', () => {
    const wrapper = mountFromStore()

    expect(wrapper.text()).not.toContain('COL')
    expect(wrapper.text().toLowerCase()).not.toContain('collaboration')
  })

  it('renders no code or name in any attribute, including every aria-label and aria-valuetext', () => {
    const wrapper = mountFromStore()
    const attributes = everyAttributeValue(wrapper.element).join('\n')

    expect(attributes).not.toContain('COL')
    expect(attributes.toLowerCase()).not.toContain('collaboration')
    expect(wrapper.html()).not.toContain('COL')
  })

  it('does not even read competency fields: the source names none of them and imports no session', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/components/organisms/CallPanel.vue'),
      'utf-8'
    )

    expect(source).not.toMatch(/competencyCode|competency_code|competencyName|currentCompetency/)
    expect(source).not.toMatch(/useInterviewSession/)
  })
})
