import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatDeadline } from '~/app/utils/call-deadline'

describe('formatDeadline', () => {
  afterEach(() => vi.restoreAllMocks())

  describe('with a pinned timezone', () => {
    const originalTz = process.env.TZ
    // 14:30 UTC, as epoch seconds.
    const exp = Date.UTC(2026, 0, 1, 14, 30) / 1000

    beforeEach(() => {
      process.env.TZ = 'UTC'
    })
    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ
      else process.env.TZ = originalTz
    })

    // Hard-coded expectations, independent of the Intl call the implementation
    // makes. \s tolerates the narrow no-break space newer ICU puts before PM.
    it.each([
      ['en-GB', /^14:30$/],
      ['de', /^14:30$/],
      ['en-US', /^02:30\sPM$/],
    ])('formats hours and minutes for %s', (locale, expected) => {
      expect(formatDeadline(exp, locale)).toMatch(expected)
    })

    it('follows the runtime timezone, not UTC', () => {
      process.env.TZ = 'Asia/Tokyo'
      expect(formatDeadline(exp, 'en-GB')).toBe('23:30')
    })
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
