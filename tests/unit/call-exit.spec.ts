/**
 * CallExitDialog — the call screen's Exit button and its confirmation
 * (DESIGN.md §7.3, §9; change `candidate-interview-call-ui`, D9, A4).
 *
 * The contract pinned here: the button carries the owner-fixed label; a click
 * opens a confirmation instead of leaving; Escape and "Stay" close it and focus
 * returns to the button; "Suspend and leave" emits `confirm` exactly once; the
 * deadline in the body is the stored session's `exp`, formatted in the ACTIVE
 * locale, and is dropped (never guessed) when the stored session cannot be read;
 * while a handover is in flight the button is disabled and shows its loading
 * state, never hidden.
 *
 * `$t` is a recorder that echoes the key and its params, so the copy asserted is
 * the key the component asked for, not a translation that could drift.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import CallExitDialog from '../../app/components/molecules/CallExitDialog.vue'
import { formatDeadline } from '../../app/utils/call-deadline'

const { mockRead } = vi.hoisted(() => ({ mockRead: vi.fn() }))

vi.mock('~/composables/useCandidateSession', () => ({
  useCandidateSession: () => ({ read: mockRead, clear: vi.fn(), store: vi.fn() }),
}))

// 14:30 UTC on a fixed day; the expected text is built with the same Intl call
// the component documents, per locale, so the spec is timezone independent.
const EXP = Date.UTC(2026, 9, 9, 14, 30) / 1000
const clock = (locale: string, exp = EXP) =>
  new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(exp * 1000)

const locale = ref('it')
let wrapper: VueWrapper | undefined

const $t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}|${JSON.stringify(params)}` : key

function mountDialog(props: Record<string, unknown> = {}) {
  wrapper = mount(CallExitDialog, {
    props,
    attachTo: document.body,
    global: { mocks: { $t } },
  })
  return wrapper
}

const button = () => document.querySelector<HTMLButtonElement>('[data-testid="call-exit"]')!
const dialog = () => document.querySelector('[role="dialog"]')
const byTestId = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)

async function settle() {
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await flushPromises()
}

async function openDialog() {
  button().focus()
  button().click()
  await settle()
  expect(dialog()).not.toBeNull()
}

beforeEach(() => {
  locale.value = 'it'
  mockRead.mockReset()
  mockRead.mockReturnValue({ accessToken: 't', exp: EXP, candidateRef: 'c', projectId: 1 })
  vi.stubGlobal(
    'useI18n',
    vi.fn(() => ({ t: (key: string) => key, locale }))
  )
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('CallExitDialog — the button', () => {
  it('is labelled with the owner-fixed Exit label and opens nothing by itself', async () => {
    mountDialog()
    await settle()

    expect(button().textContent).toContain('interview.call.exit.label')
    expect(dialog()).toBeNull()
  })

  it('opens the confirmation on click', async () => {
    mountDialog()
    await openDialog()

    expect(dialog()!.textContent).toContain('interview.call.exit.title')
  })

  it('is disabled and shows the loading state while a handover is in flight, never hidden', async () => {
    mountDialog({ loading: true })
    await settle()

    expect(button()).not.toBeNull()
    expect(button().disabled).toBe(true)
    expect(button().getAttribute('aria-busy')).toBe('true')

    button().click()
    await settle()
    expect(dialog()).toBeNull()
  })

  it('is enabled and idle otherwise', async () => {
    mountDialog({ loading: false })
    await settle()

    expect(button().disabled).toBe(false)
    expect(button().getAttribute('aria-busy')).toBeNull()
  })
})

describe('CallExitDialog — leaving the dialog', () => {
  it('closes on Escape and returns focus to the button', async () => {
    mountDialog()
    await openDialog()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()

    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(button())
  })

  it('closes on "Stay" without confirming, and returns focus to the button', async () => {
    const view = mountDialog()
    await openDialog()

    byTestId('call-exit-stay')!.click()
    await settle()

    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(button())
    expect(view.emitted('confirm')).toBeUndefined()
  })

  it('emits confirm exactly once and closes on "Suspend and leave"', async () => {
    const view = mountDialog()
    await openDialog()

    byTestId('call-exit-confirm')!.click()
    await settle()

    expect(view.emitted('confirm')).toHaveLength(1)
    expect(dialog()).toBeNull()
  })

  it('does not confirm when it is only dismissed', async () => {
    const view = mountDialog()
    await openDialog()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()

    expect(view.emitted('confirm')).toBeUndefined()
  })
})

describe('CallExitDialog — the deadline', () => {
  it('is the stored session exp formatted in the active locale (it)', async () => {
    mountDialog()
    await openDialog()

    expect(dialog()!.textContent).toContain(
      `interview.call.exit.body|${JSON.stringify({ time: clock('it') })}`
    )
  })

  it('follows the locale when it is English', async () => {
    locale.value = 'en'
    mountDialog()
    await openDialog()

    expect(clock('en')).not.toBe(clock('it'))
    expect(dialog()!.textContent).toContain(
      `interview.call.exit.body|${JSON.stringify({ time: clock('en') })}`
    )
  })

  it('reads the stored session fresh each time the dialog opens', async () => {
    mountDialog()
    await openDialog()
    byTestId('call-exit-stay')!.click()
    await settle()

    const later = EXP + 3600
    mockRead.mockReturnValue({ accessToken: 't', exp: later, candidateRef: 'c', projectId: 1 })
    await openDialog()

    expect(dialog()!.textContent).toContain(JSON.stringify({ time: clock('it', later) }))
    expect(clock('it', later)).not.toBe(clock('it'))
  })

  it('drops the sentence, never guesses, when the stored session cannot be read', async () => {
    mockRead.mockReturnValue(null)
    mountDialog()
    await openDialog()

    const text = dialog()!.textContent!
    expect(text).toContain('interview.call.exit.body_no_deadline')
    expect(text).not.toContain('"time"')
  })
})

describe('formatDeadline', () => {
  it('formats epoch seconds as hours and minutes in the given locale', () => {
    expect(formatDeadline(EXP, 'it')).toBe(clock('it'))
    expect(formatDeadline(EXP, 'en')).toBe(clock('en'))
  })

  it('returns null when there is no usable exp', () => {
    expect(formatDeadline(null, 'it')).toBeNull()
    expect(formatDeadline(undefined, 'it')).toBeNull()
    expect(formatDeadline(Number.NaN, 'it')).toBeNull()
  })

  it('returns null for an invalid locale tag instead of throwing', () => {
    expect(formatDeadline(EXP, 'not_a_locale!')).toBeNull()
    expect(formatDeadline(EXP, 'it')).toBe(clock('it'))
  })
})
