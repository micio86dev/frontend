/**
 * Every brand hex restated outside `main.css` must equal the literal it stands
 * in for.
 *
 * NOT THE PROHIBITED "GREP THE STYLESHEET FOR A HEX" TOKEN TEST. That rule
 * exists because grepping proves nothing about whether a token is APPLIED —
 * the hex was present the whole time in the known-broken version, and only a
 * computed style can settle application. Three other suites do exactly that
 * (`brand-theme.spec.ts` reads back what `applyBrandColor` wrote, and
 * `voice-visualizer.spec.ts` asserts the canvas repaints).
 *
 * This asserts something a computed style CANNOT: that two pieces of SOURCE
 * agree. Both restatements below are only ever read when the stylesheet is
 * unavailable or not yet consulted, so at runtime the comparison would pass
 * trivially by never exercising them.
 *
 * Two restatements exist, each sanctioned and each for a stated reason:
 *
 *   1. `VoiceVisualizer.readBrandColors()` — DESIGN.md §7.3 permits a named
 *      fallback per token IN THE CANVAS ONLY. An unresolved token in CSS just
 *      inherits; in a canvas it means `addColorStop('')` and a `SyntaxError`
 *      inside the paint loop, which blanks the panel. A wrong-but-visible
 *      ribbon beats an absent one — but a SILENTLY wrong one does not, which
 *      is what this test rules out.
 *   2. `useBrandTheme.AVATAR_PANEL` — the contrast guarantee (§7.3.2 rule 2)
 *      runs BEFORE anything is written to the document, so there is no
 *      computed style to read the panel colour from yet.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// `__dirname` + `resolve`, matching `same-origin-api.spec.ts` beside it:
// `import.meta.url` comes back undefined under this suite's transform, which
// resolves to the literal string "undefined" and reads a file that is not there.
function sourceOf(relativePath: string): string {
  return readFileSync(resolve(__dirname, '../../..', relativePath), 'utf8')
}

/** The `@theme` literal for one token, as authored in the stylesheet. */
function themeLiteral(css: string, token: string): string | null {
  return (
    new RegExp(`^\\s*${token}:\\s*(#[0-9a-fA-F]{6});`, 'm').exec(css)?.[1]?.toLowerCase() ?? null
  )
}

const CSS = sourceOf('app/assets/css/main.css')

describe('brand hexes restated outside the stylesheet', () => {
  const visualizer = sourceOf('app/components/VoiceVisualizer.client.vue')
  const brandTheme = sourceOf('app/composables/useBrandTheme.ts')

  /** The fallback argument the canvas passes to `read(token, fallback)`. */
  function canvasFallback(token: string): string | null {
    return (
      new RegExp(`read\\(\\s*'${token}'\\s*,\\s*'(#[0-9a-fA-F]{6})'\\s*\\)`)
        .exec(visualizer)?.[1]
        ?.toLowerCase() ?? null
    )
  }

  // `--color-avatar-bg` is in this list because the review gate proved its
  // absence: changing it in `main.css` AND in `AVATAR_PANEL` together, leaving
  // the canvas fallback behind, kept 35 assertions green. `withAlpha()` would
  // then composite the resting hairline against a panel colour the page no
  // longer uses, the measured 3.64:1 would quietly stop being true, and the
  // only mark visible in silence would go wrong with no error anywhere.
  it.each(['--color-lavender', '--color-primary-light', '--color-avatar-bg'])(
    'the canvas fallback for %s matches the stylesheet',
    (token) => {
      const authored = themeLiteral(CSS, token)
      const fallback = canvasFallback(token)

      // Both halves asserted present FIRST. A regex that silently matched
      // nothing would make this pass by comparing null to null — a guard that
      // can never fail, which is the shape the rules single out.
      expect(authored, `${token} not found in main.css @theme`).not.toBeNull()
      expect(fallback, `${token} fallback not found in VoiceVisualizer`).not.toBeNull()

      expect(fallback).toBe(authored)
    }
  )

  it('AVATAR_PANEL matches --color-avatar-bg', () => {
    // The colour every canvas contrast ratio is measured against. If this
    // drifts, `ensureContrast` keeps clearing a threshold against a panel that
    // is no longer there, and the guarantee silently stops guaranteeing.
    const authored = themeLiteral(CSS, '--color-avatar-bg')
    const restated = /const AVATAR_PANEL = '(#[0-9a-fA-F]{6})'/.exec(brandTheme)?.[1]?.toLowerCase()

    expect(authored, '--color-avatar-bg not found in main.css @theme').not.toBeNull()
    expect(restated, 'AVATAR_PANEL not found in useBrandTheme').not.toBeUndefined()

    expect(restated).toBe(authored)
  })
})
