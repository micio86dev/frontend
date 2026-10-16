/**
 * `applyBrandColor` on the CANDIDATE side.
 *
 * THE BUG THIS FILE EXISTS FOR: it painted `--color-primary` and stopped there,
 * while `main.css` declares THREE brand tokens — `--color-primary`,
 * `--color-primary-light` and `--color-primary-dark`. The two it skipped are
 * not decoration on this app, they are the largest brand surface a candidate
 * ever looks at:
 *
 *   - `VoiceVisualizer.client.vue (readBrandColors)` reads `--color-primary-light` for the
 *     gradient of the animated blob that fills the middle of the interview
 *     screen for its entire duration.
 *   - `NoticeShell.vue` paints its blurred corner glow with
 *     `bg-primary-light/30`, on every notice screen the candidate sees.
 *
 * So an organization that configured orange got an orange button and a purple
 * interview, and read the whole feature as broken — correctly, from where they
 * were standing.
 *
 * Mirrors `backoffice/tests/unit/composables/use-brand-theme.spec.ts`, whose
 * app hit the same defect one token at a time.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  applyBrandCanvas,
  applyBrandColor,
  BRAND_CANVAS_TOKENS,
  BRAND_COLOR_TOKENS,
  BRAND_DERIVED_TOKENS,
  BRAND_EDGE_TOKEN,
  BRAND_ON_PRIMARY_TOKENS,
  deriveCanvasTokens,
  brandColorRevision,
  deriveOnPrimaryTokens,
} from '../../app/composables/useBrandTheme'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { contrastRatio, ensureContrast, readableForeground } from '../../app/utils/brand-color'

function read(token: string): string {
  return document.documentElement.style.getPropertyValue(token)
}

afterEach(() => {
  // Through the writers, so their module state (the edge guard reads both
  // colours) is reset along with the properties.
  applyBrandColor(null)
  applyBrandCanvas(null)
  for (const token of [
    ...BRAND_COLOR_TOKENS,
    ...BRAND_DERIVED_TOKENS,
    ...BRAND_ON_PRIMARY_TOKENS,
    ...BRAND_CANVAS_TOKENS,
    BRAND_EDGE_TOKEN,
  ]) {
    document.documentElement.style.removeProperty(token)
  }
})

describe('applyBrandColor', () => {
  it('paints the token the Tailwind utilities actually read', () => {
    applyBrandColor('#e45526')

    expect(read('--color-primary')).toBe('#e45526')
  })

  it('paints every derived token, so no brand surface is left behind', () => {
    // The assertion is over the EXPORTED list rather than a literal, so a
    // token added to the writer cannot be left untested — the same seam the
    // backoffice's copy uses.
    applyBrandColor('#e45526')

    for (const token of BRAND_DERIVED_TOKENS) {
      expect(read(token), `${token} was not written`).not.toBe('')
    }

    expect(BRAND_DERIVED_TOKENS).toContain('--color-primary-light')
    expect(BRAND_DERIVED_TOKENS).toContain('--color-lavender')
  })

  it('writes CONCRETE colours, never a color-mix() expression', () => {
    // THE DEFECT THAT MADE THIS ARITHMETIC NECESSARY. The first version stored
    // `color-mix(in oklab, …)` and let the browser resolve it. CSS coped; the
    // canvas did not. An unregistered custom property's computed value is its
    // specified TEXT, so `getComputedStyle` handed that expression straight to
    // `addColorStop()`, which throws `SyntaxError` on what it cannot parse —
    // inside `requestAnimationFrame`, every frame, for the whole interview.
    // A blank panel is the one outcome the visualizer exists to prevent.
    applyBrandColor('#e45526')

    for (const token of BRAND_DERIVED_TOKENS) {
      expect(read(token)).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('brands the lavender too, because it is the mark that shows in silence', () => {
    // `--color-lavender` paints the ribbon's centre stop AND its resting
    // baseline. Branding the edges and leaving this one meant an orange
    // organization saw orange only mid-syllable, and Quint purple every time
    // the candidate stopped talking.
    applyBrandColor('#e45526')

    expect(read('--color-lavender')).not.toBe('')
    expect(read('--color-lavender')).not.toBe('#8373d2')
  })

  it('clears the derived tokens too, so a cleared brand leaves nothing behind', () => {
    // The half that regressed first elsewhere: clearing only what the LAST
    // version wrote leaves a stale override from the one before it, and the
    // product palette never comes back.
    applyBrandColor('#e45526')
    applyBrandColor(null)

    for (const token of [...BRAND_COLOR_TOKENS, ...BRAND_DERIVED_TOKENS]) {
      expect(read(token)).toBe('')
    }
  })

  it('refuses a value that is not a plain six-digit hex', () => {
    // This writes into a stylesheet. The API validates with an anchored regex
    // AND a database CHECK, and it is re-checked here anyway: a writer that
    // trusts its input because something upstream promised to check is how an
    // injection survives a refactor.
    applyBrandColor('red; } body { display: none } .x {')

    for (const token of [...BRAND_COLOR_TOKENS, ...BRAND_DERIVED_TOKENS]) {
      expect(read(token)).toBe('')
    }
  })

  it('refuses a malformed value BEFORE the arithmetic, not only the plain token', () => {
    // Worth its own case because the derived path no longer merely quotes the
    // value — it SLICES it. `brand-color` takes fixed offsets and `parseInt`s
    // them, so a string of another shape does not throw: it yields `NaN`
    // channels and a colour nobody chose. The regex is what stops that, and it
    // has to run before the maths, not beside it.
    applyBrandColor('#ff0000; }')

    for (const token of BRAND_DERIVED_TOKENS) {
      expect(read(token)).toBe('')
    }
  })
})

describe('the caption prefix colour (live-interview-call-chrome, D8)', () => {
  // The speaker prefix of the captions overlay is normal-size text on the opaque
  // `--color-avatar-bg` backing, so it needs 4.5:1, not the 3:1 graphical-object
  // floor `--color-primary-light` is held to. A separate token, so the ribbon edge
  // is never raised for a requirement only the caption has.
  const PANEL = '#0f172a'
  const TOKEN = '--color-primary-caption'
  const CSS = readFileSync(resolve(__dirname, '../../app/assets/css/main.css'), 'utf-8')
  const authored = (token: string) =>
    new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`).exec(CSS)?.[1]?.toLowerCase()

  it('is one of the derived tokens, so it is painted and cleared with the others', () => {
    expect(BRAND_DERIVED_TOKENS).toContain(TOKEN)
  })

  it.each(['#12203a', '#000000', '#771aaf', '#e45526', '#ffd400', '#ffffff', '#ffff00'])(
    'reads at 4.5:1 or better on the avatar panel for the brand colour %s',
    (colour) => {
      applyBrandColor(colour)

      expect(contrastRatio(read(TOKEN), PANEL)).toBeGreaterThanOrEqual(4.5)
    }
  )

  it('keeps the brand hue and is lifted only as far as 4.5:1 needs (#771aaf gives #ae77cf)', () => {
    applyBrandColor('#771aaf')

    expect(read(TOKEN)).toBe('#ae77cf')
    expect(contrastRatio(read(TOKEN), PANEL)).toBeGreaterThanOrEqual(4.5)
  })

  it('differs from the ribbon edge, which keeps its own 3:1 derivation', () => {
    applyBrandColor('#12203a')

    expect(read(TOKEN)).not.toBe(read('--color-primary-light'))
    expect(contrastRatio(read('--color-primary-light'), PANEL)).toBeGreaterThanOrEqual(3)
  })

  it('leaves --color-primary-light at its measured values', () => {
    applyBrandColor('#e45526')
    expect(read('--color-primary-light')).toBe('#ec8867')

    expect(authored('--color-primary-light')).toBe('#c222d3')
  })

  it('has a Quint default in main.css equal to the product light shade lifted to 4.5:1', () => {
    const lifted = ensureContrast('#c222d3', PANEL, 4.5)

    expect(authored(TOKEN)).toBe(lifted)
    // Pinned with its ratio: 4.55:1.
    expect(authored(TOKEN)).toBe('#cb43da')
    expect(contrastRatio(authored(TOKEN)!, PANEL)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(authored(TOKEN)!, PANEL)).toBeLessThan(4.6)
  })
})

describe('brandColorRevision', () => {
  it('bumps on every write, so a cached reader knows to re-read', () => {
    // `VoiceVisualizer` caches the resolved tokens once and drops the cache
    // ONLY on resize — its comment called a resize "the one moment a restyle
    // could have landed". That stopped being true the moment branding became
    // async: the colour arrives after `/candidate/session` resolves, with no
    // resize anywhere near it, so the canvas kept the Quint purple for the
    // entire interview while every other surface had turned.
    const before = brandColorRevision.value

    applyBrandColor('#e45526')

    expect(brandColorRevision.value).toBe(before + 1)
  })

  it('bumps on clear too — reverting to the product palette is also a restyle', () => {
    applyBrandColor('#e45526')
    const afterApply = brandColorRevision.value

    applyBrandColor(null)

    expect(brandColorRevision.value).toBe(afterApply + 1)
  })

  it('bumps on a REFUSED value, because refusing clears the tokens', () => {
    // A rejected payload takes the clear path, so the stylesheet changed and a
    // cached reader is stale. Not bumping here would leave the canvas showing
    // a colour the page no longer has.
    applyBrandColor('#e45526')
    const afterApply = brandColorRevision.value

    applyBrandColor('not-a-hex')

    expect(brandColorRevision.value).toBe(afterApply + 1)
  })
})

describe('the canvas contrast guarantee (DESIGN.md §7.3.2 rule 2)', () => {
  // The ratios recorded in DESIGN.md §7.3's table are measured against the
  // PRODUCT's palette. An operator picks an arbitrary colour, and a dark one
  // puts the ribbon under §9.1's binding 3:1 against the interview panel — a
  // waveform a candidate cannot see, on the surface whose entire purpose is
  // that silence and breakage never look the same.
  //
  // Delegating this to the operator is not defensible: the product cannot ask
  // someone choosing a brand colour to also verify a waveform against a panel
  // they have never seen. So the canvas defends itself.
  const PANEL = '#0f172a'

  it('lifts a dark tenant colour to a legible ribbon edge', () => {
    // Near-black navy: mixed 70% toward white it is still far under 3:1.
    applyBrandColor('#12203a')

    expect(contrastRatio(read('--color-primary-light'), PANEL)).toBeGreaterThanOrEqual(3)
  })

  it('holds the resting baseline to the stricter 4.5:1', () => {
    // The hairline is the ONLY thing on screen in silence, and it is one pixel
    // tall. It gets the ratio the product's own `#8373d2` measures, not the
    // graphical-object floor.
    applyBrandColor('#12203a')

    expect(contrastRatio(read('--color-lavender'), PANEL)).toBeGreaterThanOrEqual(4.5)
  })

  it('leaves a colour that already clears the floor alone', () => {
    // The guarantee is a floor, not a filter. A bright tenant colour must come
    // out as ITSELF lightened, not dragged toward white by a rule that fires
    // when it has nothing to fix.
    applyBrandColor('#e45526')

    expect(read('--color-primary-light')).toBe('#ec8867')
  })

  it('DOES brand --color-primary-dark now: main.css aliases --color-accent-dark to it', () => {
    // Reversed. This used to say "nothing reads it" — true when written, false
    // since `--color-accent-dark: var(--color-primary-dark)` (main.css) made it
    // the highlighted-row background for every Select/DropdownMenu row
    // (DESIGN.md §16 rule 10). Leaving it unbranded would have repeated
    // exactly the half-applied-brand bug this file's own header condemns, one
    // token further out: a tenant's active/pressed and highlighted-row states
    // would keep snapping back to Quint purple.
    applyBrandColor('#12203a')

    expect(BRAND_DERIVED_TOKENS).toContain('--color-primary-dark')
    expect(read('--color-primary-dark')).toBe('#0f1b31')
  })

  it('darkens toward black, which only ever RAISES contrast against white text — no ensureContrast loop needed here', () => {
    // Unlike --color-primary-light (which lightens and could undershoot a
    // dark-background floor, hence its own contrast-repair loop above),
    // mixing toward black moves away from white monotonically: white's
    // luminance is fixed, so the other side can only fall. #431695, the
    // product's own value at this same 85%-toward-black ratio, already clears
    // the DESIGN.md ≥4.5:1 white-text floor at 11.75:1.
    applyBrandColor('#e45526')

    expect(contrastRatio('#ffffff', read('--color-primary-dark'))).toBeGreaterThanOrEqual(4.5)
  })
})

describe('on-primary tokens (the text colour for anything drawn on the tenant canvas)', () => {
  it('lists exactly the five on-primary tokens (the canvas tone is derived from the background now)', () => {
    expect([...BRAND_ON_PRIMARY_TOKENS].sort()).toEqual([
      '--color-on-primary',
      '--color-on-primary-muted',
      '--color-on-primary-surface',
      '--color-primary-ink',
      '--color-primary-surface',
    ])
  })

  it('picks black on a saturated yellow and white on the Quint purple', () => {
    applyBrandColor('#ffd400')
    expect(read('--color-on-primary')).toBe('#000000')

    applyBrandColor('#771aaf')
    expect(read('--color-on-primary')).toBe('#ffffff')
  })

  it('writes concrete hex for every on-primary token, never color-mix()', () => {
    applyBrandColor('#e45526')

    for (const token of BRAND_ON_PRIMARY_TOKENS) {
      expect(read(token), token).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('tints the surface very light and keeps the muted text off pure on-primary when it can', () => {
    applyBrandColor('#771aaf')

    expect(read('--color-primary-surface')).toBe('#f4edf9')
    expect(read('--color-on-primary-muted')).not.toBe('#ffffff')
  })

  const SAMPLES = [
    '#ffffff',
    '#000000',
    '#ffd400',
    '#fff8e1',
    '#12203a',
    '#771aaf',
    '#e45526',
    '#2563eb',
    '#808080',
    '#00b894',
    '#7f7f00',
    '#d81b60',
  ]

  it.each(SAMPLES)('every on-primary pair meets 4.5:1 for %s', (color) => {
    applyBrandColor(color)

    const primary = read('--color-primary')
    const surface = read('--color-primary-surface')

    expect(contrastRatio(primary, read('--color-on-primary'))).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(primary, read('--color-on-primary-muted'))).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(surface, read('--color-on-primary-surface'))).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps the pressed shade readable for a light colour via readableForeground, not a constant white', () => {
    // A 15% darkening of yellow is still light: white text on it fails AA.
    applyBrandColor('#ffff00')

    const dark = read('--color-primary-dark')

    expect(contrastRatio(dark, '#ffffff')).toBeLessThan(4.5)
    expect(contrastRatio(dark, readableForeground(dark))).toBeGreaterThanOrEqual(4.5)
  })

  it('removes every on-primary token on the no-colour path', () => {
    applyBrandColor('#e45526')
    applyBrandColor(null)

    for (const token of BRAND_ON_PRIMARY_TOKENS) {
      expect(read(token), token).toBe('')
    }
  })

  it('removes them on a refused value as well', () => {
    applyBrandColor('#e45526')
    applyBrandColor('not-a-hex')

    for (const token of BRAND_ON_PRIMARY_TOKENS) {
      expect(read(token), token).toBe('')
    }
  })
})

describe('on-primary margin at the worst-case tenant colour', () => {
  const FLOOR = 4.5
  const hex = (n: number): string => n.toString(16).padStart(2, '0')
  const onPrimaryRatio = (color: string): number =>
    contrastRatio(deriveOnPrimaryTokens(color)['--color-on-primary'], color)

  it('keeps >= 4.5:1 on every one of the 256 grey levels', () => {
    // max(contrast vs white, contrast vs black) is smallest for mid greys
    // (relative luminance ~0.18), and that is the one place the guarantee has
    // almost no slack: it is exactly what a sweep, not a few picked colours, covers.
    for (let level = 0; level <= 255; level++) {
      const grey = `#${hex(level)}${hex(level)}${hex(level)}`

      expect(onPrimaryRatio(grey), grey).toBeGreaterThanOrEqual(FLOOR)
    }
  })

  it('keeps >= 4.5:1 across a coarse RGB cube (17 steps per channel)', () => {
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 17) {
        for (let b = 0; b <= 255; b += 17) {
          const color = `#${hex(r)}${hex(g)}${hex(b)}`

          expect(onPrimaryRatio(color), color).toBeGreaterThanOrEqual(FLOOR)
        }
      }
    }
  })

  it('names the worst case: the grey #757575 has the least headroom, just over the floor', () => {
    // The sweep finds the grey with the least headroom; pinning it by name makes
    // a regression in the margin a one-line, readable failure.
    const worst = Array.from({ length: 256 }, (_, level) => {
      const grey = `#${hex(level)}${hex(level)}${hex(level)}`

      return { grey, ratio: onPrimaryRatio(grey) }
    }).reduce((least, next) => (next.ratio < least.ratio ? next : least))

    expect(worst.grey).toBe('#757575')
    expect(worst.ratio).toBeGreaterThanOrEqual(FLOOR)
    expect(worst.ratio).toBeLessThan(4.7)
  })
})

describe('the speaking ring follows the primary, guarded at 3:1 on the avatar panel', () => {
  const PANEL = '#0f172a'

  it('is one of the derived tokens, so it is painted and cleared with the primary', () => {
    expect(BRAND_DERIVED_TOKENS).toContain('--color-speaking-ring')
  })

  it('lifts the Quint primary (2.1:1 on the panel) to ensureContrast(primary, panel, 3)', () => {
    applyBrandColor('#771aaf')

    expect(read('--color-speaking-ring')).toBe(ensureContrast('#771aaf', PANEL, 3))
    expect(read('--color-speaking-ring')).not.toBe('#771aaf')
  })

  it('keeps a primary that already reaches 3:1 verbatim (yellow)', () => {
    applyBrandColor('#ffd400')

    expect(read('--color-speaking-ring')).toBe('#ffd400')
  })

  it.each(['#000000', '#12203a', '#771aaf', '#e45526', '#ffd400', '#ffffff'])(
    'clears 3:1 against the avatar panel for %s',
    (colour) => {
      applyBrandColor(colour)

      expect(contrastRatio(read('--color-speaking-ring'), PANEL)).toBeGreaterThanOrEqual(3)
    }
  )
})

describe('applyBrandCanvas', () => {
  it('writes every canvas token as concrete hex', () => {
    applyBrandCanvas('#f1f5f9')

    expect(read('--color-canvas')).toBe('#f1f5f9')
    for (const token of BRAND_CANVAS_TOKENS) {
      expect(read(token), token).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('flips on-canvas to dark text on a light background, at >= 4.5:1', () => {
    applyBrandCanvas('#f1f5f9')

    expect(read('--color-on-canvas')).toBe('#000000')
    expect(contrastRatio(read('--color-on-canvas'), '#f1f5f9')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(read('--color-on-canvas-muted'), '#f1f5f9')).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps white text on the dark default background', () => {
    applyBrandCanvas('#0f172a')

    expect(read('--color-on-canvas')).toBe('#ffffff')
  })

  it('derives the same tokens deriveCanvasTokens returns', () => {
    applyBrandCanvas('#1e3a5f')

    for (const [token, value] of Object.entries(deriveCanvasTokens('#1e3a5f'))) {
      expect(read(token)).toBe(value)
    }
  })

  it('removes every canvas token on null, so the stylesheet default (dark) returns', () => {
    applyBrandCanvas('#f1f5f9')
    applyBrandCanvas(null)

    for (const token of BRAND_CANVAS_TOKENS) {
      expect(read(token), token).toBe('')
    }
  })

  it.each(['red; } body { display: none } .x {', '#fff', 'f1f5f9', '#f1f5f9;'])(
    'ignores the invalid value %j and clears what was there',
    (bad) => {
      applyBrandCanvas('#f1f5f9')
      applyBrandCanvas(bad)

      for (const token of BRAND_CANVAS_TOKENS) {
        expect(read(token), token).toBe('')
      }
    }
  )

  it('does not touch the primary tokens', () => {
    applyBrandColor('#771aaf')
    applyBrandCanvas('#f1f5f9')
    applyBrandCanvas(null)

    expect(read('--color-primary')).toBe('#771aaf')
  })

  it('bumps the revision so cached canvas readers repaint', () => {
    const before = brandColorRevision.value
    applyBrandCanvas('#f1f5f9')

    expect(brandColorRevision.value).toBeGreaterThan(before)
  })
})

describe('the primary edge on the canvas (DESIGN.md §3.1 rule 3)', () => {
  it('is the on-canvas colour when the primary is under 3:1 against the canvas', () => {
    // Quint on the dark default is 2.1:1: the disc needs a visible edge.
    applyBrandColor('#771aaf')
    applyBrandCanvas('#0f172a')

    expect(read(BRAND_EDGE_TOKEN)).toBe('#ffffff')
  })

  it('is the primary itself (no visible border) when it reaches 3:1', () => {
    applyBrandColor('#ffd400')
    applyBrandCanvas('#0f172a')

    expect(read(BRAND_EDGE_TOKEN)).toBe('#ffd400')
  })

  it('guards a yellow primary on a light background with a dark edge', () => {
    applyBrandColor('#ffd400')
    applyBrandCanvas('#f1f5f9')

    expect(read(BRAND_EDGE_TOKEN)).toBe('#000000')
  })

  it('is measured against the default canvas when only the primary is set', () => {
    applyBrandColor('#771aaf')

    expect(read(BRAND_EDGE_TOKEN)).toBe('#ffffff')
  })

  it('is removed once both colours are cleared', () => {
    applyBrandColor('#ffd400')
    applyBrandCanvas('#f1f5f9')
    applyBrandColor(null)
    applyBrandCanvas(null)

    expect(read(BRAND_EDGE_TOKEN)).toBe('')
  })
})
