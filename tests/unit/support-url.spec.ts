/**
 * Support URL (candidate-interview-call-ui, UI-08; design D10).
 *
 * `sanitizeSupportUrl` is the pure gate: only `https:` and `mailto:` survive,
 * everything else falls back to the mailbox the app already ships. The value
 * ends up in an `href`, so a `javascript:` or `data:` URL here would be a
 * script a candidate clicks. `useSupportUrl` reads it from the runtime config,
 * defensively: Nuxt coerces NUXT_PUBLIC_* env values, so it may not be a string.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { DEFAULT_SUPPORT_URL, sanitizeSupportUrl } from '~/app/utils/support-url'
import { useSupportUrl } from '~/app/composables/useSupportUrl'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sanitizeSupportUrl', () => {
  it('defaults to the mailbox the app already ships', () => {
    expect(DEFAULT_SUPPORT_URL).toBe('mailto:support@beai.app')
  })

  it.each([
    ['an https page', 'https://help.example.com/audio-video'],
    ['an https page with a query', 'https://help.example.com/a?b=1&c=2#top'],
    ['a mailto address', 'mailto:help@example.com'],
    ['a mailto with a subject', 'mailto:help@example.com?subject=Audio%20problem'],
    ['an upper-case scheme', 'HTTPS://help.example.com/'],
  ])('accepts %s', (_label, value) => {
    expect(sanitizeSupportUrl(value)).toBe(value)
  })

  it('trims surrounding whitespace from an accepted value', () => {
    expect(sanitizeSupportUrl('  https://help.example.com/x \n')).toBe('https://help.example.com/x')
  })

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['http', 'http://help.example.com/'],
    ['javascript', 'javascript:alert(1)'],
    ['javascript in mixed case', 'JaVaScRiPt:alert(1)'],
    ['javascript behind a control character', '\u0001javascript:alert(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['relative path', '/support'],
    ['protocol-relative', '//evil.example.com/'],
    ['bare host', 'help.example.com'],
    ['ftp', 'ftp://help.example.com/'],
    ['malformed https', 'https://'],
    ['scheme only https', 'https:'],
    ['scheme only mailto', 'mailto:'],
    ['garbage', 'not a url at all'],
  ])('falls back for %s', (_label, value) => {
    expect(sanitizeSupportUrl(value)).toBe(DEFAULT_SUPPORT_URL)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a boolean', true],
    ['an object', { href: 'https://help.example.com/' }],
  ])('falls back for %s, which Nuxt env coercion can produce', (_label, value) => {
    expect(sanitizeSupportUrl(value)).toBe(DEFAULT_SUPPORT_URL)
  })
})

describe('useSupportUrl', () => {
  function withConfig(supportUrl: unknown): string {
    vi.stubGlobal(
      'useRuntimeConfig',
      vi.fn(() => ({ public: { supportUrl } }))
    )

    return useSupportUrl()
  }

  it('returns the configured https URL', () => {
    expect(withConfig('https://help.example.com/')).toBe('https://help.example.com/')
  })

  it('returns the default when nothing is configured', () => {
    expect(withConfig('')).toBe(DEFAULT_SUPPORT_URL)
    expect(withConfig(undefined)).toBe(DEFAULT_SUPPORT_URL)
  })

  it('returns the default for a coerced non-string value', () => {
    expect(withConfig(0)).toBe(DEFAULT_SUPPORT_URL)
  })

  it('never returns an unsafe scheme', () => {
    expect(withConfig('javascript:alert(1)')).toBe(DEFAULT_SUPPORT_URL)
  })
})
