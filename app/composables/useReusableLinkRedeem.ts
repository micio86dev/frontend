/**
 * useReusableLinkRedeem — `POST /api/reusable-links/redeem` (reusable-interview-links, AD-16).
 *
 * Exchanges the reusable link token for a candidate access token. Every
 * successful call makes the api create a NEW anonymous visitor, so this is not
 * an idempotent read: the caller (the entry page) decides when a retry is
 * acceptable and passes the same token again.
 *
 * WHERE THE TOKEN MAY GO. It is a live, non-expiring credential, so:
 *
 * - it travels in the JSON BODY as `link_token` — never in the URL or a query
 *   string, where an access log would keep it, and never under a field named
 *   `token`, which the api's default guard parses before the controller runs;
 * - it is never logged and never part of a returned value. The outcomes below
 *   carry an access token, a redirect URL or nothing, and an error is mapped to
 *   one of them without being kept: `ofetch` stores the request it sent
 *   (`options.body`, the token) on the error it throws, so the error object is
 *   dropped here, not returned or rethrown for something else to log.
 *
 * This function NEVER throws. The api documents 200, 403, 404 and 429; every
 * other answer, and a request that never got one, is `failed` — retryable, and
 * never `not_found`, because a 5xx or a dropped connection says nothing about
 * the link.
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

export type RedeemOutcome =
  /** 200: a new visitor exists and this is its candidate token. */
  | { kind: 'ok'; accessToken: string }
  /** 404: unknown, malformed or disabled — the api gives one answer for all three. */
  | { kind: 'not_found' }
  /** 403: the link is valid but the project is not open. `redirectUrl` is the project's, when it has one. */
  | { kind: 'forbidden'; redirectUrl: string | null }
  /** 429: too many attempts. Retryable; says nothing about the link. */
  | { kind: 'busy' }
  /** 5xx, an unexpected status, a malformed 200 or no response at all. Retryable. */
  | { kind: 'failed' }

export interface UseReusableLinkRedeemReturn {
  redeem(linkToken: string): Promise<RedeemOutcome>
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

function outcomeFor(err: unknown): RedeemOutcome {
  switch (readStatus(err)) {
    case 404:
      return { kind: 'not_found' }
    case 403:
      return { kind: 'forbidden', redirectUrl: readRedirectUrl(err) }
    case 429:
      return { kind: 'busy' }
    default:
      return { kind: 'failed' }
  }
}

export function useReusableLinkRedeem(): UseReusableLinkRedeemReturn {
  async function redeem(linkToken: string): Promise<RedeemOutcome> {
    const body: RedeemBody = { link_token: linkToken }

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
