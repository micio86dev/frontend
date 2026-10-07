/**
 * The interview chrome on the brand canvas (DESIGN.md §7.0.1, §7.2).
 *
 * The client colour is arbitrary, so nothing the chrome draws may be a
 * constant that only reads on one colour. These specs pin the TOKENS each part
 * uses, for every colour of the screenshot matrix: the pixels are reviewed in
 * screenshots, the pairs are measured in brand-canvas-contrast.spec.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ProgressBar from '../../app/components/ProgressBar.vue'
import InterviewCaption from '../../app/components/InterviewCaption.vue'
import InterviewTimer from '../../app/components/InterviewTimer.vue'
import InterviewSteps from '../../app/components/molecules/InterviewSteps.vue'
import { useCandidateBranding } from '../../app/composables/useCandidateBranding'

vi.mock('../../app/utils/candidate-api', () => ({ candidateFetch: vi.fn() }))

const tMock = (key: string) => key
const global = { mocks: { $t: tMock } }

/** `null` is the Quint fallback: no client colour configured. */
const MATRIX: ReadonlyArray<[label: string, color: string | null, onPrimary: string]> = [
  ['light #ffd400', '#ffd400', '#000000'],
  ['dark #771aaf', '#771aaf', '#ffffff'],
  ['mid-tone #2f6fed', '#2f6fed', '#000000'],
  ['none', null, ''],
]

const CANVAS_COLOURED = /(^|\s)(text-primary|bg-primary\/\d+)(\s|$)/

function allClasses(wrapper: ReturnType<typeof mount>): string[] {
  const root = wrapper.element as Element
  return [root, ...root.querySelectorAll('*')].map((node) => node.getAttribute('class') ?? '')
}

beforeEach(() => {
  useCandidateBranding().reset()
})

describe.each(MATRIX)('interview chrome — %s', (_label, color, onPrimary) => {
  beforeEach(() => {
    useCandidateBranding().prime({ primary_color: color, logo_url: null, name: null })
  })

  it('resolves the canvas text token for this colour (or leaves the Quint default)', () => {
    expect(document.documentElement.style.getPropertyValue('--color-on-primary')).toBe(onPrimary)
  })

  it('fills the progress bar in primary-ink, never in the bare client colour', () => {
    const wrapper = mount(ProgressBar, { props: { current: 2, total: 5 }, global })
    const fill = wrapper.get('[role="progressbar"] > div')

    // #ffd400 on the light track is 1.0:1; the ink is >= 3:1 on it for any brand.
    expect(fill.classes()).toContain('bg-primary-ink')
    expect(fill.classes()).not.toContain('bg-primary')
    for (const classes of allClasses(wrapper)) expect(classes).not.toMatch(CANVAS_COLOURED)
  })

  it('sets the caption in card text, for the white dock it sits on', () => {
    const wrapper = mount(InterviewCaption, { props: { text: 'A question' }, global })

    expect(wrapper.classes()).toContain('text-card-foreground')
    for (const classes of allClasses(wrapper)) expect(classes).not.toMatch(CANVAS_COLOURED)
  })

  it('draws the timer in card tokens, and the last ten seconds in the text-safe red', async () => {
    const calm = mount(InterviewTimer, { props: { seconds: 120 }, global })
    expect(calm.get('time').classes()).toContain('text-card-foreground')
    calm.unmount()

    const urgent = mount(InterviewTimer, { props: { seconds: 9 }, global })
    expect(urgent.get('time').classes()).toContain('text-recording')
    urgent.unmount()
  })

  it('draws the step indicator with on-primary tokens only, on the bare canvas', () => {
    const wrapper = mount(InterviewSteps, { props: { current: 'device_check' }, global })

    for (const classes of allClasses(wrapper)) {
      expect(classes).not.toMatch(
        /(^|\s)(text-primary|text-foreground|text-muted-foreground|bg-background)(\s|$)/
      )
    }
  })
})

describe('InterviewSteps', () => {
  it('lists the three steps in order, through i18n', () => {
    const wrapper = mount(InterviewSteps, { props: { current: 'consent' }, global })
    const items = wrapper.findAll('li')

    expect(wrapper.element.tagName).toBe('OL')
    expect(wrapper.attributes('aria-label')).toBe('interview.steps.label')
    expect(items.map((item) => item.text())).toEqual([
      expect.stringContaining('interview.steps.consent'),
      expect.stringContaining('interview.steps.device_check'),
      expect.stringContaining('interview.steps.interview'),
    ])
  })

  it.each([
    ['consent', 0],
    ['device_check', 1],
  ] as const)('marks %s as the current step and only that one', (current, index) => {
    const wrapper = mount(InterviewSteps, { props: { current }, global })
    const items = wrapper.findAll('li')

    expect(items[index]!.attributes('aria-current')).toBe('step')
    expect(wrapper.findAll('[aria-current]')).toHaveLength(1)
  })

  it('marks the steps already behind the candidate as done for assistive tech too', () => {
    const wrapper = mount(InterviewSteps, { props: { current: 'device_check' }, global })

    expect(wrapper.findAll('li')[0]!.text()).toContain('interview.steps.done')
  })

  it('keeps every glyph out of the accessibility tree', () => {
    const wrapper = mount(InterviewSteps, { props: { current: 'consent' }, global })

    for (const svg of wrapper.findAll('svg')) {
      expect(svg.element.closest('[aria-hidden="true"]')).not.toBeNull()
    }
  })
})

describe('ProgressBar — compact, for the header', () => {
  it('drops the percentage line and keeps the bar and the count', () => {
    const wrapper = mount(ProgressBar, { props: { current: 2, total: 5, compact: true }, global })

    expect(wrapper.text()).toContain('2 / 5')
    expect(wrapper.text()).not.toContain('40%')
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(true)
  })

  it('names the bar for what it measures', () => {
    const wrapper = mount(ProgressBar, { props: { current: 2, total: 5 }, global })

    // It said "Question Completed" (end_of_question.title) on every screen.
    expect(wrapper.get('[role="progressbar"]').attributes('aria-label')).toBe(
      'interview.progress.label'
    )
  })
})
