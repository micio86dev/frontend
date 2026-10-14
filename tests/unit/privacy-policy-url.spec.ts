import { describe, it, expect } from 'vitest'
import { sanitizePrivacyPolicyUrl } from '~/app/composables/usePrivacyPolicyUrl'

describe('sanitizePrivacyPolicyUrl', () => {
  it('accepts an absolute https URL and trims it', () => {
    expect(sanitizePrivacyPolicyUrl('  https://example.com/p.pdf ')).toBe(
      'https://example.com/p.pdf'
    )
  })

  it.each([
    ['empty', ''],
    ['http', 'http://example.com/p.pdf'],
    ['javascript', 'javascript:alert(1)'],
    ['relative', '/p.pdf'],
    ['protocol-relative', '//example.com/p.pdf'],
    ['not a string', 42],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(sanitizePrivacyPolicyUrl(value)).toBe('')
  })
})
