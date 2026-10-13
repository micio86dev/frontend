import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatDeadline } from '~/app/utils/call-deadline'

describe('formatDeadline', () => {
  afterEach(() => vi.restoreAllMocks())

  it('formats hours and minutes in the given locale', () => {
    const exp = Date.UTC(2026, 0, 1, 14, 30) / 1000
    const expected = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(exp * 1000))
    expect(formatDeadline(exp, 'en-GB')).toBe(expected)
    expect(expected).toMatch(/^\d{2}:\d{2}$/)
  })

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    'returns null for an unusable exp (%s)',
    (exp) => {
      expect(formatDeadline(exp, 'en')).toBeNull()
    }
  )

  it('returns null instead of throwing for an invalid locale tag', () => {
    expect(formatDeadline(1_800_000_000, 'not a locale!!')).toBeNull()
  })

  it('does not swallow errors other than RangeError', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new TypeError('boom')
    })
    expect(() => formatDeadline(1_800_000_000, 'en')).toThrow(TypeError)
  })
})
