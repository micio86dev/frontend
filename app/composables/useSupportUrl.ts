import { sanitizeSupportUrl } from '~/utils/support-url'

/**
 * The one support target for every candidate-facing support link
 * (candidate-interview-call-ui, design D10).
 *
 * Reads `runtimeConfig.public.supportUrl` (env NUXT_PUBLIC_SUPPORT_URL) and
 * returns it sanitized: `https:` or `mailto:` only, otherwise
 * `mailto:support@beai.app`. The raw value is typed `unknown` on purpose: Nuxt
 * coerces NUXT_PUBLIC_* env values at runtime, so it is not always a string.
 */
export function useSupportUrl(): string {
  const configured = (useRuntimeConfig().public as Record<string, unknown>).supportUrl

  return sanitizeSupportUrl(configured)
}
