/**
 * The destructive Alert keeps its title AND description legible (DESIGN.md §9.1).
 *
 * The variant used `text-destructive` (`#e7000b`) on `--color-error-light`
 * (`#fee2e2`), 3.90:1 for 14 px text, and dimmed the description to 90%. The
 * text-safe `--color-error-dark` is the fix; this spec computes the ratio from
 * the stylesheet token and the class names the variant actually emits.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { alertVariants } from '../../app/components/ui/alert'
import { contrastRatio } from '../../app/utils/brand-color'

const css = readFileSync(resolve(__dirname, '../../app/assets/css/main.css'), 'utf-8')

function token(name: string): string {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`))
  if (!match?.[1]) throw new Error(`token ${name} is not defined as a concrete hex in main.css`)
  return match[1]
}

describe('destructive Alert contrast', () => {
  const classes = alertVariants({ variant: 'destructive' })

  it('paints the title with the text-safe error token, not --destructive', () => {
    expect(classes).toMatch(/(^|\s)text-error-dark(\s|$)/)
    expect(classes).not.toMatch(/(^|\s)text-destructive(\s|$)/)
  })

  it('keeps the description at full strength (no opacity dimming)', () => {
    expect(classes).not.toMatch(/data-\[slot=alert-description\]:text-[\w-]+\/\d+/)
  })

  it('title and description are at least 4.5:1 on the alert background', () => {
    expect(
      contrastRatio(token('--color-error-dark'), token('--color-error-light'))
    ).toBeGreaterThanOrEqual(4.5)
  })
})

describe('the description colour belongs to the variant, not to two competing classes', () => {
  // `AlertDescription` used to carry `text-muted-foreground` itself while the
  // variants set `*:data-[slot=alert-description]:text-current` on the root: two
  // single-class rules for one property, so the winner was an accident of the
  // selector shapes and Tailwind's output order. A unit test cannot see that
  // order (the Playwright spec "the destructive alert follows its variant" reads
  // the real CSS); what it can pin is that there is only ONE rule to win.
  const source = readFileSync(
    resolve(__dirname, '../../app/components/ui/alert/AlertDescription.vue'),
    'utf-8'
  )
  const DESCRIPTION_COLOUR = /\*:data-\[slot=alert-description\]:text-/

  it('AlertDescription sets no text colour of its own', () => {
    const classes = source.slice(source.indexOf('cn('), source.indexOf('props.class'))

    expect(classes).not.toMatch(
      /(^|[\s'])text-(muted-foreground|foreground|current|[a-z-]+-dark)\b/
    )
  })

  it.each(['default', 'success', 'warning', 'destructive'] as const)(
    'the %s variant states the description colour exactly once',
    (variant) => {
      const matches = alertVariants({ variant }).match(new RegExp(DESCRIPTION_COLOUR, 'g'))

      expect(matches).toHaveLength(1)
    }
  )

  it('the destructive description is the alert text colour at full strength', () => {
    expect(alertVariants({ variant: 'destructive' })).toMatch(
      /\*:data-\[slot=alert-description\]:text-current(\s|$)/
    )
  })

  it('the default variant keeps the muted description', () => {
    expect(alertVariants({ variant: 'default' })).toMatch(
      /\*:data-\[slot=alert-description\]:text-muted-foreground(\s|$)/
    )
  })
})
