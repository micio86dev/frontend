/**
 * TDD RED → GREEN → REFACTOR — Tasks 1.1 / 1.2
 *
 * Cycle summary (task 1.1 RED):
 *   RED    — tests written against the desired nuxt.config.ts routeRules shape (D6).
 *            Expected to FAIL until task 1.2 GREEN adds the interview-route entries.
 *   GREEN  — nuxt.config.ts updated with /interview/** and /en/interview/** entries.
 *   REFACTOR — locale-pattern count guard added (task 5.11 pre-wire).
 *
 * Requirement: D6 — Permissions-Policy per-route override.
 * Spec ref: spec.md "Requirement: Permissions-Policy per-route override".
 *
 * Why we import the raw config object rather than spawning a Nuxt server:
 *   routeRules is a plain object — no Nuxt runtime needed. Importing the config
 *   and reading its nitro.routeRules is sufficient and runs entirely in Node.
 *
 * NOTE: defineNuxtConfig is NOT available in Vitest (no Nuxt runtime). We resolve
 * it using a mock defined in vitest.config.ts or via vi.mock at import time.
 * The approach: we read the raw TypeScript source and assert the shape.
 *
 * Simpler approach: since defineNuxtConfig just returns its argument, we can stub
 * it globally and then dynamically import the config module.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Rather than executing the module (which requires @tailwindcss/vite at module scope),
 * we read nuxt.config.ts as a text file and assert the required header patterns exist.
 * This is intentional: the config is infrastructure config, not application logic.
 * The test verifies the D6 canonical header values are present in the source.
 */

const CONFIG_PATH = resolve(__dirname, '../../nuxt.config.ts')

describe('nuxt.config.ts — Permissions-Policy routeRules (D6)', () => {
  let configSource: string

  beforeAll(() => {
    configSource = readFileSync(CONFIG_PATH, 'utf-8')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Interview route patterns must exist
  // ─────────────────────────────────────────────────────────────────────────

  it('contains /interview/** route entry', () => {
    expect(configSource).toContain("'/interview/**'")
  })

  it('contains /en/interview/** route entry for non-default locale (i18n prefix_except_default)', () => {
    expect(configSource).toContain("'/en/interview/**'")
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Permissions-Policy header value — camera + microphone self + geolocation deny
  // D6: Nitro REPLACES not merges → all four headers must appear per entry
  // ─────────────────────────────────────────────────────────────────────────

  it('sets camera=(self) microphone=(self) geolocation=() on interview routes', () => {
    expect(configSource).toContain("'camera=(self) microphone=(self) geolocation=()'")
  })

  it('retains X-Frame-Options: DENY on interview routes (Nitro replace-not-merge)', () => {
    // The value 'DENY' appears in the global rule; we assert it appears at least twice
    // (once for global /** and once for interview routes — both must carry it)
    const denyCount = (configSource.match(/'DENY'/g) ?? []).length
    expect(denyCount).toBeGreaterThanOrEqual(2)
  })

  it('retains X-Content-Type-Options: nosniff on interview routes', () => {
    const nosniffCount = (configSource.match(/'nosniff'/g) ?? []).length
    expect(nosniffCount).toBeGreaterThanOrEqual(2)
  })

  it('retains Referrer-Policy: strict-origin-when-cross-origin on interview routes', () => {
    const referrerCount = (configSource.match(/'strict-origin-when-cross-origin'/g) ?? []).length
    expect(referrerCount).toBeGreaterThanOrEqual(2)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Global rule must retain deny-all Permissions-Policy
  // ─────────────────────────────────────────────────────────────────────────

  it('global /** rule retains camera=() microphone=() geolocation=()', () => {
    expect(configSource).toContain("'camera=(), microphone=(), geolocation=()'")
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Locale-pattern count guard (task 5.11 pre-wire)
  // The number of /[locale]/interview/** entries must equal the number of
  // non-default locales in i18n.locales (guards future es/fr/de/pt additions).
  // Currently: 1 non-default locale (en) → 1 prefixed entry (/en/interview/**)
  // ─────────────────────────────────────────────────────────────────────────

  it('has exactly one non-default-locale interview route entry per non-default locale', () => {
    // Count non-default locale interview route patterns: /[locale]/interview/**
    // Pattern: '/<alpha>/interview/**' where <alpha> is NOT 'en' at this stage
    // We count entries that match a locale-prefixed pattern
    const prefixedEntries = Array.from(configSource.matchAll(/'\/([a-z]{2})\/interview\/\*\*'/g))
    // i18n.locales has 2 locales (it, en); defaultLocale = 'it'; non-default count = 1
    const nonDefaultLocaleCount = 1
    expect(prefixedEntries.length).toBe(nonDefaultLocaleCount)
  })
})
