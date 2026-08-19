import { describe, expect, it } from 'vitest'
import { createGtagStub } from '~/app/utils/analytics'

/**
 * The gtag stub is a CONTRACT with a third party, not an implementation detail.
 *
 * `gtag.js` identifies command tuples by checking that the value pushed onto
 * the dataLayer is an `arguments` object. A rest-parameter Array has an
 * identical TypeScript signature — `(...args: unknown[]) => void` — and is
 * treated as an inert data push instead of a command.
 *
 * That failure is silent and total: the script loads, the container registers
 * itself, the dataLayer fills with entries, and not one command ever executes.
 * No cookie, no beacon, no error. It cost a production deployment to find,
 * which is why it is pinned here rather than left to a code review to notice.
 */
describe('createGtagStub', () => {
  it('pushes an arguments object, not an Array', () => {
    const target: { dataLayer?: unknown[] } = { dataLayer: [] }

    createGtagStub(target)('config', 'G-TEST')

    expect(Object.prototype.toString.call(target.dataLayer?.[0])).toBe('[object Arguments]')
  })

  it('rejects the Array shape that gtag.js silently ignores', () => {
    const target: { dataLayer?: unknown[] } = { dataLayer: [] }

    createGtagStub(target)('js', new Date())

    expect(Array.isArray(target.dataLayer?.[0])).toBe(false)
  })

  it('preserves every argument in order', () => {
    const target: { dataLayer?: unknown[] } = { dataLayer: [] }
    const payload = { page_path: '/x' }

    createGtagStub(target)('event', 'page_view', payload)

    expect(Array.from(target.dataLayer?.[0] as ArrayLike<unknown>)).toEqual([
      'event',
      'page_view',
      payload,
    ])
  })

  it('does not throw when the dataLayer is absent', () => {
    const target: { dataLayer?: unknown[] } = {}

    expect(() => createGtagStub(target)('config', 'G-TEST')).not.toThrow()
  })
})
