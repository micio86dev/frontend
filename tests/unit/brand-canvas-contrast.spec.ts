/**
 * The brand canvas contrast guarantees (DESIGN.md §7.0.1, §9.1).
 *
 * The canvas colour is chosen by an operator, so no pair drawn on it can be
 * pre-verified in DESIGN.md's table. This spec is that table, computed: for
 * every colour of the screenshot matrix it asserts each text/background pair
 * the candidate canvas introduces, using the same `contrastRatio` the runtime
 * derivation uses. "None" is the Quint fallback, i.e. the stylesheet defaults,
 * which `token-parity.spec.ts` pins to the derivation for `#771aaf` (primary)
 * and `#0f172a` (the dark default canvas).
 */
import { describe, it, expect } from 'vitest'
import { deriveCanvasTokens, deriveOnPrimaryTokens } from '../../app/composables/useBrandTheme'
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

/** Backgrounds of the screenshot matrix: Light, Dark (the default), and edges. */
const BACKGROUNDS: ReadonlyArray<[label: string, color: string]> = [
  ['dark default #0f172a', '#0f172a'],
  ['light #f1f5f9', '#f1f5f9'],
  ['navy #1e3a5f', '#1e3a5f'],
  ['yellow #ffd400', '#ffd400'],
  ['pure white #ffffff', '#ffffff'],
  ['pure black #000000', '#000000'],
  ['mid grey #777777', '#777777'],
]

const WHITE = '#ffffff'
/** `--card` is oklch(1 0 0), i.e. white: the elevated surface. */
const CARD = WHITE

describe.each(MATRIX)('brand primary contrast — %s', (_label, primary) => {
  const tokens = deriveOnPrimaryTokens(primary)

  it('on-primary text on a primary fill (button, chip) clears 4.5:1', () => {
    expect(contrastRatio(tokens['--color-on-primary'], primary)).toBeGreaterThanOrEqual(4.5)
  })

  it('on-primary-muted text on a primary fill clears 4.5:1', () => {
    expect(contrastRatio(tokens['--color-on-primary-muted'], primary)).toBeGreaterThanOrEqual(4.5)
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

/** `--secondary` is oklch(0.97 0 0): the progress track. */
const TRACK = '#f5f5f5'
/** `--color-recording`: the timer's last ten seconds, on the white status pill. */
const RECORDING = '#dc2626'

describe.each(MATRIX)('interview chrome contrast — %s', (_label, primary) => {
  const tokens = deriveOnPrimaryTokens(primary)

  it('the primary-ink edge sets a brand fill off the white surface at >= 3:1', () => {
    // Buttons, the info chip and the guide numerals (WCAG 1.4.11).
    expect(contrastRatio(tokens['--color-primary-ink'], CARD)).toBeGreaterThanOrEqual(3)
  })

  it('the progress fill (primary-ink) clears 3:1 on its track', () => {
    expect(contrastRatio(tokens['--color-primary-ink'], TRACK)).toBeGreaterThanOrEqual(3)
  })

  it('the current step numeral (on-primary on the primary disc) clears 4.5:1', () => {
    expect(contrastRatio(tokens['--color-on-primary'], primary)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('interview chrome — constant pairs', () => {
  it('the urgent timer red clears 4.5:1 on the white status pill', () => {
    expect(contrastRatio(RECORDING, CARD)).toBeGreaterThanOrEqual(4.5)
  })
})

describe.each(BACKGROUNDS)('brand canvas contrast — background %s', (_label, background) => {
  const tokens = deriveCanvasTokens(background)

  it('on-canvas text clears 4.5:1', () => {
    expect(contrastRatio(tokens['--color-on-canvas'], background)).toBeGreaterThanOrEqual(4.5)
  })

  it('on-canvas-muted text clears 4.5:1', () => {
    expect(contrastRatio(tokens['--color-on-canvas-muted'], background)).toBeGreaterThanOrEqual(4.5)
  })

  it('the decorative tone layer can only raise on-canvas contrast, at any opacity', () => {
    const base = contrastRatio(tokens['--color-on-canvas'], background)

    for (const alpha of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
      // `mix(a, b, r)` keeps `r` of `a`: a tone layer at `alpha` over the canvas.
      const blended = mix(background, tokens['--color-canvas-tone'], 1 - alpha)

      expect(
        contrastRatio(tokens['--color-on-canvas'], blended),
        `alpha ${alpha}`
      ).toBeGreaterThanOrEqual(base - 0.01)
    }
  })
})

describe('brand canvas — the primary accent against the canvas (DESIGN.md §3.1 rule 3)', () => {
  // A primary fill drawn directly on the canvas is either >= 3:1 against it or
  // carries an on-canvas edge that is itself >= 3:1.
  it.each(MATRIX.flatMap(([pl, p]) => BACKGROUNDS.map(([bl, b]) => [pl, bl, p, b] as const)))(
    'primary %s on background %s: legible by fill or by edge',
    (_pl, _bl, primary, background) => {
      const onCanvas = deriveCanvasTokens(background)['--color-on-canvas']
      const fillReads = contrastRatio(primary, background) >= 3

      expect(fillReads || contrastRatio(onCanvas, background) >= 3).toBe(true)
    }
  )
})

describe('brand canvas — derived canvas tokens', () => {
  it('keeps the background verbatim as the canvas', () => {
    expect(deriveCanvasTokens('#f1f5f9')['--color-canvas']).toBe('#f1f5f9')
  })

  it('flips the text to black on a light background and keeps it white on the dark default', () => {
    expect(deriveCanvasTokens('#f1f5f9')['--color-on-canvas']).toBe('#000000')
    expect(deriveCanvasTokens('#0f172a')['--color-on-canvas']).toBe('#ffffff')
  })

  it('deepens a canvas that carries white text and lifts one that carries black text', () => {
    expect(deriveCanvasTokens('#0f172a')['--color-canvas-tone']).toBe(
      mix('#0f172a', '#000000', 0.55)
    )
    expect(deriveCanvasTokens('#f1f5f9')['--color-canvas-tone']).toBe(
      mix('#f1f5f9', '#ffffff', 0.3)
    )
  })
})

describe('brand primary — derived ink', () => {
  it('keeps the primary itself as ink when it already reads on white', () => {
    expect(deriveOnPrimaryTokens(QUINT)['--color-primary-ink']).toBe(QUINT)
  })

  it('darkens a light primary into an ink that reads on white', () => {
    const ink = deriveOnPrimaryTokens('#ffd400')['--color-primary-ink']

    expect(ink).not.toBe('#ffd400')
    expect(contrastRatio(ink, WHITE)).toBeGreaterThanOrEqual(4.5)
  })

  it('records the mid-tone call DESIGN.md §7.0.1 makes: black wins on #2f6fed', () => {
    expect(deriveOnPrimaryTokens('#2f6fed')['--color-on-primary']).toBe('#000000')
  })
})
