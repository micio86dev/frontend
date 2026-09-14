/**
 * Paint the organization's primary colour over the product's.
 *
 * WHICH TOKENS, AND WHY THESE
 * ---------------------------
 * This wrote `--primary`, and nothing read it. The app is Tailwind v4:
 * `main.css` declares `@theme { --color-primary: #771aaf }` as a LITERAL, and
 * `bg-primary` / `text-primary` compile to `var(--color-primary)`.
 * `--color-primary` is deliberately NOT bridged to `var(--primary)` — that
 * would shadow the literal and regress `bg-primary` to shadcn's grey. So the
 * two never met and every candidate saw the Quint purple whatever their
 * organization had configured.
 *
 * Then it wrote `--color-primary` and stopped, which fixed the buttons and
 * left the interview purple. `main.css` declares THREE brand tokens, and on
 * THIS app the other two are the largest brand surface a candidate ever looks
 * at — not hover states, as they are in the backoffice:
 *
 *   - `VoiceVisualizer.client.vue (readBrandColors)` reads `--color-primary-light` for the
 *     gradient of the animated blob that fills the middle of the interview
 *     screen for its whole duration.
 *   - `NoticeShell.vue` paints its blurred corner glow with
 *     `bg-primary-light/30`, on every notice screen.
 *
 * An organization that configured orange therefore got an orange button and a
 * purple interview, and read the feature as broken. It was: painting one third
 * of a three-token palette is a half-applied brand, and half-applied reads as
 * not applied.
 *
 * SETS NOTHING WHEN THE ORGANIZATION HAS NO COLOUR, and that is the important
 * half. An unset custom property falls through to the stylesheet's own value,
 * which is the Quint palette DESIGN.md defines. Writing a "default" here would
 * duplicate that constant in a second place, and the two would drift.
 */

import { ref } from 'vue'
import { ensureContrast, mix } from '~/app/utils/brand-color'

/** The same shape the API enforces. Duplicated deliberately — see below. */
const HEX = /^#[0-9a-f]{6}$/i

/**
 * Bumped every time the tokens change — applied, cleared, or refused.
 *
 * A SIGNAL FOR READERS THAT CANNOT RE-READ ON THEIR OWN. CSS custom properties
 * cascade for free, so every DOM surface follows a write with no notification
 * needed. A CANVAS does not: `VoiceVisualizer` resolves these tokens once into
 * JavaScript strings and caches them, dropping the cache only on resize —
 * because its comment reasonably claimed a resize was "the one moment a
 * restyle could have landed".
 *
 * That claim stopped being true when branding became asynchronous. The colour
 * arrives after `/candidate/session` resolves, long after the canvas has
 * painted its first frame and with no resize anywhere near it, so the
 * interview's largest brand surface kept the Quint purple while every other
 * element on the page had already turned. This is how it learns.
 *
 * A counter rather than the colour itself: the tokens are read back through
 * `getComputedStyle`, not passed around, so consumers need to know only THAT
 * something changed.
 */
export const brandColorRevision = ref(0)

/**
 * Tokens painted with the brand colour ITSELF.
 *
 * Exported so the writer and its tests read one list: a token added here
 * cannot be left untested, and one removed cannot leave a stale override
 * behind on clear. Same seam as the backoffice's copy of this file.
 *
 * Only the primary, unlike the backoffice, which also paints `--sidebar`.
 * This app renders no sidebar — those tokens exist in the stylesheet's shadcn
 * boilerplate and nothing reads them — so writing them here would be ceremony
 * that looks like coverage.
 */
export const BRAND_COLOR_TOKENS = ['--color-primary'] as const

/**
 * Tokens painted with a shade DERIVED from the brand colour.
 *
 * Derived rather than skipped, and CONCRETE rather than an expression. The
 * first version handed the mix to the browser with `color-mix(in oklab, …)`,
 * which is right about colour and wrong about where the value goes: an
 * unregistered custom property's computed value is its specified text, so
 * `getComputedStyle` returns the expression verbatim and `addColorStop()`
 * throws on it — every frame, for the whole interview, leaving the blank panel
 * `VoiceVisualizer` exists to prevent. `app/utils/brand-color` does the
 * arithmetic instead, and the trade is argued there.
 *
 * `--color-lavender` is in this list because it paints the ribbon's centre stop
 * AND its resting baseline — the only mark visible while nobody is speaking.
 * Leaving it out branded the edges and left the thing a candidate actually
 * looks at in product purple, which is the half-applied brand this file's own
 * header condemns, one token further out.
 */
