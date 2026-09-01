/**
 * Paint the organization's primary colour over the product's.
 *
 * `--primary` is a shadcn token every primary button, link and active nav item
 * already reads, so overriding it on `:root` recolours the app without touching
 * a single component. The alternative — threading a colour prop through the
 * tree — would reach only the components somebody remembered.
 *
 * SETS NOTHING WHEN THE ORGANIZATION HAS NO COLOUR, and that is the important
 * half. An unset custom property falls through to the stylesheet's own value,
 * which is the Quint purple DESIGN.md defines. Writing a "default" here would
 * duplicate that constant in a second place, and the two would drift.
 *
 * The value is a `#rrggbb` string validated by an anchored regex at the API AND
 * constrained by a database CHECK, so by the time it arrives it cannot carry a
 * `;` or a `}`. It is re-checked here anyway: this function writes into a
 * stylesheet, and a writer that trusts its input because something upstream
 * promised to check is exactly how an injection survives a refactor.
 */

/** The same shape the API enforces. Duplicated deliberately — see above. */
const HEX = /^#[0-9a-f]{6}$/i

/**
 * `--primary` is consumed as an OKLCH triple by the rest of the theme, but a
 * plain hex is a valid CSS colour in every browser this product supports
 * (DESIGN.md §2), so the override does not need conversion. Contrast against
 * `--primary-foreground` is the operator's responsibility once they choose a
 * colour of their own; the product cannot verify a colour it did not pick.
 */
export function applyBrandColor(color: string | null | undefined): void {
  if (typeof document === 'undefined') return

  const root = document.documentElement

  if (!color || !HEX.test(color)) {
    // Remove rather than reset: removing restores the stylesheet's own value,
    // while writing one here would hardcode a second copy of the brand colour.
    root.style.removeProperty('--primary')

    return
  }

  root.style.setProperty('--primary', color)
}
