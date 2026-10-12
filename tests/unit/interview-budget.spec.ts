/**
 * Once the whole interview's time is spent, the question in progress is allowed to
 * finish (the avatar speaks its closing phrase) and no further competency starts.
 */

import { describe, it, expect } from 'vitest'
import { directiveWithinBudget, INTERVIEW_CLOSING_GRACE_MS } from '~/app/utils/interview-budget'

describe('directiveWithinBudget', () => {
  it('keeps the server directive while the interview still has time', () => {
    expect(directiveWithinBudget('continue', false)).toBe('continue')
  })

  it('turns "continue" into "done" once the budget is spent, so no competency starts', () => {
    expect(directiveWithinBudget('continue', true)).toBe('done')
  })

  it.each(['pause', 'done', null] as const)(
    'leaves %s unchanged when the budget is spent',
    (directive) => {
      expect(directiveWithinBudget(directive, true)).toBe(directive)
    }
  )

  it('gives the closing phrase a bounded grace period', () => {
    expect(INTERVIEW_CLOSING_GRACE_MS).toBeGreaterThan(0)
    expect(INTERVIEW_CLOSING_GRACE_MS).toBeLessThanOrEqual(120_000)
  })
})
