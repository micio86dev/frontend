/**
 * TDD RED → GREEN → REFACTOR — Tasks 1.3 / 1.4
 *
 * Cycle summary (task 1.3 RED):
 *   RED    — tests written against the desired main.css brand token values (D9).
 *            Expected to FAIL until task 1.4 GREEN reconciles the tokens.
 *   GREEN  — main.css updated with normative DESIGN.md §3.1 values + Open Sans + lavender + bg-gradient.
 *   REFACTOR — Updated to case-insensitive hex matching (prettier lowercases CSS hex values).
 *
 * Requirement: D9 — Color token reconciliation.
 * Spec ref: spec.md "Requirement: Color token reconciliation".
 *
 * We read main.css as a text string and assert CSS custom property values.
 * This runs in Node (happy-dom environment) and requires no browser runtime.
 *
 * Note on hex case: CSS hex values are case-insensitive; prettier normalises them to
 * lowercase. Tests use case-insensitive RegExp to match the normative value from
 * DESIGN.md §3.1 regardless of formatting style.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CSS_PATH = resolve(__dirname, '../../app/assets/css/main.css')

/** Assert a CSS custom property equals a given hex value (case-insensitive) */
function expectToken(cssSource: string, property: string, hex: string): void {
  const pattern = new RegExp(`${property}:\\s*${hex}`, 'i')
  expect(cssSource).toMatch(pattern)
}

describe('main.css — brand token reconciliation (D9)', () => {
  let cssSource: string

  beforeAll(() => {
    cssSource = readFileSync(CSS_PATH, 'utf-8')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Six brand color tokens — normative DESIGN.md §3.1 values
  // ─────────────────────────────────────────────────────────────────────────

  it('--color-primary is #771AAF (Quint purple — NOT navy #1e3a5f)', () => {
    expectToken(cssSource, '--color-primary', '#771[Aa][Aa][Ff]')
    // Stale navy value must be absent
    expect(cssSource).not.toContain('#1e3a5f')
  })

  it('--color-primary-light is #C222D3', () => {
    expectToken(cssSource, '--color-primary-light', '#[Cc]222[Dd]3')
    expect(cssSource).not.toContain('#2d5282')
  })

  it('--color-primary-dark is #4F1AAF', () => {
    expectToken(cssSource, '--color-primary-dark', '#4[Ff]1[Aa]{2}[Ff]')
    expect(cssSource).not.toContain('#132740')
  })

  it('--color-accent is #E45526 (Quint orange — NOT teal #0d9488)', () => {
    expectToken(cssSource, '--color-accent', '#[Ee]45526')
    expect(cssSource).not.toContain('#0d9488')
  })

  it('--color-accent-light is #F19823', () => {
    expectToken(cssSource, '--color-accent-light', '#[Ff]19823')
    expect(cssSource).not.toContain('#14b8a6')
  })

  it('--color-accent-dark is #B8431E', () => {
    expectToken(cssSource, '--color-accent-dark', '#[Bb]8431[Ee]')
    expect(cssSource).not.toContain('#0f766e')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Font token — Open Sans (not Inter)
  // ─────────────────────────────────────────────────────────────────────────

  it('--font-sans starts with "Open Sans" (not Inter)', () => {
    // Match both double-quoted and single-quoted forms (prettier may normalise quotes)
    expect(cssSource).toMatch(/--font-sans:\s*['"]Open Sans['"]/)
    // Inter must not appear as the first font in the font-sans stack
    expect(cssSource).not.toMatch(/--font-sans:\s*['"]Inter['"]/)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Additional brand tokens — lavender + bg-gradient
  // ─────────────────────────────────────────────────────────────────────────

  it('--color-lavender is #8373D2 (supporting secondary)', () => {
    expectToken(cssSource, '--color-lavender', '#8373[Dd]2')
  })

  it('--color-bg-gradient contains linear-gradient(135deg', () => {
    expect(cssSource).toContain('--color-bg-gradient: linear-gradient(135deg')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Negative assertion — old stale navy primary must not appear anywhere in main.css
  // ─────────────────────────────────────────────────────────────────────────

  it('does not contain the stale navy primary #1e3a5f anywhere in main.css', () => {
    expect(cssSource).not.toContain('#1e3a5f')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // @fontsource/open-sans import must be present (self-hosted, GDPR-safe)
  // ─────────────────────────────────────────────────────────────────────────

  it('imports @fontsource/open-sans (self-hosted font, not Google Fonts)', () => {
    expect(cssSource).toContain("@import '@fontsource/open-sans'")
    // No Google Fonts runtime request
    expect(cssSource).not.toMatch(/fonts\.googleapis\.com/)
  })
})
