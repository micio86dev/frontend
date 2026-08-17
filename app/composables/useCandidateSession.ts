/**
 * useCandidateSession — candidate JWT persistence (D2).
 *
 * The candidate JWT is persisted in `localStorage`, bounded by the interview's
 * lifecycle rather than the browser's: callers clear it on `done`, on
 * `terminal`, on any `401`, and immediately before an exit/error redirect
 * fires (D2). A stored session whose `exp` claim has already passed is purged
 * on read, so an abandoned session self-cleans on next load without a
 * network round-trip.
 *
 * `store()` decodes the token's claims client-side to populate `exp`,
 * `candidateRef`, and `projectId` — this is NOT a signature verification.
 * The server re-validates the signature on every authenticated call; reading
 * unverified claims here only answers "may I reuse what I already hold."
 *
 * No other module may read or write the candidate token directly — every
 * caller goes through this composable's store/read/clear surface.
 */

import { decodeJwtPayload } from '~/app/utils/jwt-decode'

const STORAGE_KEY = 'beai_candidate_session'

export interface CandidateSession {
  accessToken: string
  exp: number
  candidateRef: string
  projectId: number
}

export interface UseCandidateSessionReturn {
  /** Purges and returns null when `exp` has passed. Never returns an expired session. */
  read(): CandidateSession | null
  /** Decodes claims from the JWT payload; no signature verification (server re-validates). */
  store(accessToken: string): void
  clear(): void
}

function hasLocalStorage(): boolean {
  return typeof localStorage !== 'undefined'
}

export function useCandidateSession(): UseCandidateSessionReturn {
  function read(): CandidateSession | null {
    if (!hasLocalStorage()) return null

    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null

    let parsed: CandidateSession
    try {
      parsed = JSON.parse(raw) as CandidateSession
    } catch {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }

    if (typeof parsed.exp !== 'number' || parsed.exp * 1000 <= Date.now()) {
      // Purged on read — self-cleans without a network round-trip.
      localStorage.removeItem(STORAGE_KEY)
      return null
    }

    return parsed
  }

  function store(accessToken: string): void {
    if (!hasLocalStorage()) return

    const claims = decodeJwtPayload(accessToken)
    if (!claims) return // malformed token — nothing safe to persist

    const exp = typeof claims['exp'] === 'number' ? (claims['exp'] as number) : null
    if (exp === null) return // no exp claim — cannot bound the session lifecycle

    const candidateRef = typeof claims['candidate_ref'] === 'string' ? claims['candidate_ref'] : ''
    const projectId = typeof claims['project_id'] === 'number' ? claims['project_id'] : 0

    const session: CandidateSession = { accessToken, exp, candidateRef, projectId }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
  }

  function clear(): void {
    if (!hasLocalStorage()) return
    localStorage.removeItem(STORAGE_KEY)
  }

  return { read, store, clear }
}
