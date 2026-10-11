/**
 * Unit tests for interview presentational components — Task 5.4 RED
 *
 * Tests:
 *   - InterviewTimer.vue: countdown, expired event, timer_label i18n key
 *   - InterviewCaption.vue: renders text, reactive update, empty text
 *   - ProgressBar.vue: aria-valuenow, visual progress
 *   - IntegrityToast.vue: mounts with and without events (the toast copy and the
 *     real Toaster are covered in integrity-toast.spec.ts)
 *
 * Spec: D11, "Flow screens — localized states"
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

// ---- InterviewTimer.vue ----

describe('InterviewTimer.vue', () => {
  it('renders initial countdown value', async () => {
    const { default: Timer } = await import('../../app/components/InterviewTimer.vue')
    const wrapper = mount(Timer, {
      props: { seconds: 60 },
      global: { mocks: { $t: (k: string) => k } },
    })
    // Should show the formatted time (60 seconds = 01:00)
    expect(wrapper.text()).toContain('01:00')
  })

  it('shows timer_label i18n key', async () => {
    const { default: Timer } = await import('../../app/components/InterviewTimer.vue')
    const tMock = (k: string) => (k === 'interview.live.timer_label' ? 'Tempo rimasto' : k)
    const wrapper = mount(Timer, {
      props: { seconds: 60 },
      global: { mocks: { $t: tMock } },
    })
    expect(wrapper.text()).toContain('Tempo rimasto')
  })

  it('emits "expired" when seconds reaches 0', async () => {
    const { default: Timer } = await import('../../app/components/InterviewTimer.vue')
    const wrapper = mount(Timer, {
      props: { seconds: 0 },
      global: { mocks: { $t: (k: string) => k } },
    })
    // With seconds=0, expired should be emitted on mount
    await nextTick()
    expect(wrapper.emitted('expired')).toBeTruthy()
  })

  it('has appropriate ARIA attributes for accessibility', async () => {
    const { default: Timer } = await import('../../app/components/InterviewTimer.vue')
    const wrapper = mount(Timer, {
      props: { seconds: 120 },
      global: { mocks: { $t: (k: string) => k } },
    })
    // Timer element should have a role or aria-label for screen readers
    const timerEl = wrapper.find('[role="timer"], [aria-label], time')
    expect(timerEl.exists()).toBe(true)
  })

  // The countdown must survive an unmount. InterviewTimer lives inside the
  // `v-if="state === 'live'"` block, so pausing unmounts it and destroys its
  // internal `remaining`; resuming mounts a NEW instance that restarts from the
  // full limit. A candidate could pause/resume repeatedly for unlimited time on
  // a question — a fairness hole in an assessment product. The owner of the
  // remaining time therefore has to be the parent, and the timer has to report
  // it on every tick.

  it('emits its remaining value on every tick so a parent can persist it', async () => {
    vi.useFakeTimers()
    const { default: Timer } = await import('../../app/components/InterviewTimer.vue')
    const wrapper = mount(Timer, {
      props: { seconds: 5 },
      global: { mocks: { $t: (k: string) => k } },
    })

    vi.advanceTimersByTime(1000)
    await nextTick()
    vi.advanceTimersByTime(1000)
    await nextTick()

    const ticks = wrapper.emitted('tick')
    expect(ticks).toBeTruthy()
    expect(ticks!.map((args) => args[0])).toEqual([4, 3])
    vi.useRealTimers()
  })

  it('resumes from a partial value rather than restarting', async () => {
    vi.useFakeTimers()
    const { default: Timer } = await import('../../app/components/InterviewTimer.vue')
    // What a remount after a pause looks like: the parent hands back what was left.
    const wrapper = mount(Timer, {
      props: { seconds: 12 },
      global: { mocks: { $t: (k: string) => k } },
    })

    expect(wrapper.text()).toContain('00:12')
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(wrapper.text()).toContain('00:11')
    vi.useRealTimers()
  })

  it('emits the final 0 tick before expiring, so the parent never re-arms a full clock', async () => {
    vi.useFakeTimers()
    const { default: Timer } = await import('../../app/components/InterviewTimer.vue')
    const wrapper = mount(Timer, {
      props: { seconds: 1 },
      global: { mocks: { $t: (k: string) => k } },
    })

    vi.advanceTimersByTime(1000)
    await nextTick()

    expect(wrapper.emitted('tick')!.map((args) => args[0])).toEqual([0])
    expect(wrapper.emitted('expired')).toBeTruthy()
    vi.useRealTimers()
  })

  it('counts down and emits expired via interval', async () => {
    vi.useFakeTimers()
    const { default: Timer } = await import('../../app/components/InterviewTimer.vue')
    const wrapper = mount(Timer, {
      props: { seconds: 2 },
      global: { mocks: { $t: (k: string) => k } },
    })
    expect(wrapper.text()).toContain('00:02')
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(wrapper.text()).toContain('00:01')
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(wrapper.emitted('expired')).toBeTruthy()
    vi.useRealTimers()
  })

  it('clears interval on unmount', async () => {
    vi.useFakeTimers()
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const { default: Timer } = await import('../../app/components/InterviewTimer.vue')
    const wrapper = mount(Timer, {
      props: { seconds: 30 },
      global: { mocks: { $t: (k: string) => k } },
    })
    wrapper.unmount()
    expect(clearSpy).toHaveBeenCalled()
    vi.useRealTimers()
    clearSpy.mockRestore()
  })
})

// ---- InterviewCaption.vue ----

describe('InterviewCaption.vue', () => {
  it('renders text from props', async () => {
    const { default: Caption } = await import('../../app/components/InterviewCaption.vue')
    const wrapper = mount(Caption, { props: { text: 'Hello world' } })
    expect(wrapper.text()).toContain('Hello world')
  })

  it('updates reactively when text prop changes', async () => {
    const { default: Caption } = await import('../../app/components/InterviewCaption.vue')
    const wrapper = mount(Caption, { props: { text: 'Initial text' } })
    await wrapper.setProps({ text: 'Updated text' })
    expect(wrapper.text()).toContain('Updated text')
  })

  it('renders an empty element (not error) when text is empty', async () => {
    const { default: Caption } = await import('../../app/components/InterviewCaption.vue')
    const wrapper = mount(Caption, { props: { text: '' } })
    // Should not throw; element should exist but be empty
    expect(wrapper.exists()).toBe(true)
    expect(wrapper.text()).toBe('')
  })
})

// ---- ProgressBar.vue ----

describe('ProgressBar.vue', () => {
  it('renders aria-valuenow equal to current', async () => {
    const { default: ProgressBar } = await import('../../app/components/ProgressBar.vue')
    const wrapper = mount(ProgressBar, {
      props: { current: 2, total: 5 },
      global: { mocks: { $t: (k: string) => k } },
    })
    const progressEl = wrapper.find('[aria-valuenow], [role="progressbar"]')
    expect(progressEl.exists()).toBe(true)
    const valuenow = progressEl.attributes('aria-valuenow')
    expect(valuenow).toBe('2')
  })

  it('renders aria-valuemax equal to total', async () => {
    const { default: ProgressBar } = await import('../../app/components/ProgressBar.vue')
    const wrapper = mount(ProgressBar, {
      props: { current: 3, total: 10 },
      global: { mocks: { $t: (k: string) => k } },
    })
    const progressEl = wrapper.find('[aria-valuenow], [role="progressbar"]')
    expect(progressEl.attributes('aria-valuemax')).toBe('10')
  })

  it('shows correct progress percentage', async () => {
    const { default: ProgressBar } = await import('../../app/components/ProgressBar.vue')
    const wrapper = mount(ProgressBar, {
      props: { current: 1, total: 4 },
      global: { mocks: { $t: (k: string) => k } },
    })
    // 1/4 = 25%
    expect(wrapper.html()).toContain('25')
  })

  it('has role="progressbar" for screen readers', async () => {
    const { default: ProgressBar } = await import('../../app/components/ProgressBar.vue')
    const wrapper = mount(ProgressBar, {
      props: { current: 0, total: 5 },
      global: { mocks: { $t: (k: string) => k } },
    })
    const progressEl = wrapper.find('[role="progressbar"]')
    expect(progressEl.exists()).toBe(true)
  })
})

// ---- IntegrityToast.vue ----

describe('IntegrityToast.vue', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders without errors when events is empty', async () => {
    const { default: IntegrityToast } = await import('../../app/components/IntegrityToast.vue')
    const wrapper = mount(IntegrityToast, {
      props: { events: [] },
      global: { mocks: { $t: (k: string) => k } },
    })
    expect(wrapper.exists()).toBe(true)
  })

  it('does not error when events array has items on mount', async () => {
    const { default: IntegrityToast } = await import('../../app/components/IntegrityToast.vue')
    const wrapper = mount(IntegrityToast, {
      props: {
        events: [{ type: 'tab_hidden' as const, ts: new Date().toISOString(), meta: null }],
      },
      global: { mocks: { $t: (k: string) => k } },
    })
    expect(wrapper.exists()).toBe(true)
  })
})

// ---- UI-06: additive props (candidate-interview-call-ui, design D7/D8) ----
//
// ProgressBar gains `hideCounts` and `valueText`; InterviewTimer gains an optional
// `label`. Everything above this line is the contract that predates them and is
// untouched: the first block below pins that the DEFAULT output did not move.

describe('ProgressBar.vue — additive props (UI-06)', () => {
  const mocks = { $t: (k: string) => k }

  /** Comments are authoring notes, not output; every element, attribute and class is compared. */
  function markup(html: string): string {
    return html.replace(/<!--[\s\S]*?-->/g, '').replace(/\n\s*\n/g, '\n')
  }

  const DEFAULT_OUTPUT = [
    '<div class="flex flex-col gap-1">',
    '  <div class="flex items-center justify-between text-sm text-muted-foreground"><span>2 / 5</span><span>40%</span></div>',
    '  <div role="progressbar" aria-valuenow="2" aria-valuemin="0" aria-valuemax="5" aria-label="interview.progress.label" class="h-2 overflow-hidden rounded-full bg-secondary w-full">',
    '    <div class="h-full rounded-full bg-primary-ink transition-[width] duration-300 motion-reduce:transition-none" style="width: 40%;"></div>',
    '  </div>',
    '</div>',
  ].join('\n')

  const COMPACT_OUTPUT = [
    '<div class="flex items-center gap-2.5">',
    '  <div role="progressbar" aria-valuenow="2" aria-valuemin="0" aria-valuemax="5" aria-label="interview.progress.label" class="h-2 overflow-hidden rounded-full bg-secondary w-24">',
    '    <div class="h-full rounded-full bg-primary-ink transition-[width] duration-300 motion-reduce:transition-none" style="width: 40%;"></div>',
    '  </div><span class="text-sm font-medium tabular-nums text-muted-foreground">2 / 5</span>',
    '</div>',
  ].join('\n')

  it('leaves the default output byte-identical', async () => {
    const { default: ProgressBar } = await import('../../app/components/ProgressBar.vue')
    const wrapper = mount(ProgressBar, { props: { current: 2, total: 5 }, global: { mocks } })

    expect(markup(wrapper.html())).toBe(DEFAULT_OUTPUT)
  })

  it('leaves the compact output byte-identical', async () => {
    const { default: ProgressBar } = await import('../../app/components/ProgressBar.vue')
    const wrapper = mount(ProgressBar, {
      props: { current: 2, total: 5, compact: true },
      global: { mocks },
    })

    expect(markup(wrapper.html())).toBe(COMPACT_OUTPUT)
  })

  it('emits no aria-valuetext unless one is given', async () => {
    const { default: ProgressBar } = await import('../../app/components/ProgressBar.vue')
    const wrapper = mount(ProgressBar, { props: { current: 2, total: 5 }, global: { mocks } })

    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuetext')).toBeUndefined()
  })

  it('puts valueText on the bar as aria-valuetext', async () => {
    const { default: ProgressBar } = await import('../../app/components/ProgressBar.vue')
    const wrapper = mount(ProgressBar, {
      props: { current: 1, total: 5, valueText: 'Domanda 2 di 5' },
      global: { mocks },
    })

    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuetext')).toBe('Domanda 2 di 5')
  })

  it('hideCounts removes the "n / total" and percentage row, keeping the bar', async () => {
    const { default: ProgressBar } = await import('../../app/components/ProgressBar.vue')
    const wrapper = mount(ProgressBar, {
      props: { current: 2, total: 5, hideCounts: true },
      global: { mocks },
    })

    expect(wrapper.text()).toBe('')
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('2')
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuemax')).toBe('5')
  })

  it('hideCounts also removes the compact trailing count', async () => {
    const { default: ProgressBar } = await import('../../app/components/ProgressBar.vue')
    const wrapper = mount(ProgressBar, {
      props: { current: 2, total: 5, compact: true, hideCounts: true },
      global: { mocks },
    })

    expect(wrapper.text()).toBe('')
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(true)
  })
})

