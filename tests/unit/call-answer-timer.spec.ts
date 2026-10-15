/**
 * CallAnswerTimer — the "Tempo di risposta" section of the interview panel
 * (live-interview-call-chrome D14 section 1; spec "The Interview Time Remaining Is A Counter,
 * Distinct From The Answer Timer" and "The Suggested Answer Length ...").
 *
 * Pinned here: the elapsed figure is a plain <time> (never a timer role, never a live region:
 * announcing every second would bury the question), the chip is text, the muted hint is plain
 * text, and the suggested-length bar exists only with a budget, is guidance (full and calm past
 * the max) and states min / ideal / max as text. `$t` is backed by the REAL `it.json` / `en.json`.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import CallAnswerTimer from '~/app/components/molecules/CallAnswerTimer.vue'
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

type Phase = 'idle' | 'listening' | 'waiting' | 'answering'
interface Budget {
  min: number
  idealFrom: number
  idealTo: number
  max: number
}

/** The spec example: 1200 s over 6 primaries. */
const BUDGET: Budget = { min: 50, idealFrom: 75, idealTo: 150, max: 200 }

const mounted: VueWrapper[] = []

function mountTimer(
  props: Partial<{ seconds: number; phase: Phase; budget: Budget | null; micMuted: boolean }> = {},
  locale: unknown = it_
) {
  const wrapper = mount(CallAnswerTimer, {
    props: { seconds: 12, phase: 'waiting' as Phase, budget: null, micMuted: false, ...props },
    global: { mocks: { $t: translator(locale) } },
  })
  mounted.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

/** Comments explain why the rules exist and may name what they forbid. */
const SOURCE = readFileSync(
  resolve(__dirname, '../../app/components/molecules/CallAnswerTimer.vue'),
  'utf-8'
)
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')

describe('CallAnswerTimer - the figure', () => {
  it.each([
    [0, '00:00'],
    [12, '00:12'],
    [75, '01:15'],
    [3725, '62:05'],
  ])('writes %s s as %s in a plain <time>', (seconds, expected) => {
    const time = mountTimer({ seconds }).get('time')

    expect(time.text()).toBe(expected)
    expect(time.attributes('role')).toBeUndefined()
  })

  it('has no live region and no timer or status role: it must not announce every second', () => {
    const wrapper = mountTimer({ phase: 'answering', budget: BUDGET, micMuted: true })
    const html = wrapper.html()

    expect(html).not.toMatch(/aria-live|role="(?:timer|status|alert|log)"/)
    expect(SOURCE).not.toMatch(/aria-live|role="(?:timer|status|alert|log)"/)
  })
})

describe('CallAnswerTimer - the status chip', () => {
  const chip = (wrapper: VueWrapper) => wrapper.find('[data-testid="call-answer-chip"]')

  it.each([
    ['listening', "L'intervistatore sta parlando"],
    ['waiting', 'In attesa della tua risposta'],
    ['answering', 'Stai rispondendo'],
  ] as const)('%s reads "%s"', (phase, expected) => {
    expect(chip(mountTimer({ phase })).text()).toBe(expected)
  })

  it('reads the English copy', () => {
    expect(chip(mountTimer({ phase: 'waiting' }, en)).text()).toBe('Waiting for your answer')
    expect(chip(mountTimer({ phase: 'answering' }, en)).text()).toBe('You are answering')
  })

  it('shows no chip while idle, but still draws the figure', () => {
    const wrapper = mountTimer({ phase: 'idle', seconds: 0 })

    expect(chip(wrapper).exists()).toBe(false)
    expect(wrapper.get('time').text()).toBe('00:00')
  })

  it('follows the phase it is given', async () => {
    const wrapper = mountTimer({ phase: 'answering' })
    expect(chip(wrapper).text()).toBe('Stai rispondendo')

    await wrapper.setProps({ phase: 'listening' })
    expect(chip(wrapper).text()).toBe("L'intervistatore sta parlando")
  })
})

describe('CallAnswerTimer - the muted hint', () => {
  const hint = (wrapper: VueWrapper) => wrapper.find('[data-testid="call-answer-muted"]')

  it('shows plain text, with the icon hidden from assistive technology, only while muted', () => {
    const muted = mountTimer({ micMuted: true })

    expect(hint(muted).text()).toBe("Microfono disattivato: l'intervistatore non ti sente")
    expect(hint(muted).get('svg').attributes('aria-hidden')).toBe('true')
    expect(hint(muted).attributes('role')).toBeUndefined()
    expect(hint(mountTimer({ micMuted: false })).exists()).toBe(false)
  })

  it('does not freeze the figure: muting changes nothing about the seconds', async () => {
    const wrapper = mountTimer({ seconds: 20, phase: 'answering', micMuted: true })
    await wrapper.setProps({ seconds: 30 })

    expect(wrapper.get('time').text()).toBe('00:30')
  })

  it('reads in English', () => {
    expect(hint(mountTimer({ micMuted: true }, en)).text()).toBe(
      'Microphone off: the interviewer cannot hear you'
    )
  })
})

describe('CallAnswerTimer - the suggested-length bar', () => {
  const bar = (wrapper: VueWrapper) => wrapper.find('[data-testid="call-answer-bar"]')
  const segments = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="call-answer-zone"]')
  const widthOf = (el: { attributes: (n: string) => string | undefined }) =>
    Number.parseFloat(/width:\s*([\d.]+)%/.exec(el.attributes('style') ?? '')?.[1] ?? 'NaN')

  it('renders neither bar nor labels without a budget, but still the figure and the chip', () => {
    const wrapper = mountTimer({ budget: null })

    expect(bar(wrapper).exists()).toBe(false)
    expect(wrapper.find('[data-testid="call-answer-labels"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="call-answer-note"]').exists()).toBe(false)
    expect(wrapper.get('time').exists()).toBe(true)
    expect(wrapper.find('[data-testid="call-answer-chip"]').exists()).toBe(true)
  })

  it('writes min, ideal range and max as text: "0:50 min · ideale 1:15–2:30 · 3:20 max"', () => {
    const wrapper = mountTimer({ budget: BUDGET })

    expect(wrapper.get('[data-testid="call-answer-labels"]').text()).toBe(
      '0:50 min · ideale 1:15–2:30 · 3:20 max'
    )
    expect(wrapper.get('[data-testid="call-answer-note"]').text()).toBe(
      'Tempi suggeriti, non vincolanti'
    )
  })

  it('writes a second budget too (max 4:00): "1:00 min · ideale 1:30–3:00 · 4:00 max"', () => {
    const wrapper = mountTimer({ budget: { min: 60, idealFrom: 90, idealTo: 180, max: 240 } })

    expect(wrapper.get('[data-testid="call-answer-labels"]').text()).toBe(
      '1:00 min · ideale 1:30–3:00 · 4:00 max'
    )
  })

  it('reads the English copy', () => {
    const wrapper = mountTimer({ budget: BUDGET }, en)

    expect(wrapper.get('[data-testid="call-answer-labels"]').text()).toBe(
      '0:50 min · ideal 1:15–2:30 · 3:20 max'
    )
    expect(wrapper.get('[data-testid="call-answer-note"]').text()).toBe(
      'Suggested times, not binding'
    )
  })

  it('splits the track into four zones sized by [0,min), [min,ideal from), [ideal], (ideal,max]', () => {
    const zones = segments(mountTimer({ budget: BUDGET }))

    expect(zones.map(widthOf)).toEqual([25, 12.5, 37.5, 25])
  })

  it('zone widths follow a different budget (max 240)', () => {
    const zones = segments(
      mountTimer({ budget: { min: 60, idealFrom: 90, idealTo: 180, max: 240 } })
    )

    expect(zones.map(widthOf)).toEqual([25, 12.5, 37.5, 25])
    const other = segments(mountTimer({ budget: { min: 10, idealFrom: 20, idealTo: 60, max: 80 } }))
    expect(other.map(widthOf)).toEqual([12.5, 12.5, 50, 25])
  })

  it('exposes the answer time against the maximum to assistive technology', () => {
    const wrapper = mountTimer({ seconds: 65, budget: BUDGET })
    const progress = bar(wrapper)

    expect(progress.attributes('role')).toBe('progressbar')
    expect(progress.attributes('aria-valuemin')).toBe('0')
    expect(progress.attributes('aria-valuemax')).toBe('200')
    expect(progress.attributes('aria-valuenow')).toBe('65')
    expect(progress.attributes('aria-valuetext')).toBe('1:05 su un massimo suggerito di 3:20')
    expect(progress.attributes('aria-label')).toBe('Durata suggerita della risposta')
  })

  it('fills each zone in turn: 60 s is a full first zone and 40% of the second', () => {
    const fills = (wrapper: VueWrapper) =>
      wrapper.findAll('[data-testid="call-answer-fill"]').map(widthOf)

    expect(fills(mountTimer({ seconds: 0, budget: BUDGET }))).toEqual([0, 0, 0, 0])
    expect(fills(mountTimer({ seconds: 60, budget: BUDGET }))).toEqual([100, 40, 0, 0])
    expect(fills(mountTimer({ seconds: 120, budget: BUDGET }))).toEqual([100, 100, 60, 0])
    expect(fills(mountTimer({ seconds: 175, budget: BUDGET }))).toEqual([100, 100, 100, 50])
  })

  it('past the max the bar stays full with no error or warning treatment (guidance only)', () => {
    const wrapper = mountTimer({ seconds: 260, budget: BUDGET, phase: 'answering' })
    const fills = wrapper.findAll('[data-testid="call-answer-fill"]').map(widthOf)
    const progress = bar(wrapper)

    expect(fills).toEqual([100, 100, 100, 100])
    expect(progress.attributes('aria-valuenow')).toBe('200')
    expect(wrapper.get('time').text()).toBe('04:20')
    // The chip is a Badge whose base class list names `destructive`; the bar and the figure are ours.
    const drawn = bar(wrapper).html() + wrapper.get('time').html()
    expect(drawn).not.toMatch(/destructive|recording|alert|warning|amber/)
    expect(wrapper.emitted()).toEqual({})
  })

  it('animates the fill only where motion is welcome', () => {
    const fill = mountTimer({ seconds: 60, budget: BUDGET }).get('[data-testid="call-answer-fill"]')

    expect(fill.classes()).toEqual(
      expect.arrayContaining(['transition-[width]', 'motion-reduce:transition-none'])
    )
  })
})

describe('CallAnswerTimer - the source', () => {
  it('names no code and no session', () => {
    expect(SOURCE).not.toMatch(
      /\bcode\b|useInterviewSession|useInterviewOutline|useCandidateSession/
    )
  })
})

describe('CallAnswerTimer - locale parity', () => {
  it.each([
    ['it', it_],
    ['en', en],
  ])('%s has every answer key as a string, none naming a vendor', (_name, locale) => {
    const keys = [
      'label',
      'status.listening',
      'status.waiting',
      'status.answering',
      'muted_hint',
      'budget_labels',
      'budget_note',
      'budget_label',
      'budget_sr',
    ]
    for (const key of keys) {
      const text = lookup(locale, `interview.call.answer.${key}`)
      expect(text.length).toBeGreaterThan(0)
      expect(text).not.toMatch(/tavus|heygen|daily|livekit/i)
    }
  })
})
