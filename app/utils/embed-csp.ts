/**
 * embed-csp — pure functions that turn an organization's `allowed_domains`
 * into the response headers `/embed/{token}` must send (public-api SPEC §4.4):
 *
 *   Content-Security-Policy: frame-ancestors <org allowed domains>
 *   Permissions-Policy: camera=(self), microphone=(self)
 *
 * Kept pure and framework-free (no Nitro/h3 imports) so the header-building
 * logic is testable with plain Vitest, independent of the Nitro wiring in
 * `server/middleware/embed-csp.ts`, which is the only caller.
 *
 * FAIL-SAFE DEFAULT: `buildFrameAncestorsHeader([])` (and every caller passing
 * no domains — an unresolved token, a network failure reaching the api, an
 * organization with no configured domains) returns `frame-ancestors 'none'`,
 * the MAXIMALLY RESTRICTIVE value — refuses ALL framing, including same-origin.
 * Omitting the header entirely would fall back to the browser's default (no
 * restriction at all), which is exactly the wrong direction for a failure
 * mode: a broken lookup must never silently become "allow everything". The
 * page's own token-exchange error handling (`app/pages/embed/[token].vue`)
 * is what surfaces the real error to the candidate; this header's only job is
 * to not make the iframe embeddable somewhere it should not be.
 */

/** SPEC.md §4.4 — fixed camera/microphone Permissions-Policy for every embed response. */
export const EMBED_PERMISSIONS_POLICY = 'camera=(self), microphone=(self)'

/**
 * A domain from `organizations.allowed_domains` (bare hostnames, e.g.
 * `"acme.example"` — see `api/app/PublicApi/Serializers/OrganizationSerializer.php`)
 * as a `frame-ancestors` source expression. `frame-ancestors` accepts bare
 * hosts directly (no scheme required, unlike `frame-src`), but a caller-supplied
 * value could still carry incidental whitespace or an accidental scheme
 * prefix from upstream data entry — stripped defensively rather than trusted
 * verbatim, since this string is about to become part of a security header.
 */
function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
}

/**
 * Strict host[:port] shape. Anything else (`;`, spaces, commas, paths,
 * wildcards) is dropped rather than spliced into the header, since a `;` would
 * let a bad `allowed_domains` entry inject extra CSP directives.
 */
const SAFE_HOST_SOURCE_RE =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i

function isSafeHostSource(domain: string): boolean {
  return SAFE_HOST_SOURCE_RE.test(domain)
}

/**
 * Builds the `Content-Security-Policy` header VALUE (not the header name) for
 * `/embed/{token}`. `'self'` is included alongside the organization's own
 * domains — SPEC §4.4 names only "org allowed domains", but the hosted page
 * (`/i/{token}`) and other same-origin BEAI surfaces embedding their own
 * `/embed/{token}` iframe (e.g. a preview in the backoffice) are a legitimate
 * same-origin case `allowed_domains` was never meant to have to enumerate.
 * An empty/unresolvable list still safely reduces to a single `'none'` frame-
 * ancestors source below — see this module's own fail-safe doc.
 */
export function buildFrameAncestorsHeader(allowedDomains: readonly string[]): string {
  const normalized = allowedDomains.map(normalizeDomain).filter(isSafeHostSource)

  if (normalized.length === 0) {
    return "frame-ancestors 'none'"
  }

  return `frame-ancestors 'self' ${normalized.join(' ')}`
}

/** The literal `Permissions-Policy` value — a constant, not a function, since SPEC §4.4 pins it. */
export function buildPermissionsPolicyHeader(): string {
  return EMBED_PERMISSIONS_POLICY
}

/**
 * Whether `hostname` (a `postMessage` event's `new URL(event.origin).hostname`,
 * e.g. `"acme.example"`) is one of `allowedDomains` — exact match only, case-
 * insensitive, NO implicit subdomain wildcarding (mirrors the api's own
 * `allowed_domains` semantics: `"acme.example"` and `"hr.acme.example"` are
 * two distinct configured entries, never one implying the other).
 *
 * Used by `useEmbedBridge` (`app/composables/useEmbedBridge.ts`) to validate
 * an inbound host `postMessage` — the page-side counterpart of `@beai/embed`'s
 * own `event.origin !== this.embedOrigin` check, adapted because the IFRAME
 * (unlike the SDK) has no pre-configured `embedOrigin`; it learns its
 * organization's allowed origins from the SAME `allowed_domains` this
 * module's CSP header is built from.
 */
export function isHostnameAllowed(hostname: string, allowedDomains: readonly string[]): boolean {
  const normalizedHost = normalizeDomain(hostname).toLowerCase()
  if (!normalizedHost) return false
  return allowedDomains.some((domain) => normalizeDomain(domain).toLowerCase() === normalizedHost)
}
