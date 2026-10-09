/**
 * The speaking ring's contrast guarantee (DESIGN.md §3.1, §3.5; change
 * `candidate-interview-call-ui`, D5), computed rather than asserted in prose.
 *
 * The ring is a white band between two `--color-avatar-bg` bands, so it does
 * not depend on the brand colour or on the video behind the tile. This spec
 * measures the pair with the same `contrastRatio` the runtime derivation uses,
 * for the whole screenshot matrix, and proves the tokens are outside every
 * brand token list so no tenant colour can ever reach them.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  applyBrandColor,
  BRAND_COLOR_TOKENS,
  BRAND_DERIVED_TOKENS,
  BRAND_ON_PRIMARY_TOKENS,
} from '../../app/composables/useBrandTheme'
import { contrastRatio } from '../../app/utils/brand-color'

const CSS = readFileSync(resolve(__dirname, '../../app/assets/css/main.css'), 'utf8')
/** Read lazily so a missing component fails its own test, not the whole file. */
const componentSource = () =>
  readFileSync(resolve(__dirname, '../../app/components/molecules/CallTile.vue'), 'utf8')

/** The `@theme` literal for one token, as authored in the stylesheet. */
function themeLiteral(token: string): string | null {
  return new RegExp(`^\\s*${token}:\\s*(#[0-9a-fA-F]{6});`, 'm').exec(CSS)?.[1] ?? null
}

const RING = themeLiteral('--color-speaking-ring')
const PANEL = themeLiteral('--color-avatar-bg')

const MATRIX: ReadonlyArray<[label: string, color: string | null]> = [
  ['light #ffd400', '#ffd400'],
  ['dark #771aaf', '#771aaf'],
  ['mid-tone #2f6fed', '#2f6fed'],
  ['none (Quint fallback)', null],
]

describe('the ring tokens are literals in the stylesheet', () => {
  it('declares --color-speaking-ring as #ffffff and --color-avatar-bg as #0f172a', () => {
    expect(RING?.toLowerCase()).toBe('#ffffff')
    expect(PANEL?.toLowerCase()).toBe('#0f172a')
  })

  it('declares --spacing-call-panel as 18rem', () => {
    expect(CSS).toMatch(/^\s*--spacing-call-panel:\s*18rem;/m)
  })
})

describe.each(MATRIX)('speaking ring contrast — %s', (_label, brand) => {
  afterEach(() => {
    applyBrandColor(null)
  })

  it('the white band clears 3:1 against --color-avatar-bg (about 17.9:1)', () => {
    applyBrandColor(brand)

    const ratio = contrastRatio(RING as string, PANEL as string)

    expect(ratio).toBeGreaterThanOrEqual(3)
    expect(ratio).toBeCloseTo(17.9, 1)
  })

  it('applying the brand never writes the ring or the panel token', () => {
    applyBrandColor(brand)
    const style = document.documentElement.style

    expect(style.getPropertyValue('--color-speaking-ring')).toBe('')
    expect(style.getPropertyValue('--color-avatar-bg')).toBe('')
  })
})

describe('the ring uses no brand token', () => {
  const BRAND_TOKENS: readonly string[] = [
    ...BRAND_COLOR_TOKENS,
    ...BRAND_DERIVED_TOKENS,
    ...BRAND_ON_PRIMARY_TOKENS,
  ]

  it('neither ring token is in a brand token list', () => {
    expect(BRAND_TOKENS).not.toContain('--color-speaking-ring')
    expect(BRAND_TOKENS).not.toContain('--color-avatar-bg')
  })

  it('--color-speaking-ring is a hex literal, not a var() reference', () => {
    expect(CSS).not.toMatch(/--color-speaking-ring:\s*var\(/)
  })

  it('the component references only the two ring tokens, never a brand variable', () => {
    const source = componentSource()
    const referenced = new Set([...source.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))

    expect([...referenced].sort()).toEqual(['--color-avatar-bg', '--color-speaking-ring'])
    for (const token of BRAND_TOKENS) expect(source).not.toContain(token)
  })
})

describe('forced colours', () => {
  const RULE = /@media\s*\(forced-colors:\s*active\)\s*\{([^@]*?\n\})/

  it('replaces the dropped box-shadow of a lit tile with a Highlight outline', () => {
    const body = RULE.exec(CSS)?.[1] ?? ''

    expect(body).toContain("[data-slot='call-tile'][data-speaking='true']")
    expect(body).toMatch(/outline:\s*4px solid Highlight;/)
  })
})
