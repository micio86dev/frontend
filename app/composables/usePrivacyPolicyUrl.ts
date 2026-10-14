/**
 * The Privacy Policy document linked from the candidate footer.
 *
 * Reads `runtimeConfig.public.privacyPolicyUrl` (env NUXT_PUBLIC_PRIVACY_POLICY_URL)
 * and returns it only when it is an absolute `https:` URL, otherwise '' (no
 * link). The value ends up in an `href`, so `javascript:`/`data:`/relative
 * values must never survive. Typed `unknown` because Nuxt coerces NUXT_PUBLIC_*
 * env values at runtime.
 */
export function sanitizePrivacyPolicyUrl(value: unknown): string {
  if (typeof value !== 'string') return ''

  const candidate = value.trim()
  try {
    const url = new URL(candidate)

    if (url.protocol === 'https:' && url.hostname !== '') return candidate
  } catch {
    // Not an absolute URL.
  }

  return ''
}

export function usePrivacyPolicyUrl(): string {
  return sanitizePrivacyPolicyUrl(
    (useRuntimeConfig().public as Record<string, unknown>).privacyPolicyUrl
  )
}
