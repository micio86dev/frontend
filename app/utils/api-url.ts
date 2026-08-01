/**
 * API URL builder — the single place that turns a relative API path into an
 * absolute URL against `runtimeConfig.public.apiBase`.
 *
 * CONTRACT (AGENTS.md, backoffice, docker-compose.yml, both Dockerfiles):
 * **`apiBase` ALREADY INCLUDES the `/api` suffix** (e.g. `http://api:8000/api`).
 * Call sites therefore pass API-relative paths WITHOUT `/api`:
 *
 *   apiUrl('/candidate/interview/start')  →  http://api:8000/api/candidate/interview/start
 *
 * This exists because eight hand-built template strings across four composables
 * each re-appended `/api` themselves. That was self-consistent only with the old
 * `.env.example` (base without the suffix) and produced `/api/api/...` — a hard
 * 404 with no CORS headers — under Docker, where the base carries the suffix.
 * Never rebuild these URLs by hand; always go through `apiUrl()`.
 */

/**
 * Join a base URL and a path, tolerating a trailing slash on the base and a
 * leading slash on the path (and their absence).
 *
 * Exported separately from `apiUrl` so the joining rules can be unit-tested
 * without a Nuxt runtime config in scope.
 */
export function joinApiUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '')
  const trimmedPath = path.replace(/^\/+/, '')

  if (!trimmedPath) return trimmedBase
  // An empty base yields a same-origin relative URL rather than `//path`,
  // which a browser would read as a protocol-relative host.
  return trimmedBase ? `${trimmedBase}/${trimmedPath}` : `/${trimmedPath}`
}

/**
 * Resolve an API-relative path (WITHOUT the `/api` prefix) against the
 * configured `apiBase`.
 */
export function apiUrl(path: string): string {
  const config = useRuntimeConfig()
  const base = String(config.public.apiBase ?? '')
  return joinApiUrl(base, path)
}
