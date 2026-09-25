/**
 * embed-csp — unit tests for the pure header-building functions
 * `server/middleware/embed-csp.ts` uses to answer `/embed/{token}` (public-api
 * SPEC §4.4).
 */

import { describe, it, expect } from 'vitest'
import {
  buildFrameAncestorsHeader,
  buildPermissionsPolicyHeader,
  isHostnameAllowed,
  EMBED_PERMISSIONS_POLICY,
} from '~/app/utils/embed-csp'

describe('buildFrameAncestorsHeader', () => {
  it("fails safe to 'none' for an empty domain list", () => {
    expect(buildFrameAncestorsHeader([])).toBe("frame-ancestors 'none'")
  })

  it("includes 'self' plus every configured domain", () => {
    expect(buildFrameAncestorsHeader(['acme.example', 'hr.acme.example'])).toBe(
      "frame-ancestors 'self' acme.example hr.acme.example"
    )
  })

  it('a single domain', () => {
    expect(buildFrameAncestorsHeader(['acme.example'])).toBe("frame-ancestors 'self' acme.example")
  })

  it('strips an accidental scheme and trailing slash from a configured domain', () => {
    expect(buildFrameAncestorsHeader(['https://acme.example/'])).toBe(
      "frame-ancestors 'self' acme.example"
    )
  })

  it('trims incidental whitespace', () => {
    expect(buildFrameAncestorsHeader(['  acme.example  '])).toBe(
      "frame-ancestors 'self' acme.example"
    )
  })

  it("drops an entry that normalizes to empty and falls back to 'none' if nothing is left", () => {
    expect(buildFrameAncestorsHeader(['   '])).toBe("frame-ancestors 'none'")
  })

  it.each([
    ['a directive separator', "evil.example; script-src 'unsafe-inline'"],
    ['an embedded space', 'a.example b.example'],
    ['a path', 'acme.example/path'],
    ['a wildcard', '*.acme.example'],
    ['a comma', 'a.example,b.example'],
  ])('drops an entry carrying %s instead of splicing it into the header', (_label, entry) => {
    expect(buildFrameAncestorsHeader([entry, 'acme.example'])).toBe(
      "frame-ancestors 'self' acme.example"
    )
    expect(buildFrameAncestorsHeader([entry])).toBe("frame-ancestors 'none'")
  })

  it('keeps a host:port entry', () => {
    expect(buildFrameAncestorsHeader(['localhost:3000'])).toBe(
      "frame-ancestors 'self' localhost:3000"
    )
  })

  it('drops an empty entry but keeps the rest', () => {
    expect(buildFrameAncestorsHeader(['acme.example', '  '])).toBe(
      "frame-ancestors 'self' acme.example"
    )
  })
})

describe('buildPermissionsPolicyHeader', () => {
  it('returns the spec-pinned value', () => {
    expect(buildPermissionsPolicyHeader()).toBe('camera=(self), microphone=(self)')
    expect(buildPermissionsPolicyHeader()).toBe(EMBED_PERMISSIONS_POLICY)
  })
})

describe('isHostnameAllowed', () => {
  it('matches an exact configured domain', () => {
    expect(isHostnameAllowed('acme.example', ['acme.example', 'hr.acme.example'])).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isHostnameAllowed('ACME.example', ['acme.example'])).toBe(true)
  })

  it('never implies a subdomain from its parent domain', () => {
    expect(isHostnameAllowed('hr.acme.example', ['acme.example'])).toBe(false)
  })

  it('never implies a parent domain from its subdomain', () => {
    expect(isHostnameAllowed('acme.example', ['hr.acme.example'])).toBe(false)
  })

  it('refuses everything against an empty allow-list', () => {
    expect(isHostnameAllowed('acme.example', [])).toBe(false)
  })

  it('refuses an empty hostname even against a non-empty allow-list', () => {
    expect(isHostnameAllowed('', ['acme.example'])).toBe(false)
  })
})
