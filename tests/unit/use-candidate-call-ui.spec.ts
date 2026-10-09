/**
 * useCandidateCallUi — the one switch behind the new interview call screen
 * (candidate-interview-call-ui, design D1).
 *
 * Same convention as `interviewProviderMock`: the strict string 'true'. The
 * boolean `true` is accepted as well because Nuxt/Nitro coerces NUXT_PUBLIC_*
 * env values with destr at runtime, so a real deployment exposes the boolean
 * (see `isMock()` in useInterviewSession). Every other value keeps the old screen.
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
    ['empty string (the default)', ''],
    ["'1'", '1'],
    ["'yes'", 'yes'],
    ["'false'", 'false'],
    ["'TRUE'", 'TRUE'],
    ['boolean false', false],
    ['undefined', undefined],
    ['null', null],
  ])('is off for %s', (_name, value) => {
    expect(withFlag(value)).toBe(false)
  })

  it('is off when the public config carries no such key', () => {
    vi.stubGlobal(
      'useRuntimeConfig',
      vi.fn(() => ({ public: {} }))
    )

    expect(useCandidateCallUi()).toBe(false)
  })
})
