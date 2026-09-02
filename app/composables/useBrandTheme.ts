/**
 * Paint the organization's primary colour over the product's.
 *
 * `--color-primary` is the token every primary button and link actually reads
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
 * WHY `--color-primary` AND NOT `--primary`. This wrote `--primary`, and
 * nothing read it. The app is Tailwind v4: `main.css` declares
 * `@theme { --color-primary: #771aaf }` as a LITERAL, and `bg-primary` /
 * `text-primary` compile to `var(--color-primary)`. `--color-primary` is
 * deliberately NOT bridged to `var(--primary)` — that would shadow the literal
 * and regress `bg-primary` to shadcn's grey. So the two never met and every
 * candidate saw the Quint purple whatever their organization had configured.
 *
 * ONLY the primary, unlike the backoffice's copy of this file, which also
 * paints `--sidebar`. This app renders no sidebar — the tokens exist in the
 * stylesheet's shadcn boilerplate and nothing reads them — so writing them
 * here would be ceremony that looks like coverage.
 *
 * A plain hex is a valid CSS colour in every browser this product supports, but
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
    root.style.removeProperty('--color-primary')

    return
  }

  root.style.setProperty('--color-primary', color)
}
