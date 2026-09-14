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
  applyBrandColor,
  BRAND_COLOR_TOKENS,
  BRAND_DERIVED_TOKENS,
  brandColorRevision,
} from '../../app/composables/useBrandTheme'
import { contrastRatio } from '../../app/utils/brand-color'

function read(token: string): string {
  return document.documentElement.style.getPropertyValue(token)
}

afterEach(() => {
  for (const token of [...BRAND_COLOR_TOKENS, ...BRAND_DERIVED_TOKENS]) {
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

  it('does not brand --color-primary-dark at all, because nothing reads it', () => {
    // Grepped and confirmed: the token appears in its `@theme` declaration and
    // nowhere else in the app. Painting it would be the "ceremony that looks
    // like coverage" this composable's own header condemns — and it would come
    // with a passing test, which is exactly why nobody would notice.
    applyBrandColor('#12203a')

    expect(BRAND_DERIVED_TOKENS).not.toContain('--color-primary-dark')
    expect(read('--color-primary-dark')).toBe('')
  })
})