describe('InterviewTimer.vue — additive label and the unchanged threshold (UI-06)', () => {
  const mocks = { $t: (k: string) => k }

  it('keeps the default label when none is given', async () => {
    const { default: Timer } = await import('../../app/components/InterviewTimer.vue')
    const wrapper = mount(Timer, { props: { seconds: 60 }, global: { mocks } })

    expect(wrapper.text()).toContain('interview.live.timer_label')
    expect(wrapper.get('[role="timer"]').attributes('aria-label')).toBe(
      'interview.live.timer_label'
    )
  })

  it('shows an optional label as both the visible text and the accessible name', async () => {
    const { default: Timer } = await import('../../app/components/InterviewTimer.vue')
    const wrapper = mount(Timer, {
      props: { seconds: 252, label: 'Tempo rimanente per questa domanda' },
      global: { mocks },
    })

    expect(wrapper.text()).toContain('Tempo rimanente per questa domanda')
    expect(wrapper.text()).not.toContain('interview.live.timer_label')
    expect(wrapper.get('[role="timer"]').attributes('aria-label')).toBe(
      'Tempo rimanente per questa domanda'
    )
    expect(wrapper.get('[role="timer"]').text()).toBe('04:12')
  })

  it('stays quiet and neutral above 10 s, with or without a label', async () => {
    const { default: Timer } = await import('../../app/components/InterviewTimer.vue')
    const wrapper = mount(Timer, { props: { seconds: 11, label: 'L' }, global: { mocks } })
    const timer = wrapper.get('[role="timer"]')

    expect(timer.attributes('aria-live')).toBe('off')
    expect(timer.classes()).toContain('text-card-foreground')
    expect(timer.classes()).not.toContain('text-recording')
  })

  it('turns recording-red and assertive at 10 s or less, with or without a label', async () => {
    const { default: Timer } = await import('../../app/components/InterviewTimer.vue')

    for (const props of [
      { seconds: 10 },
      { seconds: 10, label: 'L' },
      { seconds: 3, label: 'L' },
    ]) {
      const timer = mount(Timer, { props, global: { mocks } }).get('[role="timer"]')

      expect(timer.attributes('aria-live')).toBe('assertive')
      expect(timer.classes()).toContain('text-recording')
    }
  })

  it('still emits tick and expired exactly as before when labelled', async () => {
    vi.useFakeTimers()
    const { default: Timer } = await import('../../app/components/InterviewTimer.vue')
    const wrapper = mount(Timer, { props: { seconds: 2, label: 'L' }, global: { mocks } })

    vi.advanceTimersByTime(1000)
    await nextTick()
    vi.advanceTimersByTime(1000)
    await nextTick()

    expect(wrapper.emitted('tick')!.map((args) => args[0])).toEqual([1, 0])
    expect(wrapper.emitted('expired')).toHaveLength(1)
    vi.useRealTimers()
  })
})
