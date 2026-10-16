/**
 * The speaking ring's contrast guarantee (DESIGN.md §3.1, §3.5; change
 * `candidate-interview-call-ui`, D5), computed rather than asserted in prose.
 *
 * The ring is the organization PRIMARY (REVISED 2026-10-16: it was a fixed
 * white), a band between two `--color-avatar-bg` bands, so it does not depend
 * on the video behind the tile. `applyBrandColor` lifts the primary only as far
 * as 3:1 against the panel needs. This spec measures the pair with the same
 * `contrastRatio` the runtime derivation uses, for the whole screenshot
 * matrix, and proves the panel token is outside every brand token list.
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
import { contrastRatio, ensureContrast } from '../../app/utils/brand-color'

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
  it('declares --color-speaking-ring as the Quint primary lifted to 3:1 and --color-avatar-bg as #0f172a', () => {
    expect(RING?.toLowerCase()).toBe(ensureContrast('#771aaf', '#0f172a', 3))
    expect(RING?.toLowerCase()).toBe('#9c59c5')
    expect(PANEL?.toLowerCase()).toBe('#0f172a')
  })

  it('declares --spacing-call-panel as 22rem (352 px)', () => {
    expect(CSS).toMatch(/^\s*--spacing-call-panel:\s*22rem;/m)
  })
})

describe.each(MATRIX)('speaking ring contrast — %s', (_label, brand) => {
  afterEach(() => {
    applyBrandColor(null)
  })

  const ring = (): string =>
    document.documentElement.style.getPropertyValue('--color-speaking-ring') || (RING as string)

  it('the primary band clears 3:1 against --color-avatar-bg', () => {
    applyBrandColor(brand)

    expect(contrastRatio(ring(), PANEL as string)).toBeGreaterThanOrEqual(3)
  })

  it('is the primary itself when it already reaches 3:1, a lightened variant otherwise', () => {
    applyBrandColor(brand)

    const primary = brand ?? '#771aaf'
    const reaches = contrastRatio(primary, PANEL as string) >= 3

    expect(ring()).toBe(reaches ? primary : ensureContrast(primary, PANEL as string, 3))
  })

  it('applying the brand never writes the panel token', () => {
    applyBrandColor(brand)

    expect(document.documentElement.style.getPropertyValue('--color-avatar-bg')).toBe('')
  })

  it('clearing the brand removes the ring override, so the stylesheet default returns', () => {
    applyBrandColor(brand ?? '#ffd400')
    applyBrandColor(null)

    expect(document.documentElement.style.getPropertyValue('--color-speaking-ring')).toBe('')
  })
})

describe('the ring is drawn from the two ring tokens plus the on-canvas hairline', () => {
  const BRAND_TOKENS: readonly string[] = [
    ...BRAND_COLOR_TOKENS,
    ...BRAND_DERIVED_TOKENS,
    ...BRAND_ON_PRIMARY_TOKENS,
  ]

  it('the ring token is a derived brand token and the panel is not', () => {
    expect(BRAND_DERIVED_TOKENS).toContain('--color-speaking-ring')
    expect(BRAND_TOKENS).not.toContain('--color-avatar-bg')
  })

  it('--color-speaking-ring is a hex literal, not a var() reference', () => {
    expect(CSS).not.toMatch(/--color-speaking-ring:\s*var\(/)
  })

  it('the component references only the ring tokens and the on-canvas hairline, never a brand variable', () => {
    const source = componentSource()
    const referenced = new Set([...source.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))

    expect([...referenced].sort()).toEqual([
      '--color-avatar-bg',
      '--color-on-canvas',
      '--color-speaking-ring',
    ])
    // No other brand variable, and the halo follows the ring colour (not a fixed white).
    for (const token of BRAND_TOKENS.filter((t) => t !== '--color-speaking-ring')) {
      expect(source).not.toContain(token)
    }
    expect(source).not.toContain('rgb(255_255_255')
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

describe('the name chip (live-interview-call-chrome, D16)', () => {
  const CHIP_BACKGROUND = 'bg-black/60'

  /** The chip's background composited over a video pixel, channel by channel (black at `alpha`). */
  const composite = (frame: number, alpha: number) => Math.round(frame * (1 - alpha))
  const hex = (channel: number) => `#${channel.toString(16).padStart(2, '0').repeat(3)}`

  it('is white on black at 60%, and no longer the 80% avatar panel', () => {
    const source = componentSource()

    expect(source).toContain(CHIP_BACKGROUND)
    expect(source).toMatch(/(^|\s)text-white(\s|")/m)
    expect(source).not.toContain('bg-avatar-bg/80')
  })

  it('clears 4.5:1 for white text over a white video frame (composited #666666, about 5.7:1)', () => {
    const backing = hex(composite(255, 0.6))

    expect(backing).toBe('#666666')
    expect(contrastRatio('#ffffff', backing)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#ffffff', backing)).toBeCloseTo(5.74, 1)
  })

  it('only gets better over a darker frame', () => {
    expect(contrastRatio('#ffffff', hex(composite(128, 0.6)))).toBeGreaterThan(
      contrastRatio('#ffffff', hex(composite(255, 0.6)))
    )
    expect(contrastRatio('#ffffff', hex(composite(0, 0.6)))).toBeCloseTo(21, 0)
  })
})
