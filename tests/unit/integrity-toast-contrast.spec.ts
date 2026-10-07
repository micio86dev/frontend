/**
 * The integrity toast is legible on any client colour (DESIGN.md §7.0.1, §9.1).
 *
 * The toast is drawn on its own opaque white surface, like every other card on
 * the brand canvas, so none of its pairs may depend on the operator's colour.
 * This spec pins both halves of that claim: the Toaster wrapper paints with the
 * card tokens and `--color-error-dark` (read from its source), and each pair
 * those tokens form clears its threshold for every colour of the screenshot
 * matrix, computed with the same `contrastRatio` the runtime derivation uses.
 * The e2e spec reads the colours the browser actually resolved.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { contrastRatio } from '../../app/utils/brand-color'
import { deriveOnPrimaryTokens } from '../../app/composables/useBrandTheme'

const root = resolve(__dirname, '../..')
const sonnerSource = readFileSync(resolve(root, 'app/components/ui/sonner/Sonner.vue'), 'utf8')
const mainCss = readFileSync(resolve(root, 'app/assets/css/main.css'), 'utf8')

function token(name: string): string {
  const match = mainCss.match(new RegExp(`${name}:\\s*([^;]+);`))
  return match![1]!.trim()
}

/** `--card` is oklch(1 0 0): white. */
const CARD = '#ffffff'
/** `--card-foreground` is oklch(0.145 0 0): L³ = 0.00305 linear, i.e. #0a0a0a. */
const CARD_FOREGROUND = '#0a0a0a'
const ERROR_DARK = token('--color-error-dark')

const MATRIX: ReadonlyArray<[label: string, color: string | null]> = [
  ['light #ffd400', '#ffd400'],
  ['dark #771aaf', '#771aaf'],
  ['mid-tone #2f6fed', '#2f6fed'],
  ['none (Quint fallback)', null],
]

describe('integrity toast — the wrapper paints with the card tokens', () => {
  it('resolves the tokens this spec computes with', () => {
    expect(token('--card')).toBe('oklch(1 0 0)')
    expect(token('--card-foreground')).toBe('oklch(0.145 0 0)')
    expect(ERROR_DARK).toBe('#b91c1c')
  })

  it('draws the surface, text and description with card tokens, the accent with error-dark', () => {
    expect(sonnerSource).toMatch(/--normal-bg:\s*var\(--card\)/)
    expect(sonnerSource).toMatch(/--normal-text:\s*var\(--card-foreground\)/)
    expect(sonnerSource).toMatch(
      /\[data-description\][^{]*\{[^}]*color:\s*var\(--card-foreground\)/
    )
    expect(sonnerSource).toMatch(/var\(--color-error-dark\)/)
  })

  it('never paints the toast with a brand token, so no pair can follow the client colour', () => {
    expect(sonnerSource).not.toMatch(/var\(--(color-)?primary/)
    expect(sonnerSource).not.toMatch(/var\(--color-on-primary/)
  })
})

describe.each(MATRIX)('integrity toast contrast — %s', (_label, primary) => {
  // Deriving the canvas proves the matrix colour is a real canvas; the toast's
  // own pairs are then independent of it because the surface is opaque.
  const canvas = primary ?? '#771aaf'
  const tokens = deriveOnPrimaryTokens(canvas)

  it('title and description (card-foreground) clear 4.5:1 on the white surface', () => {
    expect(tokens['--color-on-primary']).toBeTruthy()
    expect(contrastRatio(CARD_FOREGROUND, CARD)).toBeGreaterThanOrEqual(4.5)
  })

  it('the warning accent (error-dark icon and edge) clears 4.5:1 on the white surface', () => {
    expect(contrastRatio(ERROR_DARK, CARD)).toBeGreaterThanOrEqual(4.5)
  })

  it('the close control glyph (card-foreground) clears 3:1 on the white surface', () => {
    expect(contrastRatio(CARD_FOREGROUND, CARD)).toBeGreaterThanOrEqual(3)
  })
})
