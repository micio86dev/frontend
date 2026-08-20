/**
 * Task 5.1 RED — Unit tests for app/components/DeviceCheck.client.vue
 *
 * No component spec existed before this change (proposal, "Existing tests that
 * break"). Covers (design D1, D5, D6, D7, D11 — Slice 5):
 * - container aspect-ratio tracks the composable's (already-clamped) previewRatio,
 *   falling back to a 16:9 placeholder before metadata is known
 * - object-fit: contain, never cover
 * - mic meter scaling: Math.min(100, Math.round(micLevel / 0.35 * 100))
 * - the hard gate: Continue disabled unless BOTH cameraOk and micOk
 * - Retry control wiring: release() then check()
 * - decorative status dots are aria-hidden (not role=status / aria-label)
 * - the mic-meter's single role=status announcement on threshold crossing
 * - zero literal (non-i18n) strings in the template
 *
 * Vue Test Utils with useDeviceCheck mocked (design Testing Strategy — Slice 5
 * does not yet wire useMediaDeviceList/pickers; that is Slice 6).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref, nextTick, type Ref } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DeviceCheckError, DeviceSelection } from '~/app/composables/useDeviceCheck'
import type { MediaDeviceOption } from '~/app/composables/useMediaDeviceList'
import { Select } from '~/app/components/ui/select'

// ---------------------------------------------------------------------------
// Hoisted composable mocks
// ---------------------------------------------------------------------------

const { mockUseDeviceCheck, mockUseMediaDeviceList } = vi.hoisted(() => ({
  mockUseDeviceCheck: vi.fn(),
  mockUseMediaDeviceList: vi.fn(),
}))

vi.mock('~/composables/useDeviceCheck', () => ({
  useDeviceCheck: mockUseDeviceCheck,
  // Real constant, not a mock: the meter's threshold marker reads it directly
  // from the composable module (same value the composable gates on).
  MIC_SPEAK_THRESHOLD: 0.04,
}))

vi.mock('~/composables/useMediaDeviceList', () => ({
  useMediaDeviceList: mockUseMediaDeviceList,
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface MockDeviceCheck {
  cameraOk: Ref<boolean>
  micOk: Ref<boolean>
  micLevel: Ref<number>
  micUnavailable: Ref<boolean>
  previewRatio: Ref<number | null>
  activeSelection: Ref<DeviceSelection>
  error: Ref<DeviceCheckError | null>
  switching: Ref<boolean>
  stream: Ref<MediaStream | null>
  check: ReturnType<typeof vi.fn>
  switchCamera: ReturnType<typeof vi.fn>
  switchMicrophone: ReturnType<typeof vi.fn>
  stopMicSampling: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
}

function makeDeviceCheck(overrides: Partial<MockDeviceCheck> = {}): MockDeviceCheck {
  return {
    cameraOk: ref(false),
    micOk: ref(false),
    micLevel: ref(0),
    micUnavailable: ref(false),
    previewRatio: ref(null),
    activeSelection: ref({}),
    error: ref(null),
    switching: ref(false),
    stream: ref(null),
    check: vi.fn().mockResolvedValue(undefined),
    switchCamera: vi.fn().mockResolvedValue(undefined),
    switchMicrophone: vi.fn().mockResolvedValue(undefined),
    stopMicSampling: vi.fn(),
    release: vi.fn(),
    ...overrides,
  }
}

interface MockMediaDeviceList {
  cameras: Ref<MediaDeviceOption[]>
  microphones: Ref<MediaDeviceOption[]>
  preferredCameraId: Ref<string | null>
  preferredMicId: Ref<string | null>
  refresh: ReturnType<typeof vi.fn>
  validatePreferences: ReturnType<typeof vi.fn>
  persist: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

function makeMediaDeviceList(overrides: Partial<MockMediaDeviceList> = {}): MockMediaDeviceList {
  return {
    cameras: ref([]),
    microphones: ref([]),
    preferredCameraId: ref(null),
    preferredMicId: ref(null),
    refresh: vi.fn().mockResolvedValue(undefined),
    validatePreferences: vi.fn().mockReturnValue({ cameraId: null, micId: null }),
    persist: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  }
}

function globalConfig() {
  return {
    mocks: { $t: (key: string) => key },
  }
}

async function mountComponent(
  deviceCheck: MockDeviceCheck,
  mediaDeviceList: MockMediaDeviceList = makeMediaDeviceList()
) {
  mockUseDeviceCheck.mockReturnValue(deviceCheck)
  mockUseMediaDeviceList.mockReturnValue(mediaDeviceList)
  const { default: DeviceCheck } = await import('~/app/components/DeviceCheck.client.vue')
  const wrapper = mount(DeviceCheck, { global: globalConfig() })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Preview geometry (D1)
// ---------------------------------------------------------------------------

describe('DeviceCheck.client.vue — preview geometry (D1)', () => {
  it('tracks the composable-reported (already-clamped) previewRatio', async () => {
    const dc = makeDeviceCheck({ previewRatio: ref(16 / 9), cameraOk: ref(true) })
    const wrapper = await mountComponent(dc)

    const preview = wrapper.get('[data-testid="device-preview"]')
    const style = preview.attributes('style') ?? ''
    const match = style.match(/aspect-ratio:\s*([\d.]+)/)
    expect(match, `style was "${style}"`).not.toBeNull()
    expect(Number(match![1])).toBeCloseTo(16 / 9, 2)
  })

  it('falls back to a 16:9 placeholder before previewRatio is known', async () => {
    const dc = makeDeviceCheck({ previewRatio: ref(null) })
    const wrapper = await mountComponent(dc)

    const preview = wrapper.get('[data-testid="device-preview"]')
    const style = preview.attributes('style') ?? ''
    const match = style.match(/aspect-ratio:\s*([\d.]+)/)
    expect(match, `style was "${style}"`).not.toBeNull()
    expect(Number(match![1])).toBeCloseTo(16 / 9, 2)
  })

  it('a clamped portrait ratio (3/4) is rendered as reported, not re-derived', async () => {
    const dc = makeDeviceCheck({ previewRatio: ref(3 / 4), cameraOk: ref(true) })
    const wrapper = await mountComponent(dc)

    const preview = wrapper.get('[data-testid="device-preview"]')
    const style = preview.attributes('style') ?? ''
    const match = style.match(/aspect-ratio:\s*([\d.]+)/)
    expect(Number(match![1])).toBeCloseTo(3 / 4, 2)
  })

  it('the video element uses object-contain, never object-cover (D1 — cover crops by construction)', async () => {
    const dc = makeDeviceCheck({ cameraOk: ref(true) })
    const wrapper = await mountComponent(dc)

    const video = wrapper.get('[data-testid="preview-video"]')
    expect(video.classes()).toContain('object-contain')
    expect(video.classes()).not.toContain('object-cover')
  })
})

// ---------------------------------------------------------------------------
// Mic level meter (D5)
// ---------------------------------------------------------------------------

describe('DeviceCheck.client.vue — mic level meter (D5)', () => {
  it('scales micLevel to a 0-100 display value: min(100, round(micLevel/0.35*100))', async () => {
    // 0.175 / 0.35 * 100 = 50
    const dc = makeDeviceCheck({ micLevel: ref(0.175) })
    const wrapper = await mountComponent(dc)

    const meter = wrapper.get('[data-testid="mic-meter"]')
    expect(meter.attributes('aria-valuenow')).toBe('50')
  })

  it('clamps the display value at 100 for a micLevel above the 0.35 ceiling', async () => {
    const dc = makeDeviceCheck({ micLevel: ref(0.6) })
    const wrapper = await mountComponent(dc)

    const meter = wrapper.get('[data-testid="mic-meter"]')
    expect(meter.attributes('aria-valuenow')).toBe('100')
  })

  it('a silent mic (micLevel=0) shows a 0 display value, not undefined/NaN', async () => {
    const dc = makeDeviceCheck({ micLevel: ref(0) })
    const wrapper = await mountComponent(dc)

    const meter = wrapper.get('[data-testid="mic-meter"]')
    expect(meter.attributes('aria-valuenow')).toBe('0')
  })

  it('the meter is a progressbar and is NEVER inside a live region (D5 — a continuously-updating live region is a screen-reader DoS)', async () => {
    const dc = makeDeviceCheck({ micLevel: ref(0.2) })
    const wrapper = await mountComponent(dc)

    const meter = wrapper.get('[data-testid="mic-meter"]')
    expect(meter.attributes('role')).toBe('progressbar')
    expect(meter.attributes('aria-live')).toBeUndefined()
    // No ancestor of the meter carries aria-live either.
    let el: Element | null = meter.element
    while (el) {
      expect(el.getAttribute('aria-live')).toBeNull()
      el = el.parentElement
    }
  })

  it('announces the mic-detected status exactly once, via role=status, on the micOk transition', async () => {
    const micOk = ref(false)
    const dc = makeDeviceCheck({ micOk })
    const wrapper = await mountComponent(dc)

    const status = wrapper.get('[data-testid="mic-detected-status"]')
    expect(status.attributes('role')).toBe('status')
    expect(status.text()).toBe('')

    micOk.value = true
    await nextTick()

    expect(status.text()).toBe('interview.device_check.mic_detected')
  })
})

// ---------------------------------------------------------------------------
// Hard gate (D6)
// ---------------------------------------------------------------------------

describe('DeviceCheck.client.vue — hard gate (D6)', () => {
  it('Continue is disabled when neither device has passed', async () => {
    const wrapper = await mountComponent(makeDeviceCheck())
    expect(wrapper.get('[data-testid="continue-button"]').attributes('disabled')).toBeDefined()
  })

  it('Continue is disabled when only the camera has passed', async () => {
    const dc = makeDeviceCheck({ cameraOk: ref(true), micOk: ref(false) })
    const wrapper = await mountComponent(dc)
    expect(wrapper.get('[data-testid="continue-button"]').attributes('disabled')).toBeDefined()
  })

  it('Continue is enabled only when BOTH camera and mic have passed', async () => {
    const dc = makeDeviceCheck({ cameraOk: ref(true), micOk: ref(true) })
    const wrapper = await mountComponent(dc)
    expect(wrapper.get('[data-testid="continue-button"]').attributes('disabled')).toBeUndefined()
  })

  it('clicking Continue emits confirmed with the stream', async () => {
    // A real MediaStream (happy-dom provides the constructor) — the video
    // element's srcObject setter validates its argument's type, so a bare
    // `{}` cast throws inside onMounted's srcObject assignment.
    const stream = new MediaStream()
    const dc = makeDeviceCheck({ cameraOk: ref(true), micOk: ref(true), stream: ref(stream) })
    const wrapper = await mountComponent(dc)

    await wrapper.get('[data-testid="continue-button"]').trigger('click')

    expect(wrapper.emitted('confirmed')).toEqual([[stream]])
  })
})

// ---------------------------------------------------------------------------
// Retry control (D6 mic-gate dead-end fix)
// ---------------------------------------------------------------------------

describe('DeviceCheck.client.vue — Retry control', () => {
  it('Retry is shown when micUnavailable is true, and calls release() then check()', async () => {
    const dc = makeDeviceCheck({ cameraOk: ref(true), micUnavailable: ref(true) })
    const wrapper = await mountComponent(dc)

    const retryButton = wrapper.get('[data-testid="retry-button"]')
    const callOrder: string[] = []
    dc.release.mockImplementation(() => callOrder.push('release'))
    dc.check.mockImplementation(() => {
      callOrder.push('check')
      return Promise.resolve()
    })

    await retryButton.trigger('click')

    expect(callOrder).toEqual(['release', 'check'])
  })

  it('Retry is shown when the camera check has failed with an error', async () => {
    const dc = makeDeviceCheck({ error: ref('not_found') })
    const wrapper = await mountComponent(dc)
    expect(wrapper.find('[data-testid="retry-button"]').exists()).toBe(true)
  })

  it('Retry is NOT shown while the check is still passing quietly (no error, mic not yet spoken)', async () => {
    const dc = makeDeviceCheck({ cameraOk: ref(true), micOk: ref(false), error: ref(null) })
    const wrapper = await mountComponent(dc)
    expect(wrapper.find('[data-testid="retry-button"]').exists()).toBe(false)
  })

  it('the recovery Alert with browser-neutral guidance appears alongside Retry on error', async () => {
    const dc = makeDeviceCheck({ error: ref('denied') })
    const wrapper = await mountComponent(dc)
    const alert = wrapper.get('[data-testid="recovery-alert"]')
    expect(alert.text()).toContain('interview.device_check.recovery_instructions')
  })
})

// ---------------------------------------------------------------------------
// Slice 6 (Task 6.4) — device pickers wired to useMediaDeviceList +
// useDeviceCheck.switchCamera/switchMicrophone. Reka-ui's SelectContent is
// Teleport-rendered only while open, so these tests assert the WIRING via the
// non-portalled Select root component (model-value binding, disabled state,
// update:model-value -> switch call) rather than the portalled dropdown
// items — actual dropdown interaction is Playwright's job (task 6.1-6.3).
// ---------------------------------------------------------------------------

describe('DeviceCheck.client.vue — mount-time orchestration (D4 data flow)', () => {
  it('refreshes (pre-flight), validates preferences, then checks with the validated selection', async () => {
    const callOrder: string[] = []
    const mdl = makeMediaDeviceList({
      refresh: vi.fn(() => {
        callOrder.push('refresh')
        return Promise.resolve()
      }),
      validatePreferences: vi.fn(() => {
        callOrder.push('validatePreferences')
        return { cameraId: 'cam-9', micId: 'mic-9' }
      }),
    })
    const dc = makeDeviceCheck({
      check: vi.fn((sel?: DeviceSelection) => {
        callOrder.push(`check:${JSON.stringify(sel)}`)
        return Promise.resolve()
      }),
    })

    await mountComponent(dc, mdl)

    // refresh() runs twice — pre-flight (ids only) and post-grant (labels,
    // D4 data flow) — with validatePreferences()/check() sandwiched between
    // the two.
    expect(callOrder).toEqual([
      'refresh',
      'validatePreferences',
      `check:${JSON.stringify({ cameraId: 'cam-9', micId: 'mic-9' })}`,
      'refresh',
    ])
  })

  it('on a successful acquisition, persists the reconciled activeSelection and starts the devicechange subscription', async () => {
    const mdl = makeMediaDeviceList()
    const dc = makeDeviceCheck({
      cameraOk: ref(true),
      error: ref(null),
      activeSelection: ref({ cameraId: 'cam-actual', micId: 'mic-actual' }),
    })

    await mountComponent(dc, mdl)

    expect(mdl.persist).toHaveBeenCalledWith({ cameraId: 'cam-actual', micId: 'mic-actual' })
    expect(mdl.start).toHaveBeenCalledOnce()
  })

  it('does NOT persist when the acquisition failed (nothing real to reconcile to)', async () => {
    const mdl = makeMediaDeviceList()
    const dc = makeDeviceCheck({ cameraOk: ref(false), error: ref('not_found') })

    await mountComponent(dc, mdl)

    expect(mdl.persist).not.toHaveBeenCalled()
  })

  it('stops the devicechange subscription on unmount', async () => {
    const mdl = makeMediaDeviceList()
    const wrapper = await mountComponent(makeDeviceCheck(), mdl)

    wrapper.unmount()

    expect(mdl.stop).toHaveBeenCalledOnce()
  })
})

describe('DeviceCheck.client.vue — device pickers (D11 item 2)', () => {
  it('renders two Select pickers bound to the composable-reported active selection', async () => {
    const dc = makeDeviceCheck({
      cameraOk: ref(true),
      activeSelection: ref({ cameraId: 'cam-1', micId: 'mic-1' }),
    })
    const wrapper = await mountComponent(dc)

    const selects = wrapper.findAllComponents(Select)
    expect(selects).toHaveLength(2)
    expect(selects[0]!.props('modelValue')).toBe('cam-1')
    expect(selects[1]!.props('modelValue')).toBe('mic-1')
  })

  it('picking a camera calls switchCamera with the selected deviceId', async () => {
    const mdl = makeMediaDeviceList({
      cameras: ref([
        { deviceId: 'cam-1', label: 'Cam 1', isFallbackLabel: false },
        { deviceId: 'cam-2', label: 'Cam 2', isFallbackLabel: false },
      ]),
    })
    const dc = makeDeviceCheck({ cameraOk: ref(true) })
    const wrapper = await mountComponent(dc, mdl)

    const cameraSelect = wrapper.findAllComponents(Select)[0]!
    await cameraSelect.vm.$emit('update:modelValue', 'cam-2')

    expect(dc.switchCamera).toHaveBeenCalledWith('cam-2')
    expect(dc.switchMicrophone).not.toHaveBeenCalled()
  })

  it('picking a microphone calls switchMicrophone with the selected deviceId', async () => {
    const mdl = makeMediaDeviceList({
      microphones: ref([{ deviceId: 'mic-2', label: 'Mic 2', isFallbackLabel: false }]),
    })
    const dc = makeDeviceCheck({ cameraOk: ref(true) })
    const wrapper = await mountComponent(dc, mdl)

    const micSelect = wrapper.findAllComponents(Select)[1]!
    await micSelect.vm.$emit('update:modelValue', 'mic-2')

    expect(dc.switchMicrophone).toHaveBeenCalledWith('mic-2')
    expect(dc.switchCamera).not.toHaveBeenCalled()
  })

  it('a successful switch persists the reconciled activeSelection', async () => {
    const mdl = makeMediaDeviceList()
    const activeSelection = ref<DeviceSelection>({ cameraId: 'cam-1', micId: 'mic-1' })
    const dc = makeDeviceCheck({
      cameraOk: ref(true),
      activeSelection,
      switchCamera: vi.fn(async (id: string) => {
        activeSelection.value = { cameraId: id, micId: 'mic-1' }
      }),
    })
    const wrapper = await mountComponent(dc, mdl)
    mdl.persist.mockClear() // clear the mount-time persist() call

    const cameraSelect = wrapper.findAllComponents(Select)[0]!
    await cameraSelect.vm.$emit('update:modelValue', 'cam-2')
    await flushPromises()

    expect(mdl.persist).toHaveBeenCalledWith({ cameraId: 'cam-2', micId: 'mic-1' })
  })

  it('both pickers are disabled while a switch is in flight', async () => {
    const dc = makeDeviceCheck({ cameraOk: ref(true), switching: ref(true) })
    const wrapper = await mountComponent(dc)

    const selects = wrapper.findAllComponents(Select)
    expect(selects[0]!.props('disabled')).toBe(true)
    expect(selects[1]!.props('disabled')).toBe(true)
  })

  it('both pickers are permanently disabled once Continue has been pressed (A7)', async () => {
    const stream = new MediaStream()
    const dc = makeDeviceCheck({
      cameraOk: ref(true),
      micOk: ref(true),
      switching: ref(false),
      stream: ref(stream),
    })
    const wrapper = await mountComponent(dc)

    let selects = wrapper.findAllComponents(Select)
    expect(selects[0]!.props('disabled')).toBe(false)

    await wrapper.get('[data-testid="continue-button"]').trigger('click')

    selects = wrapper.findAllComponents(Select)
    expect(selects[0]!.props('disabled')).toBe(true)
    expect(selects[1]!.props('disabled')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Accessibility cleanup — decorative dots (D5)
// ---------------------------------------------------------------------------

describe('DeviceCheck.client.vue — decorative status dots', () => {
  it('the camera status dot is aria-hidden and carries no role or aria-label (today it double-announces)', async () => {
    const dc = makeDeviceCheck({ cameraOk: ref(true) })
    const wrapper = await mountComponent(dc)
    const dot = wrapper.get('[data-testid="camera-status-dot"]')
    expect(dot.attributes('aria-hidden')).toBe('true')
    expect(dot.attributes('role')).toBeUndefined()
    expect(dot.attributes('aria-label')).toBeUndefined()
  })

  it('the mic status dot is aria-hidden and carries no role or aria-label', async () => {
    const dc = makeDeviceCheck({ micOk: ref(true) })
    const wrapper = await mountComponent(dc)
    const dot = wrapper.get('[data-testid="mic-status-dot"]')
    expect(dot.attributes('aria-hidden')).toBe('true')
    expect(dot.attributes('role')).toBeUndefined()
    expect(dot.attributes('aria-label')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Zero literal strings (source-level, task 5.6 acceptance)
// ---------------------------------------------------------------------------

describe('DeviceCheck.client.vue — zero literal (non-i18n) strings', () => {
  const source = readFileSync(
    resolve(__dirname, '../../app/components/DeviceCheck.client.vue'),
    'utf-8'
  )
  const templateMatch = source.match(/<template>([\s\S]*?)<\/template>/)

  it('the template block exists', () => {
    expect(templateMatch).not.toBeNull()
  })

  it('has no bare text nodes outside {{ $t(...) }} interpolations', () => {
    const template = templateMatch![1]!
    const withoutComments = template.replace(/<!--[\s\S]*?-->/g, '')
    const textNodes = withoutComments.match(/>([^<]+)</g) ?? []
    for (const node of textNodes) {
      const text = node.slice(1, -1)
      if (text.trim() === '') continue
      const withoutMustache = text.replace(/\{\{[\s\S]*?\}\}/g, '')
      expect(withoutMustache.trim(), `Bare text node found: "${text.trim()}"`).toBe('')
    }
  })

  it('has no hardcoded (unbound) aria-label attributes', () => {
    const staticAriaLabel = /(?<!:)aria-label="[^"{]+"/g
    expect(source.match(staticAriaLabel) ?? []).toEqual([])
  })

  it('no longer hardcodes the old English "Camera not accessible" string', () => {
    expect(source).not.toContain('Camera not accessible')
  })
})
