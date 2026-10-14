/**
 * CallPanel — the side panel of the candidate call screen
 * (candidate-interview-call-ui, UI-06; design D7, D8; DESIGN.md §7.3, §9.3).
 *
 * What is pinned here is the arithmetic and what the panel must NEVER say:
 *   - the "Percorso" section: "Competenza n di total" with `n` clamped to `total`, a
 *     progress bar whose `aria-valuetext` is exactly the visible text, and the named
 *     storyboard under it (live-interview-call-chrome D14);
 *   - a duration stated as a MAXIMUM (`total x 300 s`), minutes never wrapped at 60;
 *   - competency NAMES from the outline may appear, a competency CODE never does, even
 *     when the surrounding store holds one;
 *   - the help link last in DOM order; Exit lives in the call header.
 *
 * `$t` is backed by the REAL `it.json` / `en.json`, with `{param}` interpolation,
 * so the assertions read the shipped copy.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
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

/** `$t(key, params)` or, for a plural, `$t(key, count)` with `a | b` choices (one, then other). */
function translator(locale: unknown) {
  return (key: string, params: Record<string, string | number> | number = {}): string => {
    const raw = lookup(locale, key)
    const choices = raw.split(' | ')
    const named = typeof params === 'number' ? { n: params, count: params } : params
    const message =
      typeof params === 'number' && choices.length > 1 ? choices[params === 1 ? 0 : 1]! : raw

    return message.replace(/\{(\w+)\}/g, (_, name: string) => String(named[name] ?? ''))
  }
}

const mounted: VueWrapper[] = []

