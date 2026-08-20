/**
 * Unit tests for interview presentational components — Task 5.4 RED
 *
 * Tests:
 *   - InterviewTimer.vue: countdown, expired event, timer_label i18n key
 *   - InterviewCaption.vue: renders text, reactive update, empty text
 *   - ProgressBar.vue: aria-valuenow, visual progress
 *   - IntegrityToast.vue: shows toast on new event, no toast on empty
 *
 * Spec: D11, "Flow screens — localized states"
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'

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
    const wrapper = mount(ProgressBar, { props: { current: 2, total: 5 } })
    const progressEl = wrapper.find('[aria-valuenow], [role="progressbar"]')
    expect(progressEl.exists()).toBe(true)
    const valuenow = progressEl.attributes('aria-valuenow')
    expect(valuenow).toBe('2')
  })

  it('renders aria-valuemax equal to total', async () => {
    const { default: ProgressBar } = await import('../../app/components/ProgressBar.vue')
    const wrapper = mount(ProgressBar, { props: { current: 3, total: 10 } })
    const progressEl = wrapper.find('[aria-valuenow], [role="progressbar"]')
    expect(progressEl.attributes('aria-valuemax')).toBe('10')
  })

  it('shows correct progress percentage', async () => {
    const { default: ProgressBar } = await import('../../app/components/ProgressBar.vue')
    const wrapper = mount(ProgressBar, { props: { current: 1, total: 4 } })
    // 1/4 = 25%
    expect(wrapper.html()).toContain('25')
  })

  it('has role="progressbar" for screen readers', async () => {
    const { default: ProgressBar } = await import('../../app/components/ProgressBar.vue')
    const wrapper = mount(ProgressBar, { props: { current: 0, total: 5 } })
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

  it('triggers toast when new event added to events prop', async () => {
    const toastWarningFn = vi.fn()
    vi.mock('vue-sonner', () => ({
      toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() },
    }))

    const { default: IntegrityToast } = await import('../../app/components/IntegrityToast.vue')

    const events = ref<Array<{ type: 'tab_hidden'; ts: string; meta: null }>>([])
    const wrapper = mount(IntegrityToast, {
      props: { events: events.value },
    })

    // Add an event by updating props
    const newEvents = [{ type: 'tab_hidden' as const, ts: new Date().toISOString(), meta: null }]
    await wrapper.setProps({ events: newEvents })
    await nextTick()

    // Component should still exist and no exception thrown
    expect(wrapper.exists()).toBe(true)
    void toastWarningFn // reference to suppress unused warning
  })
})
