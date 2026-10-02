/**
 * tests/e2e/support/stack-origin — the real-stack tier logs in as an admin and
 * writes a link plus a participant, so it must refuse any origin that is not the
 * developer's own machine. Only the PARSED hostname is compared, never the raw
 * string, so look-alike hosts and userinfo tricks cannot pass.
 */

import { describe, it, expect } from 'vitest'
import {
  assertLocalOrigin,
  resolveApiUrl,
  resolveStackUrl,
  DEFAULT_API_URL,
  DEFAULT_STACK_URL,
} from '../e2e/support/stack-origin'

describe('defaults', () => {
  it('fall back to the local stack when the variable is unset, empty or blank', () => {
    expect(resolveApiUrl({})).toBe(DEFAULT_API_URL)
    expect(resolveApiUrl({ BEAI_E2E_API_URL: '' })).toBe(DEFAULT_API_URL)
    expect(resolveApiUrl({ BEAI_E2E_API_URL: '   ' })).toBe(DEFAULT_API_URL)
    expect(resolveStackUrl({})).toBe(DEFAULT_STACK_URL)
    expect(resolveStackUrl({ BEAI_E2E_STACK_URL: ' ' })).toBe(DEFAULT_STACK_URL)
  })

  it('point at localhost', () => {
    expect(DEFAULT_API_URL).toBe('http://localhost:8000')
    expect(DEFAULT_STACK_URL).toBe('http://localhost:3000')
  })
})

describe('assertLocalOrigin accepts', () => {
  it.each([
    ['http://localhost', 'http://localhost'],
    ['http://localhost:8000', 'http://localhost:8000'],
    ['https://localhost:8443', 'https://localhost:8443'],
    ['http://127.0.0.1', 'http://127.0.0.1'],
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
    ['http://[::1]', 'http://[::1]'],
    ['http://[::1]:8000', 'http://[::1]:8000'],
  ])('%s', (input, expected) => {
    expect(assertLocalOrigin(input, 'X', {})).toBe(expected)
  })

  it('strips trailing slashes', () => {
    expect(assertLocalOrigin('http://localhost:8000///', 'X', {})).toBe('http://localhost:8000')
  })
})

describe('assertLocalOrigin rejects', () => {
  it.each([
    'https://api.prod.example',
    'http://localhost.evil.com',
    'http://127.0.0.1.evil.com',
    'http://127.0.0.1@evil.com',
    'http://evil.com#localhost',
    'http://evil.com/?h=localhost',
    'ftp://localhost',
    'not a url',
    'localhost:8000',
  ])('%s', (input) => {
    expect(() => assertLocalOrigin(input, 'BEAI_E2E_API_URL', {})).toThrow(/BEAI_E2E_API_URL/)
  })

  it('never prints credentials carried by the rejected url', () => {
    try {
      assertLocalOrigin('https://admin:hunter2@staging.example', 'X', {})
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2')
    }
  })

  it('names BEAI_E2E_ALLOW_NON_LOCAL as deliberate use only', () => {
    expect(() => assertLocalOrigin('https://api.prod.example', 'X', {})).toThrow(
      /BEAI_E2E_ALLOW_NON_LOCAL.*deliberate use only/s
    )
  })
})

describe('BEAI_E2E_ALLOW_NON_LOCAL', () => {
  it('lifts the guard only for exactly "1"', () => {
    expect(
      assertLocalOrigin('https://api.staging.example/', 'X', { BEAI_E2E_ALLOW_NON_LOCAL: '1' })
    ).toBe('https://api.staging.example')

    for (const value of ['true', '0', 'yes', ' 1', '']) {
      expect(() =>
        assertLocalOrigin('https://api.staging.example', 'X', { BEAI_E2E_ALLOW_NON_LOCAL: value })
      ).toThrow()
    }
  })

  it('still refuses text that is not a url', () => {
    expect(() => assertLocalOrigin('garbage', 'X', { BEAI_E2E_ALLOW_NON_LOCAL: '1' })).toThrow()
  })
})
