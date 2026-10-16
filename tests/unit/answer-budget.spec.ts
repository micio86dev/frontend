/**
 * The suggested answer length: the configured good-answer range (default 1:30 to 2:30) and a
 * bar scale that ends a third past the maximum. Guidance only; invalid input means no budget.
 */

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ANSWER_RANGE,
  answerBudget,
  answerRangeFrom,
  formatBudgetTime,
} from '~/app/utils/answer-budget'

describe('answerBudget', () => {
  it('is the range itself with a scale ending at max x 4/3 (90 to 150 ends at 200)', () => {
    expect(answerBudget(90, 150)).toEqual({ min: 90, max: 150, end: 200 })
  })

  it('rounds the scale end to a whole second (60 to 100 ends at 133)', () => {
    expect(answerBudget(60, 100)).toEqual({ min: 60, max: 100, end: 133 })
  })

  it.each([
    ['a missing min (null)', null, 150],
    ['a missing max (undefined)', 90, undefined],
    ['a zero min', 0, 150],
    ['a negative min', -5, 150],
    ['a NaN max', 90, Number.NaN],
    ['an infinite max', 90, Number.POSITIVE_INFINITY],
    ['min equal to max', 120, 120],
    ['min above max', 200, 150],
  ])('has no budget for %s', (_label, min, max) => {
    expect(answerBudget(min, max)).toBeNull()
  })
})

describe('answerRangeFrom', () => {
  it('keeps a valid range as stated', () => {
    expect(answerRangeFrom(60, 120)).toEqual({ min: 60, max: 120 })
  })

  it.each([
    [undefined, undefined],
    [null, 150],
    ['90', 150],
    [90.5, 150],
    [0, 150],
    [150, 90],
    [120, 120],
  ])('falls back to 90 and 150 for %s / %s', (min, max) => {
    expect(answerRangeFrom(min, max)).toEqual(DEFAULT_ANSWER_RANGE)
    expect(DEFAULT_ANSWER_RANGE).toEqual({ min: 90, max: 150 })
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
