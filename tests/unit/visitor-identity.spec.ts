/**
 * Client-side validation for the reusable identity form (DESIGN.md §16.19).
 *
 * The functions are the form's FIRST check, not its authority: the server's rule
 * stays authoritative and a 422 maps back onto the same fields. They exist so an
 * obviously wrong value never costs a request, and so the visitor reads the app's
 * own localized message instead of a browser bubble. Lengths are counted in code
 * points to match PHP `mb_strlen`, which is what the server validates with.
 */
import { describe, it, expect } from 'vitest'
import {
  IDENTITY_MAX_LENGTH,
  normalizeIdentityValue,
  validateDisplayName,
  validateEmail,
} from '../../app/utils/visitor-identity'

describe('IDENTITY_MAX_LENGTH', () => {
  it('is 255', () => {
    expect(IDENTITY_MAX_LENGTH).toBe(255)
  })
})

describe('normalizeIdentityValue', () => {
  it('trims surrounding whitespace and nothing else', () => {
    expect(normalizeIdentityValue('  Ada Lovelace \t\n')).toBe('Ada Lovelace')
    expect(normalizeIdentityValue('Ada   Lovelace')).toBe('Ada   Lovelace')
  })
})

describe('validateDisplayName', () => {
  it('requires a value', () => {
    expect(validateDisplayName('')).toBe('nameRequired')
  })

  it('treats whitespace only as empty', () => {
    expect(validateDisplayName('   \t ')).toBe('nameRequired')
  })

  it('accepts 255 code points and refuses 256', () => {
    expect(validateDisplayName('a'.repeat(255))).toBeNull()
    expect(validateDisplayName('a'.repeat(256))).toBe('nameTooLong')
  })

  it('counts an emoji as ONE code point, not two UTF-16 units', () => {
    // 255 emoji are 510 UTF-16 units: a `.length` check would wrongly refuse them.
    expect(validateDisplayName('😀'.repeat(255))).toBeNull()
    expect(validateDisplayName('😀'.repeat(256))).toBe('nameTooLong')
  })

  it('measures the trimmed value', () => {
    expect(validateDisplayName(`  ${'a'.repeat(255)}  `)).toBeNull()
  })

  it('accepts an ordinary name', () => {
    expect(validateDisplayName('Ada Lovelace')).toBeNull()
  })
})

describe('validateEmail', () => {
  it('requires a value', () => {
    expect(validateEmail('')).toBe('emailRequired')
    expect(validateEmail('   ')).toBe('emailRequired')
  })

  it('refuses an address longer than 255 characters', () => {
    const tooLong = `${'a'.repeat(256 - '@b.co'.length)}@b.co`
    expect(tooLong).toHaveLength(256)
    expect(validateEmail(tooLong)).toBe('emailTooLong')

    const longest = `${'a'.repeat(255 - '@b.co'.length)}@b.co`
    expect(longest).toHaveLength(255)
    expect(validateEmail(longest)).toBeNull()
  })

  it.each(['ada@example.com', 'a.b+c@sub.example.it', '  ada@example.com  ', 'a@b.c', 'a@.b.c'])(
    'accepts %j',
    (value) => {
      expect(validateEmail(value)).toBeNull()
    }
  )

  it.each([
    'not-an-email',
    'a@',
    '@b.c',
    'ana@gmail',
    'a b@c.d',
    'a@b@c.d',
    'a@b.c@d.e',
    'a@.c',
    'a@b.',
    'a@b .c',
    'a@\tb.c',
  ])('rejects %j as malformed', (value) => {
    expect(validateEmail(value)).toBe('emailInvalid')
  })
})
