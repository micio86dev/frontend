/**
 * The primary Button on the brand canvas surface (DESIGN.md §7.0.1).
 *
 * Its fill is the client colour and its label the derived on-primary, so the
 * label always reads. The fill itself did not: a `#ffd400` button on the white
 * surface is 1.07:1, a label floating on nothing. The primary-ink edge is held
 * at >= 4.5:1 on white for any client colour, so the button keeps its shape.
 */
import { describe, it, expect } from 'vitest'
import { buttonVariants } from '../../app/components/ui/button'

describe('buttonVariants — default (primary)', () => {
  const classes = buttonVariants({ variant: 'default' }).split(/\s+/)

  it('fills with the client colour and labels with the readable on-primary', () => {
    expect(classes).toContain('bg-primary')
    expect(classes).toContain('text-primary-foreground')
  })

  it('edges the fill in primary-ink so it stands out from the white surface', () => {
    expect(classes).toContain('border-primary-ink')
  })

  it('leaves the other variants without the brand edge', () => {
    expect(buttonVariants({ variant: 'outline' })).not.toContain('border-primary-ink')
  })
})
