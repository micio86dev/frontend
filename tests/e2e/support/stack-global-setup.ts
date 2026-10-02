import { describeReadiness } from './stack-readiness'

/**
 * Global setup of the opt-in real-stack tier (`BEAI_E2E_STACK=1`).
 *
 * Runs once, before any browser starts: liveness (`/api/health`), then readiness
 * (`/api/health/ready`, which fails on pending migrations or an unreachable
 * database). A stack that is not ready aborts the whole run with the fix command,
 * instead of letting a test discover it as a 500 halfway through a flow.
 */

export const DEFAULT_API_URL = 'http://localhost:8000'

async function probe(url: string): Promise<{ status: number | undefined; body: string }> {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })

    return { status: response.status, body: await response.text() }
  } catch {
    return { status: undefined, body: '' }
  }
}

export default async function globalSetup(): Promise<void> {
  const origin = (process.env['BEAI_E2E_API_URL'] ?? DEFAULT_API_URL).replace(/\/+$/, '')

  const liveness = await probe(`${origin}/api/health`)

  if (liveness.status !== 200) {
    // Only "nothing answered" has a readiness-style fix; any other liveness
    // answer means something other than the api is listening on that origin.
    const detail =
      liveness.status === undefined
        ? describeReadiness(undefined, '').message
        : `Expected HTTP 200 from /api/health, got ${liveness.status}. Check BEAI_E2E_API_URL and \`task stack:check\`.`

    throw new Error(`Real-stack e2e aborted (${origin}/api/health): ${detail}`)
  }

  const readiness = await probe(`${origin}/api/health/ready`)
  const verdict = describeReadiness(readiness.status, readiness.body)

  if (!verdict.ok) {
    throw new Error(`Real-stack e2e aborted (${origin}/api/health/ready): ${verdict.message}`)
  }
}
