/**
 * candidate-api — unit tests (Task 1.3 RED / candidate-session-auth D-B)
 *
 * `candidateFetch` is the ONE transport every candidate-scoped request must
 * go through. Coverage targets:
 *  - a stored session → Authorization: Bearer <token> is attached
 *  - a 401 response → the stored session is cleared and a
 *    CandidateUnauthorizedError is thrown (never retried, never surfaced as a
 *    generic error)
 *  - no stored session → the underlying instance is NEVER invoked (no network
 *    call is attempted at all — spec: "Every candidate request is
 *    authenticated")
 *  - `flushIntegrityKeepalive` — the sendBeacon replacement — carries the
 *    Authorization header via fetch(..., { keepalive: true })
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks — ofetch.create() must return a mock instance we can inspect,
// and capture the onRequest/onResponseError hooks passed to create().
// ---------------------------------------------------------------------------

const { mockInstance, mockCreate } = vi.hoisted(() => {
  const mockInstance = vi.fn()
  const mockCreate = vi.fn(() => mockInstance)
  return { mockInstance, mockCreate }
})

vi.mock('ofetch', () => ({
  ofetch: { create: mockCreate },
}))

// eslint-disable-next-line import/first
import {
  candidateFetch,
  CandidateUnauthorizedError,
  flushIntegrityKeepalive,
} from '~/app/utils/candidate-api'
// eslint-disable-next-line import/first
import { useCandidateSession } from '~/app/composables/useCandidateSession'

// ---------------------------------------------------------------------------
// `ofetch.create()` runs exactly once, at module import — BEFORE any
// `beforeEach`'s `vi.clearAllMocks()` can wipe the mock's call history.
// Capture both the call count and the hooks passed to `create()` here, at
// module scope, so later tests can inspect them without racing the clear.
// ---------------------------------------------------------------------------

const createCallCountAtModuleLoad = mockCreate.mock.calls.length
const createOptionsAtModuleLoad = mockCreate.mock.calls[0]?.[0] as {
  onRequest: (ctx: { options: { headers?: HeadersInit } }) => Promise<void> | void
  onResponseError: (ctx: { response: { status: number } }) => Promise<void> | void
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function makeCandidateJwt(exp = Math.floor(Date.now() / 1000) + 3600): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({ typ: 'candidate', candidate_ref: 'cand-1', project_id: 1, exp })
  )
  return `${header}.${payload}.sig`
}

function storeValidSession(): string {
  const token = makeCandidateJwt()
  useCandidateSession().store(token)
  return token
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.stubGlobal(
    'useRuntimeConfig',
    vi.fn(() => ({
      public: { apiBase: 'https://api.test', interviewProviderMock: 'false' },
    }))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('candidateFetch', () => {
  it('creates exactly one ofetch instance at module load (single-wrapper shape, D-B)', () => {
    expect(createCallCountAtModuleLoad).toBe(1)
  })

  it('with a stored session → invokes the instance against the resolved apiUrl', async () => {
    storeValidSession()
    mockInstance.mockResolvedValueOnce({ ok: true })

    await candidateFetch('/candidate/interview/start', { method: 'POST' })

    expect(mockInstance).toHaveBeenCalledWith(
      'https://api.test/candidate/interview/start',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('onRequest hook attaches Authorization: Bearer <token>', async () => {
    const token = storeValidSession()

    const ctx = { options: {} as { headers?: HeadersInit } }
    await createOptionsAtModuleLoad.onRequest(ctx)

    const headers = new Headers(ctx.options.headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${token}`)
  })

  it('no stored session → the underlying instance is NEVER called (no network attempt)', async () => {
    await expect(candidateFetch('/candidate/interview/start')).rejects.toThrow(
      CandidateUnauthorizedError
    )

    expect(mockInstance).not.toHaveBeenCalled()
  })

  it('onResponseError on a 401 clears the session and throws CandidateUnauthorizedError', async () => {
    storeValidSession()

    await expect(
      createOptionsAtModuleLoad.onResponseError({ response: { status: 401 } })
    ).rejects.toThrow(CandidateUnauthorizedError)

    expect(useCandidateSession().read()).toBeNull()
  })

  it('a non-401 error response does not clear the session or throw a typed error', async () => {
    storeValidSession()

    await expect(
      createOptionsAtModuleLoad.onResponseError({ response: { status: 500 } })
    ).resolves.toBeUndefined()

    expect(useCandidateSession().read()).not.toBeNull()
  })
})

describe('flushIntegrityKeepalive', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('with a stored session → calls fetch with Authorization header and keepalive: true', () => {
    const token = storeValidSession()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    flushIntegrityKeepalive({ session_id: 1, events: [] })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/candidate/interview/integrity',
      expect.objectContaining({
        method: 'POST',
        keepalive: true,
        headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
      })
    )
  })

  it('no stored session → fetch is never called (refused, not sent unauthenticated)', () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    flushIntegrityKeepalive({ session_id: 1, events: [] })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('a synchronous throw from fetch is caught, not propagated (try/catch replaces the !sent check)', () => {
    storeValidSession()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    globalThis.fetch = vi.fn(() => {
      throw new Error('fetch unavailable')
    }) as unknown as typeof fetch

    expect(() => flushIntegrityKeepalive({ session_id: 1, events: [] })).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('a rejected fetch promise is caught, not propagated', async () => {
    storeValidSession()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch

    expect(() => flushIntegrityKeepalive({ session_id: 1, events: [] })).not.toThrow()
    // allow the rejected promise's .catch() to run
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
