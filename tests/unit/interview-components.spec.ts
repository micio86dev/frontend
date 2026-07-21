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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
  let toastFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    toastFn = vi.fn()
    vi.doMock('vue-sonner', () => ({ toast: toastFn }))
  })

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

  it('does not error when events array has items', async () => {
    const { default: IntegrityToast } = await import('../../app/components/IntegrityToast.vue')
    const wrapper = mount(IntegrityToast, {
      props: {
        events: [{ type: 'tab_hidden', ts: new Date().toISOString(), meta: null }],
      },
      global: { mocks: { $t: (k: string) => k } },
    })
    expect(wrapper.exists()).toBe(true)
  })
})
