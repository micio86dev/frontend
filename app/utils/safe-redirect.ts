/**
 * safe-redirect — shared https-only, well-formed URL guard for candidate-facing
 * external navigation (framework-catalogue-authoring PR11, D6).
 *
 * Mirrors the rule `useExitRedirect`'s internal `redirectTo` applies to
 * `exit_redirect_url`/`error_redirect_url`: only a validated `https://` URL is
 * ever navigated to — open-redirect / protocol-downgrade hardening. A
 * null/empty/malformed/non-https URL is refused (logged, never navigated).
 *
 * Lives outside `useExitRedirect` because this call site — `SsoExchangeController`'s
 * `redirect_url`, returned on every 403 including before any candidate session
 * exists — has no session to fetch or clear: `useExitRedirect.fetchSession()`
 * requires an authenticated candidate session this route does not yet have.
 */
export function safeExternalRedirect(url: string | null, label: string): boolean {
  if (!url) return false

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    console.warn(`[safe-redirect] malformed ${label}, falling back to the inline screen:`, url)
    return false
  }

  if (parsed.protocol !== 'https:') {
    console.warn(
      `[safe-redirect] refusing non-https ${label}, falling back to the inline screen:`,
      url
    )
    return false
  }

  navigateTo(url, { external: true, replace: true })
  return true
}
