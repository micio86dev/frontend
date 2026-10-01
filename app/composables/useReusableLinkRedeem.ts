/**
 * useReusableLinkRedeem — `POST /api/reusable-links/redeem`
 * (reusable-interview-links AD-16; reusable-link-visitor-identity VD-14).
 *
 * Exchanges the reusable link token, plus the name and email the visitor typed,
 * for a candidate access token. Every successful call makes the api create a NEW
 * visitor, so this is not an idempotent read: the caller (the entry page) decides
 * when a retry is acceptable and passes the same token and identity again.
 *
 * WHERE THE TOKEN AND THE IDENTITY MAY GO. The token is a live, non-expiring
 * credential and the name and email are personal data, so:
 *
 * - all three travel in the JSON BODY (`link_token`, `display_name`, `email`) —
 *   never in the URL or a query string, where an access log would keep them, and
 *   the token never under a field named `token`, which the api's default guard
 *   parses before the controller runs;
 * - none of them is ever logged or part of a returned value. The outcomes below
 *   carry an access token, a redirect URL, field NAMES or nothing, and an error is
 *   mapped to one of them without being kept: `ofetch` stores the request it sent
 *   (`options.body`: the token, the name and the email) on the error it throws, so
 *   the error object is dropped here, not returned or rethrown for something else
 *   to log. A 422 keeps only which of the two known fields the api named, never
 *   its message text: the page shows its own localized copy.
 *
 * This function NEVER throws. The api documents 200, 403, 404, 409, 422 and 429;
 * every other answer, and a request that never got one, is `failed` — retryable,
 * and never `not_found`, because a 5xx or a dropped connection says nothing about
 * the link. A 422 that names no known field and a 409 that is not the documented
 * `duplicate_enrolment` are also `failed`, never a silent no-op and never a claim
 * the address is taken.
 *
 * Types come from the generated client (`bun run codegen`), never by hand.
 */

import { $fetch } from 'ofetch'
import { apiUrl } from '~/app/utils/api-url'
import type { operations } from '~~/types/api'

type RedeemOperation = operations['reusableLinkRedeem.redeem']
type RedeemBody = RedeemOperation['requestBody']['content']['application/json']
type RedeemResponse = RedeemOperation['responses'][200]['content']['application/json']
type RedeemForbidden = RedeemOperation['responses'][403]['content']['application/json']

/** What the visitor typed, already trimmed by the form. Held in memory only. */
export interface VisitorIdentityInput {
  displayName: string
  email: string
}

/** The two body fields a 422 can name: the only ones the page maps onto a form field. */
export type RedeemInvalidField = 'display_name' | 'email'

const INVALID_FIELDS: readonly RedeemInvalidField[] = ['display_name', 'email']

/** The 409 body message the api documents for an address already enrolled in the project. */
const DUPLICATE_ENROLMENT = 'duplicate_enrolment'

export type RedeemOutcome =
  /** 200: a new visitor exists and this is its candidate token. */
  | { kind: 'ok'; accessToken: string }
  /** 422: the api refused the name and/or email. Field names only, never its message. */
  | { kind: 'invalid'; fields: RedeemInvalidField[] }
  /** 409: this email is already enrolled in the link's project. Nothing was created, nothing resumed. */
  | { kind: 'duplicate' }
  /** 404: unknown, malformed or disabled — the api gives one answer for all three. */
  | { kind: 'not_found' }
  /** 403: the link is valid but the project is not open. `redirectUrl` is the project's, when it has one. */
  | { kind: 'forbidden'; redirectUrl: string | null }
  /** 429: too many attempts. Retryable; says nothing about the link. */
  | { kind: 'busy' }
  /** 5xx, an unexpected status, a malformed 200 or no response at all. Retryable. */
  | { kind: 'failed' }

export interface UseReusableLinkRedeemReturn {
  redeem(linkToken: string, identity: VisitorIdentityInput): Promise<RedeemOutcome>
}

function readStatus(err: unknown): unknown {
  return (err as Record<string, unknown>)?.status ?? (err as Record<string, unknown>)?.statusCode
}

/**
 * The 403 body carries `redirect_url` — nullable — on EVERY 403 (the same
 * uniform shape as the single-use exchange, so no gate is disclosed). Read
 * defensively: a body that is absent or shaped otherwise degrades to null.
 */
function readRedirectUrl(err: unknown): string | null {
  const data = (err as Record<string, unknown>)?.data as Partial<RedeemForbidden> | undefined

  return typeof data?.redirect_url === 'string' ? data.redirect_url : null
}

/**
 * Which of the two known fields a 422 names, read from `errors` and nothing else.
 * Empty when the body is absent, shaped otherwise, or names only keys the form has
 * no field for (the page treats that as a retryable failure).
 */
function readInvalidFields(err: unknown): RedeemInvalidField[] {
  const data = (err as Record<string, unknown>)?.data as Record<string, unknown> | undefined
  const errors = data?.errors

  if (errors === null || typeof errors !== 'object' || Array.isArray(errors)) {
    return []
  }

  return INVALID_FIELDS.filter((field) => field in errors)
}

function readMessage(err: unknown): unknown {
  return ((err as Record<string, unknown>)?.data as Record<string, unknown> | undefined)?.message
}

function outcomeFor(err: unknown): RedeemOutcome {
  switch (readStatus(err)) {
    case 404:
      return { kind: 'not_found' }
    case 403:
      return { kind: 'forbidden', redirectUrl: readRedirectUrl(err) }
    case 409:
      return readMessage(err) === DUPLICATE_ENROLMENT ? { kind: 'duplicate' } : { kind: 'failed' }
    case 422: {
      const fields = readInvalidFields(err)

      return fields.length > 0 ? { kind: 'invalid', fields } : { kind: 'failed' }
    }
    case 429:
      return { kind: 'busy' }
    default:
      return { kind: 'failed' }
  }
}

export function useReusableLinkRedeem(): UseReusableLinkRedeemReturn {
  async function redeem(linkToken: string, identity: VisitorIdentityInput): Promise<RedeemOutcome> {
    const body: RedeemBody = {
      link_token: linkToken,
      display_name: identity.displayName,
      email: identity.email,
    }

    try {
      const response = await $fetch<RedeemResponse | null>(apiUrl('/reusable-links/redeem'), {
        method: 'POST',
        body,
      })

      const accessToken = response?.access_token

      // A 200 without a usable token is the api misbehaving, not a visitor
      // worth sending on to a session route that will refuse them.
      return typeof accessToken === 'string' && accessToken !== ''
        ? { kind: 'ok', accessToken }
        : { kind: 'failed' }
    } catch (err) {
      return outcomeFor(err)
    }
  }

  return { redeem }
}