function mountPanel(
  props: Record<string, unknown> = { ended: 1, total: 5, elapsedSeconds: 192 },
  locale: unknown = it_,
  slots: Record<string, string> = {
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

type Status = 'done' | 'current' | 'upcoming' | 'retry'
const item = (ordinal: number, name: string, status: Status, primaryTotal = 3) => ({
  name,
  ordinal,
  status,
  primaryTotal,
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  vi.useRealTimers()
})

function bar(wrapper: VueWrapper) {
  return wrapper.get('[role="progressbar"]')
}

describe('CallPanel — competency progress (Percorso)', () => {
  it('reads "Competenza 2 di 5" for ended = 1, total = 5', () => {
    const wrapper = mountPanel()

    expect(wrapper.get('[data-testid="call-panel-progress-text"]').text()).toBe('Competenza 2 di 5')
  })

  it('reads "Competency 2 of 5" in English', () => {
    const wrapper = mountPanel({ ended: 1, total: 5, elapsedSeconds: 0 }, en)

    expect(wrapper.get('[data-testid="call-panel-progress-text"]').text()).toBe('Competency 2 of 5')
  })

  it('is worded differently from the storyboard counter, so the two are never confused', () => {
    const wrapper = mountPanel({
      ended: 1,
      total: 5,
      elapsedSeconds: 0,
      storyboard: [item(1, 'A', 'done'), item(2, 'B', 'current')],
      primaryIndex: 2,
    })

    expect(wrapper.get('[data-testid="call-panel-progress-text"]').text()).not.toContain('domanda')
    expect(wrapper.get('[data-testid="call-storyboard"]').text()).toContain('domanda 2 di 3')
  })

  it('reports the bar as ended / total with a valuetext equal to the visible text', () => {
    const wrapper = mountPanel()

    expect(bar(wrapper).attributes('aria-valuenow')).toBe('1')
    expect(bar(wrapper).attributes('aria-valuemax')).toBe('5')
    expect(bar(wrapper).attributes('aria-valuemin')).toBe('0')
    expect(bar(wrapper).attributes('aria-valuetext')).toBe('Competenza 2 di 5')
  })

  it('starts at competency 1 of the server total when nothing has ended yet', () => {
    const wrapper = mountPanel({ ended: null, total: 5, elapsedSeconds: 0 })

    expect(wrapper.get('[data-testid="call-panel-progress-text"]').text()).toBe('Competenza 1 di 5')
    expect(bar(wrapper).attributes('aria-valuenow')).toBe('0')
  })

  it('never shows n above total, even when every competency has ended', () => {
    const wrapper = mountPanel({ ended: 5, total: 5, elapsedSeconds: 0 })

    expect(wrapper.get('[data-testid="call-panel-progress-text"]').text()).toBe('Competenza 5 di 5')
    expect(bar(wrapper).attributes('aria-valuetext')).toBe('Competenza 5 di 5')
    expect(bar(wrapper).attributes('aria-valuenow')).toBe('5')
  })

  it('never shows n above total when the server count overshoots', () => {
    const wrapper = mountPanel({ ended: 9, total: 5, elapsedSeconds: 0 })

    expect(wrapper.get('[data-testid="call-panel-progress-text"]').text()).toBe('Competenza 5 di 5')
    expect(bar(wrapper).attributes('aria-valuenow')).toBe('5')
  })

  it('does not print the bar counts a second time next to the sentence', () => {
    const wrapper = mountPanel()

    expect(wrapper.text()).not.toContain('1 / 5')
    expect(wrapper.text()).not.toContain('20%')
  })
})

/** The panel's duration props for a 20 minute interview, 3:12 in, with the countdown at 16:48. */
const TWENTY = { ended: 1, total: 5, elapsedSeconds: 192, maxSeconds: 1200, questionSeconds: 1008 }

const durationText = (wrapper: VueWrapper) =>
  wrapper.get('[data-testid="call-panel-duration-value"]').text()

describe("CallPanel — duration (Durata dell'intervista)", () => {
  it('states the server maximum: "03:12 / 20:00" for 192 s of a 1200 s interview', () => {
    const wrapper = mountPanel(TWENTY)

    expect(durationText(wrapper)).toBe('03:12 / 20:00')
  })

  it('does not wrap minutes at 60: 5400 s reads 90:00 and 3725 s elapsed reads 62:05', () => {
    expect(durationText(mountPanel({ ...TWENTY, elapsedSeconds: 0, maxSeconds: 5400 }))).toBe(
      '00:00 / 90:00'
    )
    expect(durationText(mountPanel({ ...TWENTY, elapsedSeconds: 3725, maxSeconds: 5400 }))).toBe(
      '62:05 / 90:00'
    )
  })

  it('gives screen readers the stated maximum, and hides the visual figure from them', () => {
    const wrapper = mountPanel(TWENTY)

    expect(wrapper.get('[data-testid="call-panel-duration-value"]').attributes('aria-hidden')).toBe(
      'true'
    )
    expect(wrapper.get('[data-testid="call-panel-duration-sr"]').text()).toBe(
      '03:12 trascorsi su un massimo di 20:00'
    )
  })

  it('reads the English copy', () => {
    const wrapper = mountPanel(TWENTY, en)

    expect(wrapper.get('[data-testid="call-panel-duration-sr"]').text()).toBe(
      '03:12 elapsed out of a maximum of 20:00'
    )
    expect(wrapper.get('[data-testid="call-panel-remaining"]').text()).toBe('About 17 minutes left')
    expect(wrapper.get('[role="timer"]').attributes('aria-label')).toBe('Time remaining')
  })

  it('draws a bar of elapsed over the maximum, named and with the sr text as its value text', () => {
    const wrapper = mountPanel(TWENTY)
    const duration = wrapper.get('[data-testid="call-panel-duration"]')
    const bars = duration.findAll('[role="progressbar"]')

    expect(bars).toHaveLength(1)
    expect(bars[0]!.attributes('aria-valuenow')).toBe('192')
    expect(bars[0]!.attributes('aria-valuemax')).toBe('1200')
    expect(bars[0]!.attributes('aria-valuetext')).toBe('03:12 trascorsi su un massimo di 20:00')
    expect(bars[0]!.attributes('aria-label')).toBe("Durata dell'intervista")
  })

  it('labels the section "Durata dell\'intervista" and names the Percorso bar differently', () => {
    const wrapper = mountPanel({ ...TWENTY, storyboard: [item(1, 'A', 'current')] })
    const names = wrapper.findAll('[role="progressbar"]').map((bar) => bar.attributes('aria-label'))

    expect(wrapper.get('[data-testid="call-panel-duration"]').text()).toContain(
      "Durata dell'intervista"
    )
    expect(new Set(names).size).toBe(2)
  })

  it('shows the elapsed value of the header clock, formatted the same way', () => {
    const wrapper = mountPanel({ ...TWENTY, elapsedSeconds: 3725, maxSeconds: 5400 })

    expect(durationText(wrapper).startsWith('62:05')).toBe(true)
  })
})

describe('CallPanel — time remaining, approximate and exact side by side', () => {
  it('says "Restano circa 17 minuti" and shows the exact countdown "Tempo rimanente 16:48"', () => {
    const wrapper = mountPanel(TWENTY)
    const timer = wrapper.get('[role="timer"]')

    expect(wrapper.get('[data-testid="call-panel-remaining"]').text()).toBe(
      'Restano circa 17 minuti'
    )
    expect(timer.text()).toBe('16:48')
    expect(timer.attributes('aria-label')).toBe('Tempo rimanente')
    expect(wrapper.get('[data-testid="call-panel-duration"]').text()).toContain('Tempo rimanente')
    expect(wrapper.get('[data-testid="call-panel-duration"]').find('[role="timer"]').exists()).toBe(
      true
    )
  })

  it.each([
    [1, 'Restano circa 1 minuto'],
    [59, 'Restano circa 1 minuto'],
    [60, 'Restano circa 1 minuto'],
    [61, 'Restano circa 2 minuti'],
    [1008, 'Restano circa 17 minuti'],
  ])('%s s left reads "%s" (ceil of the minutes, singular for one)', (remaining, expected) => {
    const wrapper = mountPanel({ ...TWENTY, questionSeconds: remaining })

    expect(wrapper.get('[data-testid="call-panel-remaining"]').text()).toBe(expected)
  })

  it.each([0, -3])('hides the sentence at %s s left and never reads "0 minuti"', (remaining) => {
    const wrapper = mountPanel({ ...TWENTY, elapsedSeconds: 1200, questionSeconds: remaining })

    expect(wrapper.find('[data-testid="call-panel-remaining"]').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/\b0 minut/)
  })

  it('wires the plural through the REAL vue-i18n: one minute singular, others plural, it and en', () => {
    const t = (locale: 'it' | 'en') =>
      createI18n({ legacy: false, locale, messages: { it: it_, en } }).global.t
    const key = 'interview.call.duration.remaining'

    expect([1, 2, 17].map((n) => t('it')(key, n))).toEqual([
      'Restano circa 1 minuto',
      'Restano circa 2 minuti',
      'Restano circa 17 minuti',
    ])
    expect([1, 17].map((n) => t('en')(key, n))).toEqual([
      'About 1 minute left',
      'About 17 minutes left',
    ])
  })
})

describe('CallPanel — past the maximum', () => {
  it('keeps the bar full and the text clamped to the maximum, with no error treatment', () => {
    const wrapper = mountPanel({ ...TWENTY, elapsedSeconds: 1500, questionSeconds: 0 })
    const bar = wrapper.get('[data-testid="call-panel-duration"] [role="progressbar"]')

    expect(durationText(wrapper)).toBe('20:00 / 20:00')
    expect(bar.attributes('aria-valuenow')).toBe('1200')
    expect(bar.attributes('aria-valuemax')).toBe('1200')
    // The countdown turns red in its last ten seconds by design; the BAR and the figure never do.
    expect(bar.html()).not.toMatch(/destructive|recording|alert/)
    expect(wrapper.get('[data-testid="call-panel-duration-value"]').html()).not.toMatch(
      /destructive|recording|alert/
    )
  })
})

describe('CallPanel — until the server states interview_max_seconds', () => {
  const HIDDEN = [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]

  it.each(HIDDEN)(
    'shows no duration, maximum, bar or sentence for maxSeconds = %s',
    (maxSeconds) => {
      const wrapper = mountPanel({ ...TWENTY, maxSeconds, questionSeconds: 300 })

      expect(wrapper.find('[data-testid="call-panel-duration-value"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="call-panel-duration-sr"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="call-panel-remaining"]').exists()).toBe(false)
      expect(
        wrapper.find('[data-testid="call-panel-duration"] [role="progressbar"]').exists()
      ).toBe(false)
    }
  )

  it('never presents the 300 s fallback seed as a maximum or as remaining time', () => {
    const wrapper = mountPanel({ ...TWENTY, maxSeconds: null, questionSeconds: 300 })
    const visible = wrapper.get('[data-testid="call-panel-duration"]')

    expect(visible.attributes('style')).toContain('display: none')
    expect(wrapper.text()).not.toContain('/ 05:00')
    expect(wrapper.text()).not.toContain('Restano')
    // The percentage-of-total derivation is gone: 5 competencies x 300 s must not become 25:00.
    expect(wrapper.text()).not.toContain('25:00')
  })

  it('keeps the countdown MOUNTED and enforcing while it is hidden: tick and expired still reach the page', async () => {
    vi.useFakeTimers()
    const wrapper = mountPanel({ ...TWENTY, maxSeconds: null, questionSeconds: 2 })
    const timer = wrapper.get('[role="timer"]')

    expect(wrapper.get('[data-testid="call-panel-duration"]').attributes('style')).toContain(
      'display: none'
    )
    expect(timer.exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(2000)
    expect(wrapper.emitted('tick')).toEqual([[1], [0]])
    expect(wrapper.emitted('expired')).toHaveLength(1)
  })

  it('shows the section once the maximum arrives, on the same mounted countdown', async () => {
    vi.useFakeTimers()
    const wrapper = mountPanel({ ...TWENTY, maxSeconds: null, questionSeconds: 1200 })
    await vi.advanceTimersByTimeAsync(3000)
    const before = wrapper.get('[role="timer"]').element

    await wrapper.setProps({ maxSeconds: 1200 })

    expect(
      wrapper.get('[data-testid="call-panel-duration"]').attributes('style') ?? ''
    ).not.toContain('display: none')
    expect(wrapper.get('[role="timer"]').element).toBe(before)
    expect(wrapper.get('[role="timer"]').text()).toBe('19:57')
  })

  it('the duration does not wait for the competency total: it needs only the maximum', () => {
    const wrapper = mountPanel({ ...TWENTY, ended: null, total: null })

    expect(durationText(wrapper)).toBe('03:12 / 20:00')
    expect(wrapper.find('[data-testid="call-panel-progress"]').exists()).toBe(false)
  })
})

describe('CallPanel — until the server states a total', () => {
  it.each([null, 0, -1])('hides the progress sentence and its bar for total = %s', (total) => {
    const wrapper = mountPanel({ ended: null, total, elapsedSeconds: 12 })

    expect(wrapper.find('[data-testid="call-panel-progress"]').exists()).toBe(false)
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
  })

  it('still offers the help link; Exit lives in the call header, so it is never locked in', () => {
    const wrapper = mountPanel({ ended: null, total: null, elapsedSeconds: 0 })

    expect(wrapper.find('[data-testid="call-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="slot-help"]').exists()).toBe(true)
  })
})

describe('CallPanel — landmark and order', () => {
  it('is an <aside> titled "Intervista": the visible title is its accessible name', () => {
    const wrapper = mountPanel()
    const aside = wrapper.get('aside')
    const title = wrapper.get('[data-testid="call-panel-title"]')

    expect(title.text()).toBe('Intervista')
    expect(aside.attributes('aria-labelledby')).toBe(title.attributes('id'))
    expect(aside.attributes('aria-label')).toBeUndefined()
    expect(aside.attributes('data-testid')).toBe('call-panel')
  })

  it('is titled "Interview" in English', () => {
    const wrapper = mountPanel({ ended: 1, total: 5, elapsedSeconds: 0 }, en)

    expect(wrapper.get('[data-testid="call-panel-title"]').text()).toBe('Interview')
  })

  it('has no Exit button and no exit slot: the control moved to the call header', () => {
    const wrapper = mountPanel({ ended: 1, total: 5, elapsedSeconds: 0 }, it_, {
      exit: '<button data-testid="slot-exit">Exit</button>',
      help: '<a data-testid="slot-help" href="#">Help</a>',
    })

    expect(wrapper.find('[data-testid="slot-exit"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="call-exit"]').exists()).toBe(false)
    expect(wrapper.findAll('button')).toHaveLength(0)
  })

  it('puts the help link last: the final focusable element of the panel', () => {
    const wrapper = mountPanel({
      ended: 1,
      total: 5,
      elapsedSeconds: 0,
      questionSeconds: 300,
      storyboard: [item(1, 'A', 'done'), item(2, 'B', 'current')],
    })
    const focusable = wrapper.element.querySelectorAll('a[href], button, [tabindex]')

    expect(focusable.length).toBeGreaterThan(0)
    expect((focusable[focusable.length - 1] as HTMLElement).dataset.testid).toBe('slot-help')
  })

  it('puts Percorso, then Durata with its countdown, then the help link', () => {
    const wrapper = mountPanel(TWENTY)
    const html = wrapper.html()
    const positions = [
      'data-testid="call-panel-path"',
      'data-testid="call-panel-progress"',
      'data-testid="call-panel-duration"',
      'role="timer"',
      'data-testid="slot-help"',
    ].map((needle) => html.indexOf(needle))

    expect(positions.every((p) => p > -1)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })
})

describe('CallPanel — the interview countdown', () => {
  it('renders no timer unless a remaining time is handed in', () => {
    const wrapper = mountPanel()

    expect(wrapper.find('[role="timer"]').exists()).toBe(false)
  })

  it('renders exactly one role="timer", labelled "Tempo rimanente"', () => {
    const wrapper = mountPanel({ ...TWENTY, questionSeconds: 252 })
    const timers = wrapper.findAll('[role="timer"]')

    expect(timers).toHaveLength(1)
    expect(timers[0]!.text()).toBe('04:12')
    expect(timers[0]!.attributes('aria-label')).toBe('Tempo rimanente')
    expect(wrapper.text()).toContain('Tempo rimanente')
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

// The panel may now name competencies (the "Percorso" storyboard, from the outline) but it
// is handed a name and never a code: even when the store the page reads from holds one, the
// code cannot surface in an element, an attribute or an accessible name.
describe('CallPanel — names appear, a code never does', () => {
  const store = reactive({
    endedCompetencies: 1 as number | null,
    totalCompetencies: 5 as number | null,
    competencyCode: 'COL',
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
            storyboard: [
              item(1, 'Pensiero strategico', 'done'),
              item(2, 'Collaborazione', 'current'),
            ],
            primaryIndex: 1,
          },
          { help: () => h('a', 'Help') }
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

  it('shows the competency names from the storyboard', () => {
    const wrapper = mountFromStore()

    expect(wrapper.text()).toContain('Pensiero strategico')
    expect(wrapper.text()).toContain('Collaborazione')
  })

  it('renders no code in any text node', () => {
    const wrapper = mountFromStore()

    expect(wrapper.text()).not.toContain('COL')
  })

  it('renders no code in any attribute, including every aria-label and aria-valuetext', () => {
    const wrapper = mountFromStore()
    const attributes = everyAttributeValue(wrapper.element).join('\n')

    expect(attributes).not.toContain('COL')
    expect(wrapper.html()).not.toContain('COL')
  })

  it('does not even read code fields: the source names none of them and imports no session', () => {
    const source = readFileSync(
      resolve(__dirname, '../../app/components/organisms/CallPanel.vue'),
      'utf-8'
    )

    expect(source).not.toMatch(/competencyCode|competency_code|currentCompetency/)
    expect(source).not.toMatch(/useInterviewSession/)
  })
})

describe('CallPanel — answer time (Tempo di risposta)', () => {
  const BUDGET = { min: 50, idealFrom: 75, idealTo: 150, max: 200 }
  const section = (wrapper: VueWrapper) => wrapper.get('[data-testid="call-panel-answer"]')

  it('is the first section, labelled "Tempo di risposta", before Percorso, Durata and help', () => {
    const wrapper = mountPanel({ ...TWENTY, storyboard: [item(1, 'A', 'current')] })
    const html = wrapper.html()
    const positions = [
      'data-testid="call-panel-answer"',
      'data-testid="call-panel-path"',
      'data-testid="call-panel-duration"',
      'data-testid="slot-help"',
    ].map((needle) => html.indexOf(needle))

    expect(section(wrapper).text()).toContain('Tempo di risposta')
    expect(positions.every((p) => p > -1)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(section(wrapper).element.tagName).toBe('SECTION')
    expect(section(wrapper).attributes('aria-labelledby')).toBe('call-panel-answer-label')
  })

  it('draws the answer figure and the chip it is handed', () => {
    const wrapper = mountPanel({ ...TWENTY, answerSeconds: 12, answerPhase: 'waiting' })

    expect(section(wrapper).get('time').text()).toBe('00:12')
    expect(section(wrapper).get('[data-testid="call-answer-chip"]').text()).toBe(
      'In attesa della tua risposta'
    )
  })

  it('shows the muted hint only for the candidate intent it is handed', () => {
    const muted = mountPanel({ ...TWENTY, micMuted: true })
    const open = mountPanel({ ...TWENTY, micMuted: false })

    expect(section(muted).find('[data-testid="call-answer-muted"]').exists()).toBe(true)
    expect(section(open).find('[data-testid="call-answer-muted"]').exists()).toBe(false)
  })

  it('shows the bar and its labels with a budget, and neither without one', () => {
    const withBudget = mountPanel({ ...TWENTY, budget: BUDGET })
    const without = mountPanel({ ...TWENTY, budget: null })

    expect(section(withBudget).get('[data-testid="call-answer-labels"]').text()).toBe(
      '0:50 min · ideale 1:15–2:30 · 3:20 max'
    )
    expect(section(without).find('[data-testid="call-answer-bar"]').exists()).toBe(false)
    expect(section(without).find('[data-testid="call-answer-labels"]').exists()).toBe(false)
  })

  it('renders even before the interview has started counting: the section is never hidden', () => {
    const wrapper = mountPanel({ ended: null, total: null, elapsedSeconds: 0 })

    expect(section(wrapper).get('time').text()).toBe('00:00')
    expect(section(wrapper).find('[data-testid="call-answer-chip"]').exists()).toBe(false)
  })

  it('adds no timer role: the countdown stays the only one', () => {
    const wrapper = mountPanel({ ...TWENTY, answerPhase: 'answering', budget: BUDGET })

    expect(wrapper.findAll('[role="timer"]')).toHaveLength(1)
    expect(section(wrapper).find('[role="timer"]').exists()).toBe(false)
    expect(section(wrapper).html()).not.toContain('aria-live')
  })

  it('a timer past the suggested maximum emits nothing and leaves the countdown alone', async () => {
    vi.useFakeTimers()
    const wrapper = mountPanel({
      ...TWENTY,
      questionSeconds: 100,
      answerSeconds: 900,
      answerPhase: 'answering',
      budget: BUDGET,
    })
    await vi.advanceTimersByTimeAsync(2000)

    expect(wrapper.emitted('expired')).toBeUndefined()
    expect(wrapper.get('[role="timer"]').text()).toBe('01:38')
    expect(wrapper.emitted('tick')).toEqual([[99], [98]])
  })
})

describe('CallPanel - the panel fills the stage cell and the path scrolls inside it', () => {
  it('takes the cell height from xl and lets the Percorso section shrink to scroll', () => {
    const wrapper = mountPanel({ ...TWENTY, storyboard: [item(1, 'A', 'current')] })

    expect(wrapper.get('aside').classes()).toEqual(
      expect.arrayContaining(['xl:min-h-0', 'xl:flex-1'])
    )
    expect(wrapper.get('[data-testid="call-panel-path"]').classes()).toEqual(
      expect.arrayContaining(['min-h-0', 'xl:flex-1'])
    )
  })

  it('the title spans the row in the strip but never claims column height at xl', () => {
    const title = mountPanel(TWENTY).get('[data-testid="call-panel-title"]').classes()

    // `basis-full` alone is 100% of the COLUMN's height once the panel is a column: the title
    // swallowed the panel and collapsed the storyboard (found by the e2e fit gate at 1440x900).
    expect(title).toEqual(expect.arrayContaining(['basis-full', 'xl:basis-auto']))
  })

  it('keeps the other sections at their natural height, so only the storyboard gives way', () => {
    const wrapper = mountPanel(TWENTY)

    for (const id of ['call-panel-answer', 'call-panel-duration']) {
      expect(wrapper.get(`[data-testid="${id}"]`).classes()).toContain('xl:flex-none')
    }
  })
})

describe('CallPanel — the named path (Percorso)', () => {
  const THREE = [
    item(1, 'Pensiero strategico', 'done'),
    item(2, 'Orientamento al risultato', 'current'),
    item(3, 'Collaborazione', 'upcoming'),
  ]

  it('lists the outline names under the progress sentence and its bar', () => {
    const wrapper = mountPanel({
      ended: 1,
      total: 5,
      elapsedSeconds: 0,
      storyboard: THREE,
      primaryIndex: 2,
    })
    const html = wrapper.html()

    expect(wrapper.get('[data-testid="call-panel-path"]').text()).toContain('Percorso')
    expect(wrapper.findAll('[data-testid="call-storyboard-item"]')).toHaveLength(3)
    expect(html.indexOf('call-panel-progress-text')).toBeLessThan(html.indexOf('call-storyboard'))
  })

  it('hands the counter to the storyboard: "domanda 2 di 3" on the current item', () => {
    const wrapper = mountPanel({
      ended: 1,
      total: 5,
      elapsedSeconds: 0,
      storyboard: THREE,
      primaryIndex: 2,
    })

    expect(wrapper.get('[aria-current="step"]').text()).toContain('In corso · domanda 2 di 3')
  })

  it('an unknown index shows "In corso" with no counts', () => {
    const wrapper = mountPanel({
      ended: 1,
      total: 5,
      elapsedSeconds: 0,
      storyboard: THREE,
      primaryIndex: null,
    })

    expect(wrapper.get('[aria-current="step"]').text()).toContain('In corso')
    expect(wrapper.get('[aria-current="step"]').text()).not.toContain('domanda')
  })

  it('an outline of 4 entries never changes the denominator: the server total (5) wins', () => {
    const wrapper = mountPanel({
      ended: 1,
      total: 5,
      elapsedSeconds: 0,
      storyboard: [...THREE, item(4, 'Quarta', 'upcoming')],
    })

    expect(wrapper.get('[data-testid="call-panel-progress-text"]').text()).toBe('Competenza 2 di 5')
    expect(bar(wrapper).attributes('aria-valuemax')).toBe('5')
  })

  it('omits the storyboard, with no empty frame, when the outline is missing; the rest renders', () => {
    const wrapper = mountPanel({ ended: 1, total: 5, elapsedSeconds: 192 })

    expect(wrapper.find('[data-testid="call-storyboard"]').exists()).toBe(false)
    expect(wrapper.find('ol').exists()).toBe(false)
    expect(wrapper.get('[data-testid="call-panel-progress-text"]').text()).toBe('Competenza 2 di 5')
    expect(wrapper.find('[data-testid="call-panel-duration"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="slot-help"]').exists()).toBe(true)
  })

  it('an empty outline is the same as a missing one', () => {
    const wrapper = mountPanel({ ended: 1, total: 5, elapsedSeconds: 0, storyboard: [] })

    expect(wrapper.find('ol').exists()).toBe(false)
  })

  it('still shows the storyboard while the total is unknown; the bar and sentence wait', () => {
    const wrapper = mountPanel({
      ended: null,
      total: null,
      elapsedSeconds: 0,
      storyboard: THREE,
    })

    expect(wrapper.findAll('[data-testid="call-storyboard-item"]')).toHaveLength(3)
    expect(wrapper.find('[data-testid="call-panel-progress"]').exists()).toBe(false)
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
  })

  it('draws no Percorso section at all with neither a total nor an outline', () => {
    const wrapper = mountPanel({ ended: null, total: null, elapsedSeconds: 0 })

    expect(wrapper.find('[data-testid="call-panel-path"]').exists()).toBe(false)
  })
})
