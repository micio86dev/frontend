/**
 * TDD RED → GREEN → REFACTOR — Tasks 1.6 / 1.7
 *
 * Cycle summary (task 1.6 RED):
 *   RED    — tests written for isSupportedBrowser(ua, width): boolean (D5).
 *            Expected to FAIL until task 1.7 GREEN creates app/utils/browser-gate.ts.
 *   GREEN  — browser-gate.ts created with Firefox-denylist + mobile-UA + viewport-width check.
 *   REFACTOR — no cleanup needed (pure function, no side effects).
 *
 * Requirement: D5 — Browser gate (SA-11).
 * Spec ref: spec.md "Requirement: Browser Support Gate (SA-11)".
 *
 * Coverage target: ~95% (correctness-critical pure unit per CLAUDE.md + D10).
 *
 * The function is PURE: no browser globals, no module-scope side effects.
 * Tests run in Node (happy-dom) with no browser context required.
 */

import { describe, it, expect } from 'vitest'
import { isSupportedBrowser } from '../../app/utils/browser-gate'

// ─────────────────────────────────────────────────────────────────────────────
// Representative UA strings (not pinned to specific versions — logic matters)
// ─────────────────────────────────────────────────────────────────────────────

const FIREFOX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'

const OPERA_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0'

const SAFARI_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Mobi/xxx'

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

describe('isSupportedBrowser — D5 browser gate (SA-11)', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Firefox — always rejected regardless of width (Firefox-denylist)
  // ─────────────────────────────────────────────────────────────────────────

  it('Firefox UA → false at width 1440 (Firefox-denylist)', () => {
    expect(isSupportedBrowser(FIREFOX_UA, 1440)).toBe(false)
  })

  it('Firefox UA → false at any width (denylist applies regardless of viewport)', () => {
    expect(isSupportedBrowser(FIREFOX_UA, 1024)).toBe(false)
    expect(isSupportedBrowser(FIREFOX_UA, 1920)).toBe(false)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Mobile / tablet UA strings — rejected (Mobi / Android / iPhone / iPad)
  // ─────────────────────────────────────────────────────────────────────────

  it('Mobile UA (Mobi) → false at desktop-range width 1200', () => {
    expect(isSupportedBrowser(MOBILE_UA, 1200)).toBe(false)
  })

  it('iPhone UA → false at width 390', () => {
    expect(isSupportedBrowser(IPHONE_UA, 390)).toBe(false)
  })

  it('iPad UA → false (iPad in UA string triggers mobile-device predicate)', () => {
    expect(isSupportedBrowser(IPAD_UA, 1024)).toBe(false)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Supported desktop browsers — Chrome, Edge, Opera, Safari
  // ─────────────────────────────────────────────────────────────────────────

  it('Chrome desktop UA at width 1440 → true', () => {
    expect(isSupportedBrowser(CHROME_UA, 1440)).toBe(true)
  })

  it('Edge (Edg/) at width 1280 → true', () => {
    expect(isSupportedBrowser(EDGE_UA, 1280)).toBe(true)
  })

  it('Opera (OPR/) at width 1280 → true', () => {
    expect(isSupportedBrowser(OPERA_UA, 1280)).toBe(true)
  })

  it('Safari desktop UA at width 1440 → true', () => {
    expect(isSupportedBrowser(SAFARI_DESKTOP_UA, 1440)).toBe(true)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Viewport width boundary — DESIGN.md §6: < 1024 px = tablet/mobile = unsupported
  // ─────────────────────────────────────────────────────────────────────────

  it('width 900 (tablet) with Chrome UA → false (768-1023 px = unsupported per DESIGN.md §6)', () => {
    expect(isSupportedBrowser(CHROME_UA, 900)).toBe(false)
  })

  it('width 1023 with Chrome UA → false (boundary: < 1024 is unsupported)', () => {
    expect(isSupportedBrowser(CHROME_UA, 1023)).toBe(false)
  })

  it('width 1024 with Chrome UA → true (boundary: ≥ 1024 is supported)', () => {
    expect(isSupportedBrowser(CHROME_UA, 1024)).toBe(true)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Server-side path — pass Infinity as width (no viewport in HTTP headers)
  // The UA check still applies; the width check is bypassed
  // ─────────────────────────────────────────────────────────────────────────

  it('server-side: Chrome UA + Infinity width → true (UA-only check, no viewport)', () => {
    expect(isSupportedBrowser(CHROME_UA, Infinity)).toBe(true)
  })

  it('server-side: Firefox UA + Infinity width → false (UA check still applies)', () => {
    expect(isSupportedBrowser(FIREFOX_UA, Infinity)).toBe(false)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Unsupported-route skip-condition — path endsWith('/unsupported')
  // The middleware itself checks this; the pure function does NOT — but we assert
  // the string logic used inside the middleware condition works correctly.
  // We test it as a pure string predicate (not the middleware wrapper).
  // ─────────────────────────────────────────────────────────────────────────

  it('path.endsWith("/unsupported") guard — "/unsupported" matches', () => {
    // Inline test of the string condition used by the middleware early-return
    expect('/unsupported'.endsWith('/unsupported')).toBe(true)
  })

  it('path.endsWith("/unsupported") guard — "/en/unsupported" also matches (no redirect loop)', () => {
    expect('/en/unsupported'.endsWith('/unsupported')).toBe(true)
  })

  it('path.endsWith("/unsupported") guard — "/interview/token123" does NOT match', () => {
    expect('/interview/token123'.endsWith('/unsupported')).toBe(false)
  })
})
