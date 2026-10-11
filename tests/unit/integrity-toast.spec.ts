/**
 * IntegrityToast + the candidate Toaster: what a candidate actually reads when
 * the proctor records an integrity event.
 *
 * Mounted against the REAL vue-sonner Toaster (IntegrityToaster, the one the
 * interview mounts, over the shadcn-vue wrapper) and the
 * REAL locale files, so each assertion is about the text that lands in the DOM:
 * a localized, calm instruction (title + one line) per event type, never the
 * machine kind, and a generic localized fallback for a kind this build does not
 * know.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { toast } from 'vue-sonner'
import IntegrityToast from '../../app/components/IntegrityToast.vue'
import IntegrityToaster from '../../app/components/molecules/IntegrityToaster.vue'
import { INTEGRITY_KINDS, type IntegrityEventInternal } from '../../app/utils/proctor-config'
import { CANDIDATE_FACING_KINDS, integrityToastKey } from '../../app/utils/integrity-toast-copy'
import itMessages from '../../i18n/locales/it.json'
import enMessages from '../../i18n/locales/en.json'

type Messages = Record<string, unknown>

/** Minimal `t()` over the real locale JSON: a missing key comes back as the key, like vue-i18n. */
function translatorFor(messages: Messages): (key: string) => string {
  return (key: string) => {
    const value = key
      .split('.')
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
        messages
      )
    return typeof value === 'string' ? value : key
  }
}

interface ToastCopy {
  title: string
  description: string
}

function copyFor(messages: Messages, kind: string): ToastCopy {
  const block = (messages as { interview: { integrity_toast: Record<string, ToastCopy> } })
    .interview.integrity_toast
  return block[kind]!
}

const LOCALES = [
  ['it', itMessages as Messages],
  ['en', enMessages as Messages],
] as const

let wrapper: VueWrapper | null = null

async function mountShell(messages: Messages, position?: 'top-right' | 'top-left') {
  const t = translatorFor(messages)
  vi.stubGlobal(
    'useI18n',
    vi.fn(() => ({ t, locale: ref('it') }))
  )
  const events = ref<IntegrityEventInternal[]>([])
  const Shell = defineComponent({
    setup: () => () =>
      h('div', [
        h('button', { id: 'focused-control', type: 'button' }, 'control'),
        h(IntegrityToaster, position ? { position } : undefined),
        h(IntegrityToast, { events: events.value }),
      ]),
  })
  wrapper = mount(Shell, { attachTo: document.body, global: { mocks: { $t: t } } })
  await nextTick()

  return {
    async emit(type: string) {
      events.value = [
        ...events.value,
        { type: type as IntegrityEventInternal['type'], ts: new Date().toISOString(), meta: null },
      ]
      await wrapper!.vm.$forceUpdate()
      await nextTick()
      await flushPromises()
      await nextTick()
    },
    toasts: () => Array.from(document.querySelectorAll('[data-sonner-toast]')),
  }
}

beforeEach(() => {
  toast.dismiss()
})

