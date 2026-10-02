/**
 * Readiness verdict for the opt-in real-stack e2e tier (`BEAI_E2E_STACK=1`).
 *
 * The tier talks to the developer's live local stack, where the usual way to be
 * broken is code newer than the database schema. The api reports that on
 * `GET /api/health/ready` (200 `{"status":"ok"}`, or 503
 * `{"status":"down","reason":"pending_migrations"|"database_unavailable"}`); this
 * pure function turns that answer into a verdict whose message is the fix, so the
 * run stops before any browser starts instead of failing on a 500 mid-flow.
 *
 * It never echoes a raw response body: an unexpected answer may be an HTML error
 * page or carry data. Only a reason reduced to `[A-Za-z0-9_]`, 40 chars at most,
 * is repeated.
 *
 * Kept as an identical copy in the backoffice repo; the two repos share no code.
 */

export interface ReadinessVerdict {
  ok: boolean
  message: string
}

const MAX_REASON_LENGTH = 40

const NOT_RUNNING =
  'The stack is not running (nothing answered). Start it with `task up` or `docker compose up -d`, then re-run.'

const PENDING_MIGRATIONS =
  'The database schema is behind the code (pending migrations). Run `docker compose exec api php artisan migrate --force`, then re-run.'

const DATABASE_UNAVAILABLE =
  'The api cannot reach its database. Check postgres with `docker compose ps postgres` (and `docker compose logs postgres`), then re-run.'

const ENDPOINT_MISSING =
  'The api answered 404 on /api/health/ready: the running api image predates the readiness endpoint. Rebuild it with `docker compose build api && docker compose up -d api`, then re-run.'

function parseBody(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bodyText)

    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function sanitizeReason(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\W/g, '').slice(0, MAX_REASON_LENGTH) : ''
}

export function describeReadiness(
  httpStatus: number | undefined,
  bodyText: string
): ReadinessVerdict {
  if (httpStatus === undefined || httpStatus === 0) {
    return { ok: false, message: NOT_RUNNING }
  }

  const body = parseBody(bodyText)

  if (httpStatus === 200 && body?.['status'] === 'ok') {
    return { ok: true, message: 'The stack is ready.' }
  }

  if (httpStatus === 404) {
    return { ok: false, message: ENDPOINT_MISSING }
  }

  if (httpStatus === 503 && body?.['status'] === 'down') {
    const reason = body['reason']

    if (reason === 'pending_migrations') {
      return { ok: false, message: PENDING_MIGRATIONS }
    }

    if (reason === 'database_unavailable') {
      return { ok: false, message: DATABASE_UNAVAILABLE }
    }
  }

  const reason = sanitizeReason(body?.['reason'])
  const suffix = reason === '' ? '' : ` (reason: ${reason})`

  return {
    ok: false,
    message: `The api is not ready: /api/health/ready answered HTTP ${httpStatus}${suffix}. Run \`task stack:check\` for details.`,
  }
}
