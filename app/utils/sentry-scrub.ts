import { redactAnalyticsPath } from '~/app/utils/analytics-path'

/**
 * Strips candidate data from Sentry events and breadcrumbs before they leave
 * the browser (C13, task 5.1 — Nuxt half).
 *
 * Mirrors `api/app/Support/Observability/SentryScrubber.php`'s discipline and,
 * where a leak class exists on both sides, its exact denylist — the api half
 * already decided this, and the point is for this half to agree with it, not
 * invent a second convention.
 *
 * `sendDefaultPii: false` (set in `sentry.client.config.ts` and
 * `sentry.server.config.ts`) stops Sentry attaching cookies, IP and header
 * context automatically. It does nothing about what THIS app hands Sentry
 * itself, and in the candidate-facing app that is substantial:
 *
 * - The interview entry link is a PATH SEGMENT — `/interview/<jwt>` — and
 *   Sentry populates `event.request.url` from `window.location.href`
 *   automatically, `sendDefaultPii` or not.
 * - The SSO exchange that consumes that link sends the same token as a QUERY
 *   PARAMETER (`GET /sso/exchange?token=...`), which lands in fetch/XHR
 *   breadcrumbs' `data.url`.
 * - The candidate JWT, `candidate_ref` and interview transcript/answers can
 *   all be in scope of an exception thrown inside the interview flow, and
 *   Sentry serializes whatever local variables a manual `captureException`
 *   call was given as `extra`/`contexts`.
 *
 * So this scrubs by KEY at any depth (candidate content, tokens, secrets)
 * AND by URL SHAPE (the entry-link token specifically) — two different leak
 * classes, both closed by this one module.
 */

/**
 * Structural shapes rather than the SDK's own `Event`/`Breadcrumb` types.
 *
 * `@sentry/nuxt`'s exact types are a moving target across versions and differ
 * subtly between its client (`@sentry/vue`) and server (`@sentry/node`)
 * builds. This module scrubs a handful of well-known fields on plain objects
 * — it does not need the SDK's full type surface to do that safely, and
 * pinning to a minimal local shape means a Sentry version bump cannot change
 * what this file compiles against. `sentry.client.config.ts` and
 * `sentry.server.config.ts` are the only places that talk to the real SDK
 * types, at the `Sentry.init()` call site.
 */
export interface ScrubbableRequest {
  url?: string
  query_string?: unknown
  cookies?: unknown
  headers?: unknown
  [key: string]: unknown
}

export interface ScrubbableBreadcrumb {
  message?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

export interface ScrubbableEvent {
  request?: ScrubbableRequest
  extra?: Record<string, unknown>
  contexts?: Record<string, unknown>
  breadcrumbs?: ScrubbableBreadcrumb[]
  user?: unknown
  [key: string]: unknown
}

const DENIED_KEYS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'key_hash',
  'password',
  'secret',
  'webhook_secret',
  'authorization',
  'cookie',
  // Candidate-identifying and candidate-authored content — same set the api
  // scrubber denies, so an object that crosses the wire between the two apps
  // is treated identically on both sides.
  'candidate_ref',
  'display_name',
  'transcript',
  'prompt',
  'answer',
  'excerpt',
  'excerpts',
  'utterance',
  'content',
  'payload',
])

const REDACTED = '[redacted]'

/**
 * `camelCase` -> `snake_case`, so a JS-native key (`candidateRef`,
 * `accessToken`) is checked against the same denylist as its API-shaped
 * counterpart (`candidate_ref`, `access_token`) without maintaining two
 * lists that can drift apart.
 */
function toSnakeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

function isDeniedKey(key: string): boolean {
  const normalized = toSnakeKey(key)

  if (DENIED_KEYS.has(normalized)) {
    return true
  }

  // Conventions, so a newly-named field (`sessionToken`, `signing_secret`,
  // `providerApiKey`) is covered without an edit here — enumerating every
  // future field name is impossible; a naming convention is not.
  return (
    normalized.endsWith('_token') || normalized.endsWith('_secret') || normalized.endsWith('_key')
  )
}

function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubValue)
  }

  if (value !== null && typeof value === 'object') {
    return scrubRecord(value as Record<string, unknown>)
  }

  return value
}

/**
 * A denylist, deliberately, not an allowlist: an allowlist would silently
 * drop the diagnostic context that makes an error report useful, and an
 * unusable error reporter gets switched off — which is a worse outcome than
 * a scrubbed one.
 */
function scrubRecord(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(data)) {
    out[key] = isDeniedKey(key) ? REDACTED : scrubValue(value)
  }

  return out
}

/**
 * Redacts the candidate's entry-link token wherever it appears in a URL,
 * reusing `redactAnalyticsPath` rather than re-deriving the interview-token
 * pattern a second time in this codebase.
 *
 * `redactAnalyticsPath` already encodes both halves of what this needs:
 * `/interview/<token>` (and its locale-prefixed form) collapses to
 * `/interview/:token`, and the query string / fragment — where the SSO
 * exchange's `?token=...` travels — is dropped WHOLESALE rather than
 * filtered by an allowlist of "safe" parameter names, which is a promise no
 * one could keep.
 */
export function redactUrl(url: string | undefined): string | undefined {
  if (url === undefined || url === '') {
    return url
  }

  try {
    const parsed = new URL(url)

    return `${parsed.protocol}//${parsed.host}${redactAnalyticsPath(parsed.pathname)}`
  } catch {
    // Not an absolute URL (Vue Router breadcrumbs pass bare paths such as
    // `/interview/xyz`) — treat the whole string as a path.
    return redactAnalyticsPath(url)
  }
}

export function scrubBreadcrumb(breadcrumb: ScrubbableBreadcrumb): ScrubbableBreadcrumb {
  const next: ScrubbableBreadcrumb = { ...breadcrumb }

  if (next.data) {
    const data = scrubRecord(next.data)

    for (const urlKey of ['url', 'to', 'from'] as const) {
      if (typeof data[urlKey] === 'string') {
        data[urlKey] = redactUrl(data[urlKey])
      }
    }

    next.data = data
  }

  if (typeof next.message === 'string') {
    next.message = redactUrl(next.message)
  }

  return next
}

export function scrubSentryEvent(event: ScrubbableEvent): ScrubbableEvent {
  const next: ScrubbableEvent = { ...event }

  if (next.request) {
    const { url, ...rest } = next.request

    next.request = {
      ...rest,
      url: redactUrl(url),
      // Query string, cookies and headers are dropped WHOLESALE rather than
      // filtered — the same reasoning as the URL query string above. None of
      // these should be populated with `sendDefaultPii: false`, but this
      // scrubber does not trust that a future SDK version keeps it that way.
      query_string: undefined,
      cookies: undefined,
      headers: undefined,
    }
  }

  if (next.extra) {
    next.extra = scrubRecord(next.extra)
  }

  if (next.contexts) {
    next.contexts = scrubRecord(next.contexts)
  }

  if (next.breadcrumbs) {
    next.breadcrumbs = next.breadcrumbs.map(scrubBreadcrumb)
  }

  // User context is dropped entirely rather than scrubbed field by field —
  // same call the api scrubber makes, for the same reason. A candidate is
  // not a Sentry "user", and there is no case where keeping it is worth the
  // risk of a future Sentry version adding a field this module has never
  // heard of.
  next.user = undefined

  return next
}
