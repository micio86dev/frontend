/**
 * The colour arithmetic behind tenant branding.
 *
 * Worth its own suite rather than only being exercised through
 * `applyBrandColor`: these three functions decide whether a candidate can SEE
 * the waveform, and a wrong contrast ratio is invisible until someone picks the
 * colour that exposes it.
 */
import { describe, it, expect } from 'vitest'
import { mix, contrastRatio, ensureContrast } from '../../app/utils/brand-color'

const PANEL = '#0f172a'

describe('mix', () => {
  it('returns the colour untouched at full ratio', () => {
    expect(mix('#e45526', '#ffffff', 1)).toBe('#e45526')
  })

  it('returns the target at zero ratio', () => {
    expect(mix('#e45526', '#ffffff', 0)).toBe('#ffffff')
    expect(mix('#e45526', '#000000', 0)).toBe('#000000')
  })

  it('moves toward white and toward black, per channel', () => {
    // Half of #808080 toward white is #c0c0c0 — arithmetic anyone can check by
    // hand, which is the point of picking it.
    expect(mix('#808080', '#ffffff', 0.5)).toBe('#c0c0c0')
    expect(mix('#808080', '#000000', 0.5)).toBe('#404040')
  })
})

describe('contrastRatio', () => {
  it('gives the known extremes', () => {
    // WCAG's range is 1:1 to 21:1, and black on white is the top of it.
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1)
    expect(contrastRatio('#0f172a', '#0f172a')).toBeCloseTo(1, 5)
  })

  it('is symmetric — the order of the pair cannot change the answer', () => {
    expect(contrastRatio('#8373d2', PANEL)).toBeCloseTo(contrastRatio(PANEL, '#8373d2'), 10)
  })

  it('reproduces the ratios DESIGN.md §7.3 records as measured', () => {
    // The table claims lavender 4.55:1 and primary-light 3.79:1 against the
    // interview panel. If this implementation disagrees with the document, one
    // of the two is wrong and the whole contrast guarantee rests on it.
    expect(contrastRatio('#8373d2', PANEL)).toBeCloseTo(4.55, 1)
    expect(contrastRatio('#c222d3', PANEL)).toBeCloseTo(3.79, 1)
  })
})

describe('ensureContrast', () => {
  it('leaves a colour that already clears the floor untouched', () => {
    // A floor, not a filter. Dragging a compliant colour toward white would
    // wash out the tenant's brand for no reason.
    expect(ensureContrast('#8373d2', PANEL, 3)).toBe('#8373d2')
  })

  it('lifts a colour that does not, until it does', () => {
    const lifted = ensureContrast('#12203a', PANEL, 3)

    expect(lifted).not.toBe('#12203a')
    expect(contrastRatio(lifted, PANEL)).toBeGreaterThanOrEqual(3)
  })

  it('terminates on an unreachable threshold instead of hanging', () => {
    // 21:1 against a dark panel is not reachable by lightening — white itself
    // measures about 17.9:1. The bounded loop returns the best it found, which
    // is what a caller can still render, rather than spinning.
    const result = ensureContrast('#12203a', PANEL, 21)

    expect(result).toMatch(/^#[0-9a-f]{6}$/i)
    expect(contrastRatio(result, PANEL)).toBeGreaterThan(contrastRatio('#12203a', PANEL))
  })

  it('refuses to do arithmetic on a value that is not a hex', () => {
    // Defence in depth behind `applyBrandColor`'s regex: slicing fixed offsets
    // out of a malformed string yields NaN channels and a colour nobody chose,
    // silently. Returning the input unchanged keeps the failure visible.
    expect(ensureContrast('not-a-colour', PANEL, 3)).toBe('not-a-colour')
  })
})
