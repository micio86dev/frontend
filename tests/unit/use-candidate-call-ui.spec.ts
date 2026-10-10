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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useCandidateCallUi } from '~/app/composables/useCandidateCallUi'

function callUiFor(value: unknown): boolean {
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
    expect(callUiFor('true')).toBe(true)
  })

  it('is on for the boolean true that Nuxt produces from the environment', () => {
    expect(callUiFor(true)).toBe(true)
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
    expect(callUiFor(value)).toBe(false)
  })

  it('is off when the public config carries no such key (the app always declares it, so only a stub gets here)', () => {
    vi.stubGlobal(
      'useRuntimeConfig',
      vi.fn(() => ({ public: {} }))
    )

    expect(useCandidateCallUi()).toBe(false)
  })
})

// The rule above leans on how Nitro applies the environment to the config default.
// Proven against Nitro's own applyEnv, not assumed: unset keeps 'true', anything
// DEFINED (even empty) replaces it.
//
// applyEnv is not a documented Nitro API: it lives in a runtime internal reachable
// only through the package's `./runtime/*` export. This helper is the ONLY place that
// touches it. Verified against nitropack 2.13.4. The exact rule it pins:
// `obj[key] = destr(process.env[NITRO_*] ?? process.env[NUXT_*]) ?? default`, so an
// unset variable keeps the default and a set-but-empty one replaces it.
// If a Nitro upgrade moves or renames it, the assertion below fails with this message.
async function loadNitroApplyEnv(): Promise<
  (
    obj: { public: { candidateCallUi: unknown } },
    opts: { prefix: string; altPrefix: string }
  ) => { public: { candidateCallUi: unknown } }
> {
  const mod = await import(
    // @ts-expect-error internal Nitro runtime module, no type declarations
    'nitropack/runtime/internal/utils.env'
  )
  expect(
    typeof mod.applyEnv,
    'Nitro internal applyEnv moved or was renamed (verified on nitropack 2.13.4): re-pin the kill-switch rule in this helper'
  ).toBe('function')

  return mod.applyEnv
}

describe('the kill switch through Nitro applyEnv (default stays on)', () => {
  const KEY = 'NUXT_PUBLIC_CANDIDATE_CALL_UI'
  // The SHIPPED default, read from nuxt.config.ts (no Nuxt runtime in Vitest), so the
  // "unset -> on" case breaks if someone ships a different default.
  const shippedDefault = /candidateCallUi:\s*'([^']*)'/.exec(
    readFileSync(resolve(__dirname, '../../nuxt.config.ts'), 'utf8')
  )?.[1]

  async function callUiForEnv(env: string | undefined): Promise<boolean> {
    const applyEnv = await loadNitroApplyEnv()
    // stubEnv(KEY, undefined) removes the variable; unstubAllEnvs restores it.
    vi.stubEnv(KEY, env)
    try {
      const config = applyEnv(
        { public: { candidateCallUi: shippedDefault } },
        { prefix: 'NITRO_', altPrefix: 'NUXT_' }
      )
      return callUiFor(config.public.candidateCallUi)
    } finally {
      vi.unstubAllEnvs()
    }
  }

  it.each([
    ['unset', true, undefined],
    ['true', true, 'true'],
    ['TRUE', true, 'TRUE'],
    ['false', false, 'false'],
    ['set but empty', false, ''],
    ['1', false, '1'],
    ['0', false, '0'],
    ['yes', false, 'yes'],
  ] as const)('%s -> on is %s', async (_n, expected, env) => {
    expect(await callUiForEnv(env)).toBe(expected)
  })
})
