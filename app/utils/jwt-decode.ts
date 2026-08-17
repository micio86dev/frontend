/**
 * jwt-decode — decode a JWT payload WITHOUT verifying its signature.
 *
 * Shared by `useCandidateSession` (decoding the candidate JWT to populate
 * `exp`/`candidateRef`/`projectId`) and the interview entry route (decoding
 * the sso-link JWT's `candidate_ref`/`project_id` claims to answer "may I
 * reuse the session I already hold" — D1). Neither caller verifies the
 * signature; the server re-validates it on every authenticated call.
 */

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const rawPayload = parts[1]
  if (!rawPayload) return null

  try {
    const base64 = rawPayload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
    const json =
      typeof atob === 'function'
        ? decodeURIComponent(
            atob(padded)
              .split('')
              .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
              .join('')
          )
        : Buffer.from(padded, 'base64').toString('utf-8')
    const parsed: unknown = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}
