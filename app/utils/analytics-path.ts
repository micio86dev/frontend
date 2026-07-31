/**
 * Makes a route safe to hand to a third-party analytics sink (C13, task 5.4).
 *
 * The candidate's magic-link token is a PATH SEGMENT — `/interview/<jwt>` — and
 * GA4's default page_view sends `page_location` and `page_path` verbatim. Wiring
 * analytics without this module posts a live credential to Google: one that
 * grants whoever reads it entry to that candidate's interview.
 *
 * So neither of these functions is a formatting nicety. They are the boundary
 * between "we measure how many people finish an interview" and "we hand out
 * keys, in bulk, to a system nobody at BEAI can audit or purge."
 */

/**
 * Pages whose URLs or DOM contents must never reach an analytics sink.
 *
 * The WHOLE interview branch, not the token page alone. `done`, `error` and
 * `terminal` carry no transcript, but a per-page allowlist is a decision that
 * has to be remade correctly every single time a page is added — and the cost
 * of forgetting once is a session replay of somebody's assessment.
 */
const UNSAFE_PREFIX = /^\/(?:[a-z]{2}\/)?interview(?:\/|$)/

/**
 * The token segment: `/interview/<something>`, where <something> is not one of
 * the named pages.
 *
 * Anchored on an optional two-letter locale prefix because i18n runs
 * `prefix_except_default`, so every page also exists at `/en/…`. A rule that
 * only knew the unprefixed form would leak every token belonging to an
 * English-language project while the Italian ones looked correctly redacted —
 * which is worse than not redacting at all, because it looks like it works.
 */
const NAMED_INTERVIEW_PAGES = new Set(['done', 'error', 'terminal'])

/**
 * Strips a route down to something that identifies the PAGE and nothing else.
 *
 * Query string and fragment are removed WHOLESALE rather than filtered. Query
 * parameters are where tokens, candidate references and exit-redirect URLs
 * travel, and an allowlist of safe parameter names would be a promise about
 * every parameter anyone adds in future — a promise no one can keep.
 */
export function redactAnalyticsPath(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0] ?? ''
  const normalized = withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery

  const match = normalized.match(/^(\/(?:[a-z]{2}\/)?interview)\/([^/]+)$/)

  if (match && !NAMED_INTERVIEW_PAGES.has(match[2] ?? '')) {
    return `${match[1]}/:token`
  }

  return normalized === '' ? '/' : normalized
}

/**
 * Whether a session-replay recorder may run on this route at all.
 *
 * Clarity records the DOM. On the interview page the DOM IS the interview: the
 * question being asked, the live transcript of what the candidate just said,
 * and the video surface. Replaying that means a third party holds a recording
 * of an assessment the candidate believes is between them and one employer.
 *
 * Redacting the URL does nothing about this — it is a separate control for a
 * separate leak, which is why it is a separate function.
 */
export function isAnalyticsSafeRoute(path: string): boolean {
  const withoutQuery = path.split(/[?#]/)[0] ?? ''

  return !UNSAFE_PREFIX.test(withoutQuery)
}
