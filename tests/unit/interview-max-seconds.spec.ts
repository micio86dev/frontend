/**
 * The interview's total time limit, as the start response carries it
 * (`interview_max_seconds`, set from the active avatar template).
 */

import { describe, it, expect } from 'vitest'
import { interviewMaxSecondsFrom } from '~/app/utils/interview-max-seconds'

describe('interviewMaxSecondsFrom', () => {
  it('returns the template value when the server sent a positive whole number', () => {
    expect(interviewMaxSecondsFrom(1200)).toBe(1200)
  })

  it('returns null when the field is absent (an older API), so the caller can decide', () => {
    expect(interviewMaxSecondsFrom(undefined)).toBeNull()
  })

  it.each([0, -5, 12.5, Number.NaN, '1200', null])('rejects %s', (value) => {
    expect(interviewMaxSecondsFrom(value)).toBeNull()
  })
})
