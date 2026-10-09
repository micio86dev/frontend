/**
 * The support target the candidate screens link to (candidate-interview-call-ui,
 * design D10).
 *
 * `runtimeConfig.public.supportUrl` (env NUXT_PUBLIC_SUPPORT_URL) is
 * deployment-supplied and ends up in an `href`, so only two schemes survive:
 * `https:` (a support page) and `mailto:` (a mailbox). Anything else —
 * empty, `http:`, `javascript:`, `data:`, relative, protocol-relative, bare
 * host, malformed, or not a string at all — falls back to the mailbox the app
 * has always shipped. Pure and total: it never throws.
 */
export const DEFAULT_SUPPORT_URL = 'mailto:support@beai.app'

export function sanitizeSupportUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SUPPORT_URL

  const candidate = value.trim()
  if (candidate === '') return DEFAULT_SUPPORT_URL

  try {
    const url = new URL(candidate)

    if (url.protocol === 'https:' && url.hostname !== '') return candidate
    if (url.protocol === 'mailto:' && url.pathname !== '') return candidate
  } catch {
    // Not an absolute URL: relative, protocol-relative, a bare host or garbage.
  }

  return DEFAULT_SUPPORT_URL
}
