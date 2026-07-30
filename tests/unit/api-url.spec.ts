/**
 * app/utils/api-url — the single API URL builder.
 *
 * Regression under test: `apiBase` INCLUDES the `/api` suffix (AGENTS.md,
 * docker-compose.yml, both Dockerfiles). Eight hand-built template strings each
 * re-appended `/api` themselves, producing `/api/api/...` — routed nowhere, a hard
 * 404 with no CORS headers — for every candidate call under Docker.
 *
 * These assertions are on the FULL resolved URL on purpose: a `stringContaining`
 * assertion passes just as happily against the doubled-prefix URL.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apiUrl, joinApiUrl } from '~/app/utils/api-url'

describe('joinApiUrl', () => {
  it('joins a base without a trailing slash and a path with a leading slash', () => {
    expect(joinApiUrl('https://api.test/api', '/candidate/interview/start')).toBe(
      'https://api.test/api/candidate/interview/start'
    )
  })

  it('tolerates a trailing slash on the base', () => {
    expect(joinApiUrl('https://api.test/api/', '/candidate/session')).toBe(
      'https://api.test/api/candidate/session'
    )
  })

  it('tolerates repeated trailing slashes on the base', () => {
    expect(joinApiUrl('https://api.test/api///', '/candidate/session')).toBe(
      'https://api.test/api/candidate/session'
    )
  })

  it('tolerates a path without a leading slash', () => {
    expect(joinApiUrl('https://api.test/api', 'candidate/session')).toBe(
      'https://api.test/api/candidate/session'
    )
  })

  it('never emits a doubled slash between base and path', () => {
    expect(joinApiUrl('https://api.test/api/', '//candidate/session')).toBe(
      'https://api.test/api/candidate/session'
    )
  })

  it('does NOT add an /api segment of its own — the base already carries it', () => {
    expect(joinApiUrl('https://api.test/api', '/candidate/interview/snapshot')).not.toContain(
      '/api/api/'
    )
  })

  it('an empty base yields a same-origin relative URL, never a protocol-relative one', () => {
    expect(joinApiUrl('', '/candidate/session')).toBe('/candidate/session')
  })

  it('an empty path returns the base with its trailing slash trimmed', () => {
    expect(joinApiUrl('https://api.test/api/', '')).toBe('https://api.test/api')
  })
})

describe('apiUrl', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'useRuntimeConfig',
      vi.fn(() => ({ public: { apiBase: 'http://api:8000/api' } }))
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves against runtimeConfig.public.apiBase', () => {
    expect(apiUrl('/candidate/interview/start')).toBe(
      'http://api:8000/api/candidate/interview/start'
    )
  })

  it('treats a missing apiBase as an empty base rather than the string "undefined"', () => {
    vi.stubGlobal(
      'useRuntimeConfig',
      vi.fn(() => ({ public: {} }))
    )

    expect(apiUrl('/candidate/session')).toBe('/candidate/session')
  })
})
