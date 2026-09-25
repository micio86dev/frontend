/**
 * embed-csp — per-request `Content-Security-Policy: frame-ancestors` and
 * `Permissions-Policy` for `/embed/{token}` (public-api step 10, SPEC §4.4).
 *
 * WHY A NITRO MIDDLEWARE, NOT A `routeRules` HEADER
 * --------------------------------------------------
 * `nuxt.config.ts`'s `nitro.routeRules` headers are STATIC — fixed at
 * build/config time. `frame-ancestors` here must vary PER ORGANIZATION (each
 * org's own `allowed_domains`), which a static rule cannot express — so this
 * runs as a real per-request handler instead. Nitro MERGES matching route
 * rules (defu), so `/embed/**` still inherits `X-Frame-Options: DENY` from
 * the blanket `/**` rule; this handler removes it below.
 *
 * FAIL-SAFE DEFAULT
 * -----------------
 * Any failure resolving the token's organization — an unresolved/expired/
 * malformed token, `NUXT_API_ORIGIN` unset, or the api being unreachable —
 * resolves to an EMPTY domain list, which `buildFrameAncestorsHeader([])`
 * (see `app/utils/embed-csp.ts`) turns into `frame-ancestors 'none'`: the
 * MOST restrictive value, refusing all framing. This header's job is only to
 * never silently become "allow everything" on failure; the candidate-visible
 * error (an invalid/expired link) is `app/pages/embed/[token].vue`'s own
 * token-exchange error handling, not this middleware's concern.
 *
 * READ-ONLY LOOKUP, NOT `/embed/exchange`
 * ----------------------------------------
 * Calls `GET /api/embed/frame-policy` (`ExchangeController::framePolicy()`),
 * a route that NEVER consumes the session token — unlike `/embed/exchange`,
 * which the page itself calls later, exactly once, to mint the candidate
 * JWT. Calling the CONSUMING endpoint from here (which runs on every request
 * to this path, including a refresh) would burn the single-use token before
 * the candidate's own exchange ever runs.
 */

import { defineEventHandler, getRequestURL, removeResponseHeader, setResponseHeader } from 'h3'
import { $fetch } from 'ofetch'
import type { operations } from '../../types/api'
import { buildFrameAncestorsHeader, buildPermissionsPolicyHeader } from '../../app/utils/embed-csp'

const EMBED_PATH_RE = /^\/(?:en\/)?embed\/([^/]+)\/?$/

type FramePolicyResponse = Partial<
  operations['exchange.framePolicy']['responses'][200]['content']['application/json']
>

/**
 * Resolves the organization's `allowed_domains` for `token`, server-side.
 * NEVER throws — every failure mode (unset origin, network error, non-200,
 * malformed body) resolves to `[]`, which is this module's fail-safe input.
 */
async function resolveAllowedDomains(token: string, apiOrigin: string): Promise<string[]> {
  if (!apiOrigin || !token) return []

  try {
    const response = await $fetch<FramePolicyResponse>(
      `${apiOrigin.replace(/\/+$/, '')}/api/embed/frame-policy`,
      { method: 'GET', params: { token } }
    )
    const domains = response?.allowed_domains
    return Array.isArray(domains) ? domains.filter((d): d is string => typeof d === 'string') : []
  } catch {
    return []
  }
}

export default defineEventHandler(async (event) => {
  const { pathname } = getRequestURL(event)
  const match = EMBED_PATH_RE.exec(pathname)
  if (!match?.[1]) return

  let token = match[1]
  try {
    token = decodeURIComponent(token)
  } catch {
    // Malformed percent-encoding: keep the raw segment — the api rejects it and the header falls back to 'none'.
  }
  const apiOrigin = String(useRuntimeConfig(event).apiOrigin ?? '')

  // Set BOTH headers here, together — never split across this middleware and
  // a static `routeRules` entry for the same header name, which would leave
  // whichever mechanism runs last winning by accident rather than by design.
  setResponseHeader(event, 'Permissions-Policy', buildPermissionsPolicyHeader())
  // Nitro merges route rules with defu, so `/embed/**` inherits the blanket
  // `/**` rule's `X-Frame-Options: DENY`. Browsers ignore X-Frame-Options when
  // `frame-ancestors` is present, but relying on that is accidental; remove it.
  removeResponseHeader(event, 'X-Frame-Options')

  const allowedDomains = await resolveAllowedDomains(token, apiOrigin)
  setResponseHeader(event, 'Content-Security-Policy', buildFrameAncestorsHeader(allowedDomains))
})
