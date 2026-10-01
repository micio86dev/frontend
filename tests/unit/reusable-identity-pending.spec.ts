/**
 * reusable-identity-pending — the non-secret "the identity form is on screen" flag
 * (reusable-link-visitor-identity VD-15, spec "Reusable Reload During The Form
 * Shows A Reopen State").
 *
 * The link token exists only in page memory, so a reload while the form is shown
 * loses it. To tell that visitor the truth ("open the link again") rather than the
 * untrue "this link is not valid", the page keeps ONE boolean in `sessionStorage`
 * (per tab, survives a reload, dies with the tab). What it must never hold is the
 * point of these tests: the flag is the single character `1`, so no token, no
 * name, no email, no URL and no timestamp can ride along.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IDENTITY_PENDING_KEY,
  clearIdentityPending,
  consumeIdentityPending,
  markIdentityPending,
} from '~/app/utils/reusable-identity-pending'

/** A Storage whose every method throws, as Safari private mode or a blocked-storage policy does. */
function throwingStorage(): Storage {
  const fail = (): never => {
    throw new DOMException('denied', 'SecurityError')
  }
  return {
    get length(): number {
      return fail()
    },
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  }
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('IDENTITY_PENDING_KEY', () => {
  it('is the documented key', () => {
    expect(IDENTITY_PENDING_KEY).toBe('beai_reusable_identity_pending')
  })
})

describe('markIdentityPending', () => {
  it("writes '1' under the key in sessionStorage, and nothing else anywhere", () => {
    markIdentityPending()

    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toBe('1')
    expect(sessionStorage.length).toBe(1)
    expect(localStorage.length).toBe(0)
  })

  it('stores only the single character 1: no token, name, email, URL or timestamp can ride along', () => {
    markIdentityPending()

    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toHaveLength(1)
  })

  it('is idempotent', () => {
    markIdentityPending()
    markIdentityPending()

    expect(sessionStorage.length).toBe(1)
    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toBe('1')
  })
})

describe('consumeIdentityPending', () => {
  it('returns true for the flag and REMOVES it, so a second reload cannot reuse it', () => {
    markIdentityPending()

    expect(consumeIdentityPending()).toBe(true)
    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toBeNull()
    expect(consumeIdentityPending()).toBe(false)
  })

  it('returns false when there is no flag', () => {
    expect(consumeIdentityPending()).toBe(false)
  })

  it.each(['0', 'true', 'yes', '', '11', ' 1', '1 '])(
    'returns false for the value %j: only the exact character 1 counts',
    (value) => {
      sessionStorage.setItem(IDENTITY_PENDING_KEY, value)

      expect(consumeIdentityPending()).toBe(false)
    }
  )

  it('removes a foreign value too, so a stale or odd value does not linger', () => {
    sessionStorage.setItem(IDENTITY_PENDING_KEY, 'something-else')

    consumeIdentityPending()

    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toBeNull()
  })

  it('ignores the same key in localStorage', () => {
    localStorage.setItem(IDENTITY_PENDING_KEY, '1')

    expect(consumeIdentityPending()).toBe(false)
  })
})

describe('clearIdentityPending', () => {
  it('removes the flag', () => {
    markIdentityPending()

    clearIdentityPending()

    expect(sessionStorage.getItem(IDENTITY_PENDING_KEY)).toBeNull()
  })

  it('is a no-op when there is no flag', () => {
    expect(() => clearIdentityPending()).not.toThrow()
  })

  it('leaves every other key alone', () => {
    sessionStorage.setItem('other', 'x')
    markIdentityPending()

    clearIdentityPending()

    expect(sessionStorage.getItem('other')).toBe('x')
  })
})

describe('a storage that throws degrades instead of crashing the page', () => {
  it('markIdentityPending does not throw', () => {
    expect(() => markIdentityPending(throwingStorage())).not.toThrow()
  })

  it('consumeIdentityPending returns false and does not throw', () => {
    expect(consumeIdentityPending(throwingStorage())).toBe(false)
  })

  it('clearIdentityPending does not throw', () => {
    expect(() => clearIdentityPending(throwingStorage())).not.toThrow()
  })

  it('degrades when sessionStorage itself is unreachable (the default argument)', () => {
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })

    expect(() => markIdentityPending()).not.toThrow()
    expect(consumeIdentityPending()).toBe(false)
    expect(() => clearIdentityPending()).not.toThrow()
  })
})
