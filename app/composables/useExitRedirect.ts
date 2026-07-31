/**
 * useExitRedirect — post-interview exit redirect composable (D10, C10 PR7)
 *
 * Fetches `GET /api/candidate/session` once (intended call site: page mount, NOT
 * the `done` state itself — a network failure at the very end must not strand the
 * candidate on a blank screen) and caches `project.exit_redirect_url`.
 *
 * `redirect()` navigates only for a validated `https://` URL (open-redirect /
 * downgrade hardening — `StoreProjectRequest.php:74` accepts `http://`, so the
 * client refuses it here). A null/empty/invalid/non-https URL is a no-op: the
 * caller keeps rendering the existing static `done` branch.
 */

import { ref } from 'vue'
import { $fetch } from 'ofetch'
import { apiUrl } from '~/app/utils/api-url'

export interface UseExitRedirectReturn {
  /** Cached `project.exit_redirect_url` from the candidate session, or null. */
  exitRedirectUrl: ReturnType<typeof ref<string | null>>
  /**
   * Cached `project.error_redirect_url`, or null.
   *
   * Both live here rather than in a second composable because both are the same
   * act — handing the candidate back to the system that sent them — and they
   * read the SAME endpoint. Two composables would mean two fetches of one
   * session, and two places for the URL-safety rules to drift apart.
   */
  errorRedirectUrl: ReturnType<typeof ref<string | null>>
  /** Fetch GET /api/candidate/session once and cache exit_redirect_url. Never throws. */
  fetchSession: () => Promise<void>
  /**
   * Navigate to the cached exit_redirect_url if it is a validated https:// URL.
   * Returns true if navigation was triggered, false if it was a no-op (null,
   * empty, non-https, or malformed URL — logs a console.warn in the last two cases).
   */
  redirect: () => boolean
  /**
   * Navigate to the cached error_redirect_url under the same safety rules.
   * Returns false when unconfigured, which is the signal to keep the existing
   * inline error screen.
   */
  redirectToError: () => boolean
}

export function useExitRedirect(): UseExitRedirectReturn {
  const exitRedirectUrl = ref<string | null>(null)
  const errorRedirectUrl = ref<string | null>(null)

  async function fetchSession(): Promise<void> {
    try {
      const response = await $fetch<{
        project: {
          exit_redirect_url: string | null
          error_redirect_url?: string | null
        } | null
      }>(apiUrl('/candidate/session'), { method: 'GET' })

      exitRedirectUrl.value = response.project?.exit_redirect_url ?? null
      errorRedirectUrl.value = response.project?.error_redirect_url ?? null
    } catch (err) {
      // Non-fatal: a fetch failure degrades to the inline screens.
      console.warn('[useExitRedirect] /candidate/session fetch failed (non-fatal):', err)
      exitRedirectUrl.value = null
      errorRedirectUrl.value = null
    }
  }

  /**
   * The shared safety gate. https only, well-formed only.
   *
   * Both destinations are operator-configured strings that end up in
   * `navigateTo(..., { external: true })`, so both need the same guard — an
   * http:// error page would downgrade a candidate mid-failure, which is
   * exactly when they are least likely to notice.
   */
  function redirectTo(url: string | null, label: string): boolean {
    if (!url) return false

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      console.warn(`[useExitRedirect] malformed ${label}, falling back to the inline screen:`, url)
      return false
    }

    if (parsed.protocol !== 'https:') {
      console.warn(
        `[useExitRedirect] refusing non-https ${label}, falling back to the inline screen:`,
        url
      )
      return false
    }

    navigateTo(url, { external: true, replace: true })
    return true
  }

  const redirect = (): boolean => redirectTo(exitRedirectUrl.value, 'exit_redirect_url')
  const redirectToError = (): boolean => redirectTo(errorRedirectUrl.value, 'error_redirect_url')

  return { exitRedirectUrl, errorRedirectUrl, fetchSession, redirect, redirectToError }
}
