/**
 * Client-side validation for the identity a reusable-link visitor types
 * (DESIGN.md §16.19, spec "Reusable Identity Form Content And Validation").
 *
 * These checks are the form's FIRST line, not its authority. They exist so an
 * obviously wrong value never costs a request and so the visitor reads the app's
 * own localized message. The server's rule stays authoritative: a 422 maps back
 * onto the same fields, and the email shape check here is deliberately loose.
 *
 * Every function returns a message KEY (never a rendered string), so the form
 * resolves it through i18n and the same key set serves the server-error mapping.
 *
 * There is NO `maxlength` attribute anywhere on the form that uses these: a
 * browser truncates silently, which would store a different address than the one
 * the visitor typed. The limit is enforced here and the visitor is told.
 *
 * Pure and stateless: nothing here reads or writes storage, the URL or a log.
 */

/** The longest name or email, in code points. Matches the server's `max:255`. */
export const IDENTITY_MAX_LENGTH = 255

/**
 * The keys under `interview.reusable.identity.errors`. `nameInvalid` and
 * `emailInvalid` double as the mapping for a server 422 on that field, and
 * `emailTaken` is the 409 (a duplicate enrolment); the client never produces
 * those two itself from a value alone except `emailInvalid`.
 */
export type IdentityErrorKey =
  | 'nameRequired'
  | 'nameTooLong'
  | 'nameInvalid'
  | 'emailRequired'
  | 'emailInvalid'
  | 'emailTooLong'
  | 'emailTaken'

/** One or more characters, none of them whitespace or `@`. A single quantifier: linear. */
const NO_SPACE_OR_AT = /^[^\s@]+$/

/**
 * A loose shape check: exactly one `@`, no whitespace anywhere, a non-empty local
 * part and a domain holding at least one dot that has a character before AND after
 * it. It deliberately does not police the rest of the domain (`a@b..c` or `a@b.c.`
 * pass, as they do the one-line regex below): the server's rule is authoritative
 * and a 422 maps back onto the field.
 *
 * Written as a split plus two single-quantifier tests rather than the one-liner
 * `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, which accepts the same language but lets the
 * two adjacent `[^\s@]+` runs around the dot trade characters (polynomial
 * backtracking, flagged by `regexp/no-super-linear-backtracking`). The length cap
 * already bounds the input, but a guard that stays linear does not depend on it.
 */
function hasEmailShape(email: string): boolean {
  const parts = email.split('@')
  if (parts.length !== 2) return false
  const [local = '', domain = ''] = parts
  if (!NO_SPACE_OR_AT.test(local) || !NO_SPACE_OR_AT.test(domain)) return false
  // First dot that is not the first character; it must not be the last one either.
  const dot = domain.indexOf('.', 1)
  return dot !== -1 && dot < domain.length - 1
}

/** What the form sends: surrounding whitespace is never part of an identity. */
export function normalizeIdentityValue(value: string): string {
  return value.trim()
}

/**
 * Length in code points, not UTF-16 units: the server counts with `mb_strlen`, so
 * an emoji is one character to both sides.
 */
function codePointLength(value: string): number {
  return [...value].length
}

export function validateDisplayName(value: string): IdentityErrorKey | null {
  const name = normalizeIdentityValue(value)
  if (name === '') return 'nameRequired'
  if (codePointLength(name) > IDENTITY_MAX_LENGTH) return 'nameTooLong'
  return null
}

export function validateEmail(value: string): IdentityErrorKey | null {
  const email = normalizeIdentityValue(value)
  if (email === '') return 'emailRequired'
  if (codePointLength(email) > IDENTITY_MAX_LENGTH) return 'emailTooLong'
  if (!hasEmailShape(email)) return 'emailInvalid'
  return null
}
