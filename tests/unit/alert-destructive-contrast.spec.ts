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
