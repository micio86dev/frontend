/**
 * Origin guard of the opt-in real-stack e2e tier.
 *
 * The tier sends an admin password to the api and writes a link plus a
 * participant (with an email) on it. A mistakenly exported `BEAI_E2E_API_URL`
 * would aim that at staging or production, so every origin is checked here, once,
 * and this module is the single source of the two default URLs.
 *
 * Only the PARSED hostname is compared (never a prefix, substring or regex over
 * the raw string), so `localhost.evil.com`, `127.0.0.1@evil.com` or
 * `evil.com#localhost` cannot pass. The message never prints the rejected URL's
 * credentials, path or query: only its host.
 */

export const DEFAULT_API_URL = 'http://localhost:8000'
export const DEFAULT_STACK_URL = 'http://localhost:3000'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

type Env = Record<string, string | undefined>

export function assertLocalOrigin(url: string, label: string, env: Env = process.env): string {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${label} is not a valid absolute URL (expected e.g. ${DEFAULT_API_URL}).`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use http or https.`)
  }

  if (!LOCAL_HOSTNAMES.has(parsed.hostname) && env['BEAI_E2E_ALLOW_NON_LOCAL'] !== '1') {
    throw new Error(
      `${label} points at "${parsed.hostname}", which is not this machine. The real-stack tier ` +
        `logs in as an admin and WRITES a link and a participant, so it only targets localhost, ` +
        `127.0.0.1 or [::1]. BEAI_E2E_ALLOW_NON_LOCAL=1 lifts this check; it is for deliberate use only.`
    )
  }

  return url.replace(/\/+$/, '')
}

function resolve(name: string, fallback: string, env: Env): string {
  const raw = env[name]?.trim()

  return assertLocalOrigin(raw === undefined || raw === '' ? fallback : raw, name, env)
}

export function resolveApiUrl(env: Env = process.env): string {
  return resolve('BEAI_E2E_API_URL', DEFAULT_API_URL, env)
}

export function resolveStackUrl(env: Env = process.env): string {
  return resolve('BEAI_E2E_STACK_URL', DEFAULT_STACK_URL, env)
}
