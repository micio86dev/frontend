/**
 * The suggested answer length: the interview's server-stated time split evenly across
 * every scripted primary question. Guidance only; a missing input means no budget.
 */

import { describe, it, expect } from 'vitest'
import { ANSWER_BUDGET_FRACTIONS, answerBudget, formatBudgetTime } from '~/app/utils/answer-budget'

describe('answerBudget', () => {
  it('splits 1200 s over 6 primaries into max 200, min 50, ideal 75 to 150', () => {
    expect(answerBudget(1200, 6)).toEqual({ min: 50, idealFrom: 75, idealTo: 150, max: 200 })
  })

  it('floors the max and rounds the other thresholds to whole seconds (1210 s over 6)', () => {
    expect(answerBudget(1210, 6)).toEqual({ min: 50, idealFrom: 75, idealTo: 151, max: 201 })
  })

  it('exposes the owner-decided fractions', () => {
    expect(ANSWER_BUDGET_FRACTIONS).toEqual({ min: 0.25, idealFrom: 0.375, idealTo: 0.75 })
  })

  it('keeps a budget when the max is exactly 1 second', () => {
    expect(answerBudget(6, 6)).toEqual({ min: 0, idealFrom: 0, idealTo: 1, max: 1 })
  })

  it.each([
    ['a zero primary total', 1200, 0],
    ['a negative primary total', 1200, -3],
    ['a zero interview limit', 0, 6],
    ['a negative interview limit', -1200, 6],
    ['a missing interview limit (null)', null, 6],
    ['a missing interview limit (undefined)', undefined, 6],
    ['a missing primary total (undefined)', 1200, undefined],
    ['a missing primary total (null)', 1200, null],
    ['a NaN interview limit', Number.NaN, 6],
    ['a NaN primary total', 1200, Number.NaN],
    ['an infinite interview limit', Number.POSITIVE_INFINITY, 6],
    ['an infinite primary total', 1200, Number.POSITIVE_INFINITY],
    ['a max below one second (5 s over 10)', 5, 10],
  ])('has no budget for %s', (_label, limit, total) => {
    expect(answerBudget(limit, total)).toBeNull()
  })

  it('never treats the 300 s countdown fallback as an input: callers pass the server value or null', () => {
    // The client seeds its countdown at 300 s before /start states the limit. The
    // not-yet-stated limit is passed as null and must yield no budget, not 300 / total.
    expect(answerBudget(null, 6)).toBeNull()
  })
})

describe('formatBudgetTime', () => {
  it.each([
    [0, '0:00'],
    [50, '0:50'],
    [60, '1:00'],
    [75, '1:15'],
    [180, '3:00'],
    [200, '3:20'],
    [240, '4:00'],
    [3725, '62:05'],
  ])('writes %s s as %s (minutes unpadded, never wrapped at 60)', (seconds, expected) => {
    expect(formatBudgetTime(seconds)).toBe(expected)
  })

  it.each([-5, Number.NaN, Number.POSITIVE_INFINITY])('reads %s as 0:00', (seconds) => {
    expect(formatBudgetTime(seconds)).toBe('0:00')
  })

  it('drops a fraction rather than rounding up', () => {
    expect(formatBudgetTime(59.9)).toBe('0:59')
  })
})