export const BRAND_DERIVED_TOKENS = ['--color-primary-light', '--color-lavender'] as const

/**
 * The interview panel these canvas marks are measured against.
 *
 * Duplicated from `main.css`'s `--color-avatar-bg`, and it has to be: the
 * contrast guarantee runs BEFORE anything is written to the document, so there
 * is no computed style to read it from yet. Bound to the stylesheet by
 * `tests/unit/arch/canvas-brand-fallbacks.spec.ts`, which is the thing that
 * stops it drifting.
 */
const AVATAR_PANEL = '#0f172a'

/**
 * How each companion shade is built from the brand colour.
 *
 * The ratios reproduce the STEP the product's own palette takes, not its exact
 * colours. Stated plainly because it is easy to misread: `#771aaf` → `#c222d3`
 * is not a lightening at all — the light is MORE saturated, and no mix toward
 * white adds chroma — so these reproduce each token's ROLE, and the product's
 * own three values stay the authored constants they are.
 *
 * Two of the three then pass through `ensureContrast`, because two of them
 * land on a canvas where §9.1's floor is binding and the operator's colour is
 * arbitrary. That is DESIGN.md §7.3.2 rule 2, and it is the difference between
 * branding a waveform and hiding one.
 */
const DERIVE: Record<(typeof BRAND_DERIVED_TOKENS)[number], (color: string) => string> = {
  // The ribbon EDGE. §9.1's floor for a graphical object is 3:1, and the
  // product's own `#c222d3` measures 3.79:1 — so 3:1 is the guarantee, not the
  // target, and a tenant colour that already clears it is left alone.
  '--color-primary-light': (color) => ensureContrast(mix(color, '#ffffff', 0.7), AVATAR_PANEL, 3),

  // The ribbon CENTRE and the resting baseline — the only mark on screen while
  // nobody is speaking, which DESIGN.md §7.3 calls the property the whole
  // surface exists to have. Held to the 4.5:1 the product's own `#8373d2`
  // measures rather than the 3:1 floor, because this is the mark a candidate
  // reads as "the system is listening" and it is a hairline at rest.
  '--color-lavender': (color) => ensureContrast(mix(color, '#ffffff', 0.55), AVATAR_PANEL, 4.5),
}

/**
 * The value is a `#rrggbb` string validated by an anchored regex at the API AND
 * constrained by a database CHECK, so by the time it arrives it cannot carry a
 * `;` or a `}`. It is re-checked here anyway: this function writes into a
 * stylesheet, and a writer that trusts its input because something upstream
 * promised to check is exactly how an injection survives a refactor. It also
 * guards the arithmetic: `app/utils/brand-color` slices fixed offsets out of
 * the string and `Number.parseInt`s them, so a value of another shape would not throw
 * — it would quietly produce `NaN` channels and a colour nobody chose.
 *
 * A plain hex is a valid CSS colour in every browser this product supports
 * (DESIGN.md §2), so the override needs no conversion. Contrast against
 * `--primary-foreground` is the operator's responsibility once they choose a
 * colour of their own; the product cannot verify a colour it did not pick.
 */
export function applyBrandColor(color: string | null | undefined): void {
  if (typeof document === 'undefined') return

  const root = document.documentElement

  if (!color || !HEX.test(color)) {
    // Remove rather than reset: removing restores the stylesheet's own value,
    // while writing one here would hardcode a second copy of the brand colour.
    // Every token, including the derived ones — clearing only what the last
    // call wrote would leave a stale override from the one before it, and the
    // product palette would never come back.
    for (const token of [...BRAND_COLOR_TOKENS, ...BRAND_DERIVED_TOKENS]) {
      root.style.removeProperty(token)
    }

    // Bumped on this path too. A refusal and a clear both CHANGE the
    // stylesheet — back to the product palette — so a cached reader is just as
    // stale as it would be after an apply.
    brandColorRevision.value += 1

    return
  }

  for (const token of BRAND_COLOR_TOKENS) {
    root.style.setProperty(token, color)
  }

  // Driven by the same exported list the clear path and the tests read, rather
  // than by two hardcoded calls beside it. The comment above
  // `BRAND_DERIVED_TOKENS` promises the writer reads that list; hardcoding
  // here made the promise false, and a list that only the CLEAR path honours
  // is how a token ends up cleared but never written.
  //
  // Interpolated only AFTER the hex has passed the regex above.
  for (const token of BRAND_DERIVED_TOKENS) {
    root.style.setProperty(token, DERIVE[token](color))
  }

  brandColorRevision.value += 1
}
