/**
 * The document title each candidate page really asks for (WCAG 2.4.2, axe
 * `document-title`), in Italian and English.
 *
 * `candidate-document-titles.spec.ts` guards the SOURCE (a localized call, never
 * a literal). This one mounts the pages and reads what they hand to `useHead`,
 * so a page that picks the wrong key, forgets a locale, or stops titling one
 * state fails here even if its source still looks right.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { toValue } from 'vue'
import en from '../../i18n/locales/en.json'
import itMessages from '../../i18n/locales/it.json'

// Every page here exchanges a token on mount; none of that matters for a title,
// so the network never answers.
vi.mock('ofetch', () => ({ $fetch: vi.fn(() => new Promise(() => undefined)) }))

vi.mock('~/app/composables/useCandidateBranding', () => ({
  useCandidateBranding: () => ({
    logoUrl: { value: null },
    organizationName: { value: null },
    ensureLoaded: vi.fn(),
  }),
}))

vi.mock('~/app/composables/useEmbedBridge', () => ({
  useEmbedBridge: () => ({ attach: vi.fn(), detach: vi.fn(), post: vi.fn() }),
}))

vi.mock('~/components/InterviewSession.vue', async () => {
  const { defineComponent, h } = await import('vue')

  return { default: defineComponent({ name: 'InterviewSession', render: () => h('div') }) }
})

type Messages = Record<string, unknown>

const LOCALES = [
  ['en', en],
  ['it', itMessages],
] as const

const TERMINAL_REASONS = [
  '403',
  'absent_phrase',
  'session_expired',
  'spent_link',
  'link_used',
  'link_invalid',
  'link_reopen',
] as const

function translator(messages: Messages): (key: string) => string {
  return (key) => {
    let node: unknown = messages
    for (const part of key.split('.')) {
      if (node === null || typeof node !== 'object') return key
      node = (node as Messages)[part]
    }

    return typeof node === 'string' ? node : key
  }
}

/** Mounts a page for one locale and returns the title it asked `useHead` for, resolved. */
async function titleOf(
  path: string,
  messages: Messages,
  route: { params?: Record<string, string>; query?: Record<string, string> } = {}
): Promise<unknown> {
  const useHead = vi.fn()
  const t = translator(messages)

  vi.stubGlobal('useHead', useHead)
  vi.stubGlobal(
    'useI18n',
    vi.fn(() => ({ t }))
  )
  vi.stubGlobal(
    'useRoute',
    vi.fn(() => ({ params: route.params ?? {}, query: route.query ?? {} }))
  )

  const { default: Page } = await import(/* @vite-ignore */ path)
  const wrapper = mount(Page, { global: { mocks: { $t: t } } })
  await flushPromises()
  wrapper.unmount()

  const input = useHead.mock.calls
    .map((call) => call[0] as { title?: unknown })
    .find((candidate) => 'title' in candidate)

  return input === undefined ? undefined : toValue(input.title as never)
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('navigateTo', vi.fn())
  vi.stubGlobal(
    'useLocalePath',
    vi.fn(() => (path: string) => path)
  )
  vi.stubGlobal(
    'useRouter',
    vi.fn(() => ({ replace: vi.fn(), back: vi.fn() }))
  )
  vi.stubGlobal(
    'useRuntimeConfig',
    vi.fn(() => ({ public: { apiBase: 'https://api.test/api', interviewProviderMock: 'false' } }))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe.each(LOCALES)('document titles (%s)', (_locale, messages) => {
  const interview = messages.interview as Messages & {
    document_title: string
    done: { title: string }
    error: { title: string }
    terminal: Record<string, { title: string }>
  }

  it.each([
    ['the entry route /interview/{token}', '~/app/pages/interview/[token].vue', 'token'],
    ['the hosted entry /i/{token}', '~/app/pages/i/[token].vue', 'token'],
    ['the embed route /embed/{token}', '~/app/pages/embed/[token].vue', 'token'],
  ])('%s is titled with the generic interview title while it loads', async (_name, page, key) => {
    expect(await titleOf(page, messages, { params: { [key]: 'abc' } })).toBe(
      interview.document_title
    )
  })

  it('the done page is titled with its own heading', async () => {
    expect(await titleOf('~/app/pages/interview/done.vue', messages)).toBe(interview.done.title)
  })

  it('the error page is titled with its own heading', async () => {
    expect(await titleOf('~/app/pages/interview/error.vue', messages)).toBe(interview.error.title)
  })

  it.each(TERMINAL_REASONS)('the terminal page is titled for reason %s', async (reason) => {
    const title = await titleOf('~/app/pages/interview/terminal.vue', messages, {
      query: { reason },
    })

    expect(title).toBe(interview.terminal[reason]?.title)
    expect(String(title).trim().length).toBeGreaterThan(0)
  })

  it('the terminal page falls back to the 403 title for an unknown reason', async () => {
    expect(
      await titleOf('~/app/pages/interview/terminal.vue', messages, { query: { reason: 'nope' } })
    ).toBe(interview.terminal['403']?.title)
  })
})
