/**
 * useExitRedirect — post-interview exit redirect composable (D10, C10 PR7;
 * D-D — candidate-session-auth)
 *
 * Fetches `GET /api/candidate/session` once (intended call site: page mount, NOT
 * the `done` state itself — a network failure at the very end must not strand the
 * candidate on a blank screen) and caches `project.exit_redirect_url`.
 *
 * `redirect()` navigates only for a validated `https://` URL (open-redirect /
 * downgrade hardening — `StoreProjectRequest.php:74` accepts `http://`, so the
 * client refuses it here). A null/empty/invalid/non-https URL is a no-op: the
 * caller keeps rendering the existing static `done` branch.
 *
 * D-D: `fetchSession()` keeps its never-throws contract, but "operator
 * configured no URL" (supported) and "we are not authenticated" (defect) no
 * longer share one code path. `sessionFetchFailed` distinguishes them:
 *   - `'unauthenticated'` — the candidate session has expired or been
 *     cleared (a 401, surfaced as `CandidateUnauthorizedError`).
 *   - `'unavailable'` — any other failure (network, 5xx, malformed body).
 * Neither is logged as "non-fatal" — that word is what let this survive
 * unnoticed; the log now names the actual consequence instead.
 */

import { ref } from 'vue'
import { candidateFetch, CandidateUnauthorizedError } from '~/app/utils/candidate-api'
import { useCandidateBranding } from '~/app/composables/useCandidateBranding'
import { useCandidateSession } from '~/app/composables/useCandidateSession'

export type SessionFetchFailure = 'unauthenticated' | 'unavailable'

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
  /**
   * Why the LAST `fetchSession()` call failed to resolve either redirect URL,
   * or null if it has not failed. Distinguishes "no URL configured"
   * (supported) from "we are not authenticated" (defect) — see D-D.
   */
  sessionFetchFailed: ReturnType<typeof ref<SessionFetchFailure | null>>
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
  const sessionFetchFailed = ref<SessionFetchFailure | null>(null)

  async function fetchSession(): Promise<void> {
    try {
      const response = await candidateFetch<{
        project: {
          exit_redirect_url: string | null
          error_redirect_url?: string | null
        } | null
        branding?: { primary_color: string | null; logo_url: string | null }
      }>('/candidate/session', { method: 'GET' })

      sessionFetchFailed.value = null
      exitRedirectUrl.value = response.project?.exit_redirect_url ?? null
      errorRedirectUrl.value = response.project?.error_redirect_url ?? null

      // The same response carries the organization's logo and colour, so the
      // branding store is handed them here rather than fetching the identical
      // endpoint a second time. Applying it is `useCandidateBranding`'s job —
      // this composable does not write to the stylesheet.
      useCandidateBranding().prime(response.branding)
    } catch (err) {
      // The failure degrades to the inline screens — fetchSession() never
      // throws — but the consequence is named, not hidden behind "non-fatal":
      // a candidate session that has expired or been cleared means BOTH the
      // exit redirect and the error redirect are unavailable for the rest of
      // this session, and that is worth knowing, not shrugging off.
      sessionFetchFailed.value =
        err instanceof CandidateUnauthorizedError ? 'unauthenticated' : 'unavailable'
      console.warn(
        '[useExitRedirect] /candidate/session fetch failed — exit and error redirects are unavailable for this session:',
        err
      )
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

    // Verification Finding #1: "cleared ... immediately before an exit or
    // error redirect fires" — cleared HERE, defensively, rather than relying
    // on the caller (e.g. useInterviewSession's own terminal/done clearing)
    // having already run. Only on the path that actually navigates — a
    // refused redirect (null/http/malformed) leaves the inline screen up and
    // must not destroy a still-valid session out from under it.
    useCandidateSession().clear()

    navigateTo(url, { external: true, replace: true })
    return true
  }

  const redirect = (): boolean => redirectTo(exitRedirectUrl.value, 'exit_redirect_url')
  const redirectToError = (): boolean => redirectTo(errorRedirectUrl.value, 'error_redirect_url')

  return {
    exitRedirectUrl,
    errorRedirectUrl,
    sessionFetchFailed,
    fetchSession,
    redirect,
    redirectToError,
  }
}
