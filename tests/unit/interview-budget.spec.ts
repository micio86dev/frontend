/**
 * Once the whole interview's time is spent, the question in progress is allowed to
 * finish on its closing phrase. The closing grace period is bounded.
 */

import { describe, it, expect } from 'vitest'
import { INTERVIEW_CLOSING_GRACE_MS } from '~/app/utils/interview-budget'

describe('INTERVIEW_CLOSING_GRACE_MS', () => {
  it('is the product value: one minute for the closing phrase to arrive', () => {
    expect(INTERVIEW_CLOSING_GRACE_MS).toBe(60_000)
  })
})
