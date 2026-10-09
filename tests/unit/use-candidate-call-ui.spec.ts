/**
 * useCandidateCallUi — the one switch behind the interview call screen
 * (candidate-interview-call-ui, design D1; default ON since UI-12).
 *
 * The composable is a pure reader of `runtimeConfig.public.candidateCallUi`; the
 * DEFAULT lives in nuxt.config.ts (`'true'`, asserted in nuxt-config.spec.ts), so
 * "the variable is unset" never reaches this function as a missing value in a
 * running app: Nitro keeps the default whenever the environment variable is not
 * defined. What reaches it is either that default or the variable's value after
 * Nitro's destr coercion.
 *
 * The kill-switch rule, stated once: the call screen is shown ONLY for the
 * boolean `true` or the exact string 'true'. Everything else is OFF and shows the
 * legacy screen: 'false' (destr turns it into the boolean false), the EXPLICIT
 * empty string (a variable that is set but empty is a choice, not "unset"), '1',
 * 'yes', 'TRUE' as a raw string, undefined, null. Note destr lower-cases 'TRUE'
 * into the boolean true, so at runtime an operator who writes TRUE gets ON.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { useCandidateCallUi } from '~/app/composables/useCandidateCallUi'

function withFlag(value: unknown): boolean {
  vi.stubGlobal(
    'useRuntimeConfig',
    vi.fn(() => ({ public: { candidateCallUi: value } }))
  )

  return useCandidateCallUi()
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useCandidateCallUi', () => {
  it("is on for the string 'true'", () => {
    expect(withFlag('true')).toBe(true)
  })

  it('is on for the boolean true that Nuxt produces from the environment', () => {
    expect(withFlag(true)).toBe(true)
  })

  it.each([
    ['the explicit empty string (set but empty is OFF, not unset)', ''],
    ["'1'", '1'],
    ["'yes'", 'yes'],
    ["'false'", 'false'],
    ["'0'", '0'],
    ["'TRUE'", 'TRUE'],
    ['boolean false', false],
    ['undefined', undefined],
    ['null', null],
  ])('is off for %s', (_name, value) => {
    expect(withFlag(value)).toBe(false)
  })

  it('is off when the public config carries no such key (the app always declares it, so only a stub gets here)', () => {
    vi.stubGlobal(
      'useRuntimeConfig',
      vi.fn(() => ({ public: {} }))
    )

    expect(useCandidateCallUi()).toBe(false)
  })
})
