import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClarityStub } from '~/app/utils/analytics'

/**
 * Clarity's tag script CALLS `window.clarity` on its first line — it does not
 * define it. The official snippet creates a queue stub before injecting the
 * script, and that ordering is the contract:
 *
 *   c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments) }
 *
 * Injecting the tag without the stub produces `TypeError: a[c] is not a
 * function` inside a third-party script and nothing else — no failing build,
 * no visible symptom, and a recorder that never records. That was the state in
 * production, and it is the second time in this codebase that a rewritten
 * third-party snippet dropped its `arguments` queue.
 */
describe('createClarityStub', () => {
  let target: { clarity?: ((...args: unknown[]) => void) & { q?: unknown[] } }

  beforeEach(() => {
    target = {}
  })

  it('defines the function the tag script expects to call', () => {
    createClarityStub(target)

    expect(typeof target.clarity).toBe('function')
  })

  it('queues an arguments object, not an Array', () => {
    createClarityStub(target)

    target.clarity?.('metadata', { a: 1 })

    expect(Object.prototype.toString.call(target.clarity?.q?.[0])).toBe('[object Arguments]')
  })

  it('preserves every argument in order', () => {
    createClarityStub(target)

    target.clarity?.('set', 'key', 'value')

    expect(Array.from(target.clarity?.q?.[0] as ArrayLike<unknown>)).toEqual([
      'set',
      'key',
      'value',
    ])
  })

  it('does not replace an already-initialised clarity', () => {
    const existing = vi.fn()
    target.clarity = existing

    createClarityStub(target)

    expect(target.clarity).toBe(existing)
  })
})
