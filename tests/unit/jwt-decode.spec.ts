import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeJwtPayload } from '~/app/utils/jwt-decode'

const b64url = (value: string) =>
  Buffer.from(value, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const jwt = (payload: string) => `${b64url('{"alg":"none"}')}.${b64url(payload)}.sig`

describe('decodeJwtPayload', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('decodes the claims of a well-formed token', () => {
    expect(decodeJwtPayload(jwt('{"candidate_ref":"c-1","exp":1700000000}'))).toEqual({
      candidate_ref: 'c-1',
      exp: 1700000000,
    })
  })

  it('decodes multi-byte UTF-8 claims and unpadded base64url', () => {
    expect(decodeJwtPayload(jwt('{"name":"Zoë è ✓"}'))).toEqual({ name: 'Zoë è ✓' })
  })

  it.each(['', 'only.two', 'a.b.c.d'])(
    'returns null for a token without three segments (%s)',
    (t) => {
      expect(decodeJwtPayload(t)).toBeNull()
    }
  )

  it('returns null when the payload segment is empty', () => {
    expect(decodeJwtPayload('head..sig')).toBeNull()
  })

  it('returns null when the payload is not valid base64 or JSON', () => {
    expect(decodeJwtPayload('h.%%%.s')).toBeNull()
    expect(decodeJwtPayload(`h.${b64url('not json')}.s`)).toBeNull()
  })

  it.each(['null', '42', '"str"'])(
    'returns null when the payload is JSON but not an object (%s)',
    (p) => {
      expect(decodeJwtPayload(jwt(p))).toBeNull()
    }
  )

  it('falls back to Buffer decoding when atob is unavailable', () => {
    vi.stubGlobal('atob', undefined)
    expect(decodeJwtPayload(jwt('{"project_id":"p-9"}'))).toEqual({ project_id: 'p-9' })
  })
})
