/**
 * Colour arithmetic for tenant branding (DESIGN.md §7.3.2).
 *
 * WHY THIS IS JAVASCRIPT AND NOT `color-mix()`. Handing the mix to the browser
 * was the first design, and it was right about one thing — the browser has a
 * colour space and we do not — but wrong about where the value ends up. A
 * custom property holding a `color-mix()` EXPRESSION is returned verbatim by
 * `getComputedStyle`, because an unregistered property's computed value is its
 * specified token stream. CSS does not care; `addColorStop()` does, and throws
 * `SyntaxError` on what it cannot parse. Inside `requestAnimationFrame` that is
 * a throw every frame and a blank interview panel — the exact outcome the
 * visualizer exists to prevent.
 *
 * Resolving the mix through a probe element was the other candidate. It works
 * in a browser and not in jsdom, which would leave the branded path untested in
 * every unit test in the repo — the shape the rules call "a test that has never
 * been seen to fail".
 *
 * So the arithmetic lives here: concrete in, concrete out, identical in every
 * engine and in the test suite. sRGB rather than oklab, stated plainly as a
 * trade: an oklab mix is more perceptually even, and shipping its matrices
 * would be far more code to get subtly wrong than a channel lerp. The contrast
 * work below is sRGB-defined anyway (WCAG 2.1 gives the formula exactly), so
 * one colour space for both keeps this module honest.
 */

/** `#rrggbb`, the only shape the API and the database CHECK allow through. */
const HEX = /^#[0-9a-f]{6}$/i

type Rgb = { r: number; g: number; b: number }

function toRgb(hex: string): Rgb {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }
}

function toHex({ r, g, b }: Rgb): string {
  const channel = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0')

  return `#${channel(r)}${channel(g)}${channel(b)}`
}

/**
 * `ratio` of `color`, the remainder of `target`.
 *
 * Deliberately the same argument order and meaning as the `color-mix()` call
 * this replaces, so the ratios in `useBrandTheme` still read the way DESIGN.md
 * describes them.
 */
export function mix(color: string, target: string, ratio: number): string {
  // Returned unchanged rather than computed on garbage. `toRgb` slices fixed
  // offsets and parses them, so a value of another shape yields `NaN` channels
  // and a colour nobody chose — silently, which is the failure mode this
  // module exists to remove rather than relocate.
  if (!HEX.test(color) || !HEX.test(target)) return color

  const a = toRgb(color)
  const b = toRgb(target)

  return toHex({
    r: a.r * ratio + b.r * (1 - ratio),
    g: a.g * ratio + b.g * (1 - ratio),
    b: a.b * ratio + b.b * (1 - ratio),
  })
}

/** WCAG 2.1 relative luminance. The formula, not an approximation of it. */
function relativeLuminance(hex: string): number {
  const { r, g, b } = toRgb(hex)

  const linear = (value: number): number => {
    const channel = value / 255

    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }

  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** WCAG 2.1 contrast ratio between two opaque colours, 1:1 … 21:1. */
export function contrastRatio(a: string, b: string): number {
  const light = Math.max(relativeLuminance(a), relativeLuminance(b))
  const dark = Math.min(relativeLuminance(a), relativeLuminance(b))

  return (light + 0.05) / (dark + 0.05)
}

/**
 * Lighten `color` until it clears `minRatio` against `background`.
 *
 * THE CANVAS GUARANTEES ITS OWN LEGIBILITY (DESIGN.md §7.3.2 rule 2). The
 * ratios recorded in §7.3's table are measured against the PRODUCT's palette.
 * An operator picks an arbitrary colour, and a dark one puts the ribbon under
 * §9.1's binding ≥3:1 against `--color-avatar-bg` — a waveform a candidate
 * cannot see, on the surface whose entire purpose is that silence and
 * breakage never look the same.
 *
 * Delegating this to the operator was the alternative and it is not
 * defensible: the product cannot ask someone choosing a brand colour to also
 * verify a waveform against a panel they have never seen.
 *
 * Lightens toward white in fixed steps rather than solving for the luminance
 * directly. The step is small enough that the result stays recognisably the
 * tenant's hue, and the loop is bounded — at `ratio` 0 the colour IS white,
 * which is 17.85:1 against `#0f172a`, so every reachable threshold terminates
 * long before the bound. The bound exists so a future caller passing an
 * impossible `minRatio` gets the best available colour instead of a hang.
 */
export function ensureContrast(color: string, background: string, minRatio: number): string {
  if (!HEX.test(color) || !HEX.test(background)) return color

  let candidate = color

  for (let step = 0; step < 20; step += 1) {
    if (contrastRatio(candidate, background) >= minRatio) return candidate

    candidate = mix(candidate, '#ffffff', 0.85)
  }

  return candidate
}