afterEach(async () => {
  toast.dismiss()
  wrapper?.unmount()
  wrapper = null
  await nextTick()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('integrity toast copy — every candidate-facing kind, in it and en', () => {
  describe.each(LOCALES)('%s', (_locale, messages) => {
    it.each(CANDIDATE_FACING_KINDS.map((kind) => [kind]))(
      '%s shows its localized title and instruction, never the raw kind',
      async (kind) => {
        const shell = await mountShell(messages)
        await shell.emit(kind)

        const [rendered] = shell.toasts()
        expect(rendered, 'a toast is rendered').toBeTruthy()
        const copy = copyFor(messages, kind)
        expect(rendered!.querySelector('[data-title]')?.textContent?.trim()).toBe(copy.title)
        expect(rendered!.querySelector('[data-description]')?.textContent?.trim()).toBe(
          copy.description
        )

        const text = rendered!.textContent ?? ''
        expect(text).not.toContain(kind)
        expect(text).not.toContain(kind.replace(/_/g, ' '))
        expect(text).not.toContain('integrity_toast')
      }
    )

    it('an unknown kind falls back to the generic localized message, never the raw string', async () => {
      const shell = await mountShell(messages)
      await shell.emit('brand_new_kind')

      const [rendered] = shell.toasts()
      const generic = copyFor(messages, 'generic')
      expect(rendered!.querySelector('[data-title]')?.textContent?.trim()).toBe(generic.title)
      expect(rendered!.querySelector('[data-description]')?.textContent?.trim()).toBe(
        generic.description
      )
      expect(rendered!.textContent).not.toContain('brand_new_kind')
      expect(rendered!.textContent).not.toContain('brand new kind')
    })

    it('labels the live region in the candidate language', async () => {
      await mountShell(messages)
      const region = document.querySelector('section[aria-live]')

      expect(region?.getAttribute('aria-live')).toBe('polite')
      const label = (messages as { interview: { integrity_toast: { region_label: string } } })
        .interview.integrity_toast.region_label
      expect(region?.getAttribute('aria-label')).toContain(label)
    })
  })
})

describe('integrity toast behaviour', () => {
  it('stays silent for proctor_unavailable: a failure of ours, nothing the candidate can do', async () => {
    const shell = await mountShell(enMessages as Messages)
    await shell.emit('proctor_unavailable')

    expect(shell.toasts()).toHaveLength(0)
  })

  it('shows one toast per kind: a repeated kind replaces its toast instead of stacking', async () => {
    const shell = await mountShell(enMessages as Messages)
    await shell.emit('looking_away')
    await shell.emit('looking_away')

    expect(shell.toasts()).toHaveLength(1)
  })

  it('never steals focus from the control the candidate is on', async () => {
    const shell = await mountShell(enMessages as Messages)
    const control = document.getElementById('focused-control') as HTMLButtonElement
    control.focus()
    await shell.emit('face_absent')

    expect(shell.toasts()).toHaveLength(1)
    expect(document.activeElement).toBe(control)
  })

  it('is dismissible with a localized close control', async () => {
    const shell = await mountShell(enMessages as Messages)
    await shell.emit('too_far')

    const close = shell.toasts()[0]!.querySelector('button[data-close-button]')
    expect(close?.getAttribute('aria-label')).toBe(
      (enMessages as { interview: { integrity_toast: { close: string } } }).interview
        .integrity_toast.close
    )
  })

  it('does nothing when the events list does not grow', async () => {
    const shell = await mountShell(enMessages as Messages)
    await shell.emit('tab_hidden')
    toast.dismiss()
    await flushPromises()
    await wrapper!.vm.$forceUpdate()
    await nextTick()

    expect(shell.toasts().filter((el) => el.getAttribute('data-removed') !== 'true')).toHaveLength(
      0
    )
  })
})

describe('integrity toast position (candidate-interview-call-ui D11)', () => {
  /** What vue-sonner stamps on the list a toast sits in. */
  async function positionOf(position?: 'top-right' | 'top-left') {
    const shell = await mountShell(enMessages as Messages, position)
    await shell.emit('face_absent')
    const list = document.querySelector('[data-sonner-toaster]')!
    return {
      x: list.getAttribute('data-x-position'),
      y: list.getAttribute('data-y-position'),
      style: list.getAttribute('style') ?? '',
    }
  }

  it('is top right by default, exactly as before', async () => {
    const placed = await positionOf()

    expect(placed.x).toBe('right')
    expect(placed.y).toBe('top')
  })

  it('stays top right when asked for top right', async () => {
    const placed = await positionOf('top-right')

    expect(placed.x).toBe('right')
    expect(placed.y).toBe('top')
  })

  it('honours top left, which the call screen uses so the toast never covers the side panel', async () => {
    const placed = await positionOf('top-left')

    expect(placed.x).toBe('left')
    expect(placed.y).toBe('top')
  })

  it('anchors the top-left toast to the wide header column, not the default one', async () => {
    const wide = await positionOf('top-left')

    expect(wide.style).toContain('96rem')
  })
})

describe('integrity toast key mapping', () => {
  it('covers every canonical kind except the dead-observer report', () => {
    expect([...CANDIDATE_FACING_KINDS].sort()).toEqual(
      INTEGRITY_KINDS.filter((kind) => kind !== 'proctor_unavailable').sort()
    )
  })

  it('maps a known kind to its own key, an unknown one to generic, the dead observer to null', () => {
    expect(integrityToastKey('looking_away')).toBe('interview.integrity_toast.looking_away')
    expect(integrityToastKey('something_else')).toBe('interview.integrity_toast.generic')
    expect(integrityToastKey('proctor_unavailable')).toBeNull()
  })

  it.each(LOCALES)('%s has a non-empty title and description for every key', (_l, messages) => {
    for (const kind of [...CANDIDATE_FACING_KINDS, 'generic']) {
      const copy = copyFor(messages, kind)
      expect(copy?.title?.trim().length, `${kind}.title`).toBeGreaterThan(0)
      expect(copy?.description?.trim().length, `${kind}.description`).toBeGreaterThan(0)
    }
  })

  it('the Italian and English copy are actually translated', () => {
    for (const kind of [...CANDIDATE_FACING_KINDS, 'generic']) {
      expect(copyFor(itMessages as Messages, kind).title).not.toBe(
        copyFor(enMessages as Messages, kind).title
      )
    }
  })
})
