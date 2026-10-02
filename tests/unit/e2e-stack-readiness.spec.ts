/**
 * tests/e2e/support/stack-readiness — turns the api's `/api/health/ready` answer
 * into an actionable verdict for the opt-in real-stack e2e tier.
 *
 * The messages are the product here: a stale local schema must read as "run this
 * command", not as a 500 deep inside a browser test. The body of an unexpected
 * answer is never echoed raw (it could be an HTML error page or carry data).
 */

import { describe, it, expect } from 'vitest'
import { describeReadiness } from '../e2e/support/stack-readiness'

describe('describeReadiness', () => {
  it('accepts 200 {"status":"ok"}', () => {
    const verdict = describeReadiness(200, '{"status":"ok"}')

    expect(verdict.ok).toBe(true)
  })

  it('rejects a 200 whose body is not the ok payload', () => {
    expect(describeReadiness(200, '<html>proxy page</html>').ok).toBe(false)
    expect(describeReadiness(200, '{"status":"down"}').ok).toBe(false)
  })

  it('names the exact migrate command for pending migrations', () => {
    const verdict = describeReadiness(503, '{"status":"down","reason":"pending_migrations"}')

    expect(verdict.ok).toBe(false)
    expect(verdict.message).toContain('docker compose exec api php artisan migrate --force')
  })

  it('points at postgres when the database is unavailable', () => {
    const verdict = describeReadiness(503, '{"status":"down","reason":"database_unavailable"}')

    expect(verdict.ok).toBe(false)
    expect(verdict.message).toContain('docker compose ps postgres')
  })

  it('says the api predates the readiness endpoint on a 404', () => {
    const verdict = describeReadiness(404, '{"message":"Not Found"}')

    expect(verdict.ok).toBe(false)
    expect(verdict.message).toContain('/api/health/ready')
    expect(verdict.message).toMatch(/rebuild/i)
  })

  it.each([0, undefined])('says the stack is not running when unreachable (%s)', (status) => {
    const verdict = describeReadiness(status, '')

    expect(verdict.ok).toBe(false)
    expect(verdict.message).toContain('task up')
    expect(verdict.message).toContain('docker compose up -d')
  })

  it('never echoes a raw non-JSON body', () => {
    const verdict = describeReadiness(
      502,
      '<html><body>secret-token=abc123 Bad Gateway</body></html>'
    )

    expect(verdict.ok).toBe(false)
    expect(verdict.message).not.toContain('secret-token')
    expect(verdict.message).not.toContain('<html>')
    expect(verdict.message).toContain('502')
  })

  it('echoes an unknown reason only after sanitising it to [A-Za-z0-9_] and 40 chars', () => {
    const reason = `new_reason<script>alert(1)</script>${'x'.repeat(80)}`
    const verdict = describeReadiness(503, JSON.stringify({ status: 'down', reason }))

    expect(verdict.ok).toBe(false)
    expect(verdict.message).not.toContain('<script>')
    expect(verdict.message).not.toContain('(1)')
    expect(verdict.message).toContain('new_reasonscriptalert1script')
    expect(verdict.message).not.toContain('x'.repeat(41))
  })

  it('does not fail on a non-string reason', () => {
    const verdict = describeReadiness(503, '{"status":"down","reason":{"a":1}}')

    expect(verdict.ok).toBe(false)
    expect(verdict.message).toContain('503')
  })
})
