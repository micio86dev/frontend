/**
 * Is the candidate interview call screen switched on?
 *
 * `runtimeConfig.public.candidateCallUi` (env NUXT_PUBLIC_CANDIDATE_CALL_UI).
 * The default, declared in nuxt.config.ts, is `'true'`: the call screen is the
 * live interview (UI-12). The variable stays as the KILL SWITCH back to the legacy
 * screen until that screen is deleted (UI-13).
 *
 * The rule, in one place:
 *   - variable UNSET            -> Nitro keeps the config default 'true' -> ON
 *   - 'true' / `true`           -> ON (Nuxt/Nitro coerces NUXT_PUBLIC_* with destr
 *                                  at runtime, so a deployment exposes the boolean
 *                                  `true`; destr also lower-cases 'TRUE' into it)
 *   - 'false' / `false`         -> OFF (destr turns 'false' into the boolean)
 *   - set but EMPTY, '1', 'yes' -> OFF: an explicit value that is not `true` is a
 *                                  choice, never read as "unset". Only an unset
 *                                  variable means "use the default"
 *   - key missing (stubbed tests), undefined, null -> OFF: this function is a
 *     strict reader; the app always declares the key, so only a bare stub gets here
 *
 * Same convention as `interviewProviderMock`, inverted default.
 */
export function useCandidateCallUi(): boolean {
  const value = (useRuntimeConfig().public as Record<string, unknown>).candidateCallUi

  return value === true || value === 'true'
}
