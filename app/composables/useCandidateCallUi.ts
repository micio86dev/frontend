/**
 * Is the new candidate interview call screen switched on?
 *
 * `runtimeConfig.public.candidateCallUi` (env NUXT_PUBLIC_CANDIDATE_CALL_UI),
 * default `''`: the old screen. Same convention as `interviewProviderMock`:
 * only the string 'true' enables it. The boolean `true` is accepted too,
 * because Nuxt/Nitro coerces NUXT_PUBLIC_* env values with destr at runtime, so
 * a real deployment exposes the boolean; a strict string comparison would never
 * switch the flag on outside Vitest. Everything else ('1', 'yes', 'false', ...)
 * is off.
 */
export function useCandidateCallUi(): boolean {
  const value = (useRuntimeConfig().public as Record<string, unknown>).candidateCallUi

  return value === true || value === 'true'
}
