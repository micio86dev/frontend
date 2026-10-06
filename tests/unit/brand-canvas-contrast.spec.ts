/**
 * The brand canvas contrast guarantees (DESIGN.md §7.0.1, §9.1).
 *
 * The canvas colour is chosen by an operator, so no pair drawn on it can be
 * pre-verified in DESIGN.md's table. This spec is that table, computed: for
 * every colour of the screenshot matrix it asserts each text/background pair
 * the candidate canvas introduces, using the same `contrastRatio` the runtime
 * derivation uses. "None" is the Quint fallback, i.e. the stylesheet defaults,
 * which `token-parity.spec.ts` pins to the derivation for `#771aaf`.
 */
import { describe, it, expect } from 'vitest'
import { deriveOnPrimaryTokens } from '../../app/composables/useBrandTheme'
import { contrastRatio, mix } from '../../app/utils/brand-color'

const QUINT = '#771aaf'
const MATRIX: ReadonlyArray<[label: string, color: string]> = [
  ['light #ffd400', '#ffd400'],
  ['dark #771aaf', '#771aaf'],
  ['mid-tone #2f6fed', '#2f6fed'],
  ['none (Quint fallback)', QUINT],
  // Not in the screenshot matrix, kept as hard edges for the arithmetic.
  ['pure white #ffffff', '#ffffff'],
  ['pure black #000000', '#000000'],
  ['mid grey #777777', '#777777'],
]

const WHITE = '#ffffff'
/** `--card` is oklch(1 0 0), i.e. white: the elevated surface. */
const CARD = WHITE

describe.each(MATRIX)('brand canvas contrast — %s', (_label, primary) => {
  const tokens = deriveOnPrimaryTokens(primary)

  it('on-primary text on the canvas clears 4.5:1', () => {
    expect(contrastRatio(tokens['--color-on-primary'], primary)).toBeGreaterThanOrEqual(4.5)
  })

  it('on-primary-muted text on the canvas clears 4.5:1', () => {
    expect(contrastRatio(tokens['--color-on-primary-muted'], primary)).toBeGreaterThanOrEqual(4.5)
  })

  it('the decorative tone layer can only raise on-primary contrast, at any opacity', () => {
    const base = contrastRatio(tokens['--color-on-primary'], primary)

    for (const alpha of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
      // `mix(a, b, r)` keeps `r` of `a`: a tone layer at `alpha` over the canvas.
      const blended = mix(primary, tokens['--color-canvas-tone'], 1 - alpha)

      expect(
        contrastRatio(tokens['--color-on-primary'], blended),
        `alpha ${alpha}`
      ).toBeGreaterThanOrEqual(base - 0.01)
    }
  })

  it('primary-ink clears 4.5:1 on the white surface', () => {
    expect(contrastRatio(tokens['--color-primary-ink'], CARD)).toBeGreaterThanOrEqual(4.5)
  })

  it('on-primary-surface clears 4.5:1 on primary-surface', () => {
    expect(
      contrastRatio(tokens['--color-on-primary-surface'], tokens['--color-primary-surface'])
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('on-primary on a solid primary fill inside the surface (button, chip) clears 4.5:1', () => {
    // Same pair as the canvas, restated because it is a different consumer:
    // `--primary-foreground` resolves to `--color-on-primary` (main.css).
    expect(contrastRatio(tokens['--color-on-primary'], primary)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('brand canvas — derived ink and tone', () => {
  it('keeps the primary itself as ink when it already reads on white', () => {
    expect(deriveOnPrimaryTokens(QUINT)['--color-primary-ink']).toBe(QUINT)
  })

  it('darkens a light primary into an ink that reads on white', () => {
    const ink = deriveOnPrimaryTokens('#ffd400')['--color-primary-ink']

    expect(ink).not.toBe('#ffd400')
    expect(contrastRatio(ink, WHITE)).toBeGreaterThanOrEqual(4.5)
  })

  it('deepens a canvas that carries white text and lifts one that carries black text', () => {
    // Quint: white on-primary, so the tone is a deeper purple.
    expect(deriveOnPrimaryTokens(QUINT)['--color-canvas-tone']).toBe(mix(QUINT, '#000000', 0.55))
    // Yellow: black on-primary, so the tone is a lighter yellow.
    expect(deriveOnPrimaryTokens('#ffd400')['--color-canvas-tone']).toBe(
      mix('#ffd400', '#ffffff', 0.3)
    )
  })

  it('records the mid-tone call DESIGN.md §7.0.1 makes: black wins on #2f6fed', () => {
    expect(deriveOnPrimaryTokens('#2f6fed')['--color-on-primary']).toBe('#000000')
  })
})
