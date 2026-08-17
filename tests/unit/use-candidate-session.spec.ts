/**
 * useCandidateSession — unit tests (Task 1.1 RED / candidate-session-auth D2)
 *
 * Coverage targets:
 *  - store(accessToken) decodes the JWT claims (no signature verification — the
 *    server re-validates on every call) and persists { accessToken, exp,
 *    candidateRef, projectId } to localStorage
 *  - read() returns the stored session when unexpired
 *  - read() with nothing stored → null
 *  - read() purges and returns null when the stored `exp` has already passed,
 *    with NO network call (there is nothing to call — this is the point)
 *  - clear() removes the stored session
 *  - a malformed token passed to store() does not persist a broken session
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useCandidateSession } from '~/app/composables/useCandidateSession'

// ---------------------------------------------------------------------------
// JWT fixture builder — base64url-encodes a fake header/payload; the
// signature segment is never verified client-side (D2), so any placeholder
// third segment is valid input for these tests.
// ---------------------------------------------------------------------------

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function makeCandidateJwt(claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify(claims))
  return `${header}.${payload}.fake-signature`
}

const NOW_SECONDS = Math.floor(Date.now() / 1000)

function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    typ: 'candidate',
    candidate_ref: 'cand-001',
    project_id: 42,
    organization_id: 7,
    exp: NOW_SECONDS + 60 * 60, // 1h from now
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear()
})

describe('useCandidateSession', () => {
  describe('store() + read() round trip', () => {
    it('read() returns null when nothing is stored', () => {
      const { read } = useCandidateSession()
      expect(read()).toBeNull()
    })

    it('store() then read() returns the decoded, unexpired session', () => {
      const { store, read } = useCandidateSession()
      const token = makeCandidateJwt(validClaims())

      store(token)
      const session = read()

      expect(session).not.toBeNull()
      expect(session?.accessToken).toBe(token)
      expect(session?.candidateRef).toBe('cand-001')
      expect(session?.projectId).toBe(42)
      expect(session?.exp).toBe(NOW_SECONDS + 3600)
    })

    it('persists across separate useCandidateSession() calls (localStorage-backed, not in-memory)', () => {
      const first = useCandidateSession()
      first.store(makeCandidateJwt(validClaims({ candidate_ref: 'cand-persist' })))

      const second = useCandidateSession()
      expect(second.read()?.candidateRef).toBe('cand-persist')
    })
  })

  describe('purge on read when exp has passed', () => {
    it('an expired stored session is purged on read, returning null', () => {
      const { store, read } = useCandidateSession()
      const expiredToken = makeCandidateJwt(validClaims({ exp: NOW_SECONDS - 60 }))
      store(expiredToken)

      const session = read()

      expect(session).toBeNull()
      // Purged — the raw value is gone from storage, not just filtered on read.
      expect(localStorage.getItem('beai_candidate_session')).toBeNull()
    })

    it('a second read() after purge is still null (no resurrection)', () => {
      const { store, read } = useCandidateSession()
      store(makeCandidateJwt(validClaims({ exp: NOW_SECONDS - 1 })))

      read()
      expect(read()).toBeNull()
    })
  })

  describe('clear()', () => {
    it('removes a stored session', () => {
      const { store, read, clear } = useCandidateSession()
      store(makeCandidateJwt(validClaims()))
      expect(read()).not.toBeNull()

      clear()

      expect(read()).toBeNull()
      expect(localStorage.getItem('beai_candidate_session')).toBeNull()
    })

    it('is a no-op when nothing is stored', () => {
      const { clear, read } = useCandidateSession()
      expect(() => clear()).not.toThrow()
      expect(read()).toBeNull()
    })
  })

  describe('malformed token handling', () => {
    it('store() with a non-JWT string does not persist a session', () => {
      const { store, read } = useCandidateSession()
      store('not-a-jwt-at-all')

      expect(read()).toBeNull()
    })

    it('store() with an unparseable payload segment does not persist a session', () => {
      const { store, read } = useCandidateSession()
      store('aGVhZGVy.not-valid-base64-json.sig')

      expect(read()).toBeNull()
    })
  })
})
