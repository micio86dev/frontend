import { describe, it, expect } from 'vitest'
import { asCompetencyCode } from '~/utils/competency-codes'

describe('asCompetencyCode', () => {
  it.each(['INN', 'A', 'COL_2', 'X'.repeat(16), '0123', 'INNOVAZIONE'])('accepts %s', (raw) => {
    expect(asCompetencyCode(raw)).toBe(raw)
  })

  it.each([
    ['lowercase', 'inn'],
    ['mixed case', 'Inn'],
    ['empty', ''],
    ['17 characters', 'X'.repeat(17)],
    ['a space', 'IN N'],
    ['prose', 'Begin INN now.'],
    ['a newline', 'INN\n'],
    ['a hyphen', 'IN-N'],
  ])('rejects %s', (_label, raw) => {
    expect(asCompetencyCode(raw)).toBeNull()
  })
})
