/**
 * useCandidateBranding — the organization's logo and colour, on the candidate side.
 *
 * A candidate is not a user of the organization and cannot call
 * `/api/organization`; that endpoint is admin-authenticated. So branding rides
 * along on `GET /api/candidate/session`, the bootstrap this app already makes,
 * and this module is where it is held and applied.
 *
 * ONE FETCH, NOT TWO. `useExitRedirect` reads the same endpoint on page mount
 * and calls `prime()` with what it received, so the common path costs nothing
 * extra. `ensureLoaded()` exists for the surfaces that need branding WITHOUT
 * needing a redirect URL — it is a no-op once primed, and single-flights the
 * fetch when it is not, so two components asking at once still make one call.
 *
 * FALLING BACK IS A FEATURE, NOT A FAILURE. An organization that has
 * configured neither renders in the product's own palette and wordmark
 * (CLAUDE.md ruling 9: "no logo configured" must never mean "no logo at all").
 * Nothing here invents a default: `applyBrandColor` REMOVES the override rather
 * than writing the Quint purple, so the stylesheet's own value stands and the
 * brand constant lives in exactly one place.
 */

import { readonly, ref } from 'vue'
import { applyBrandColor } from '~/app/composables/useBrandTheme'
import { candidateFetch } from '~/app/utils/candidate-api'

export interface CandidateBranding {
  primary_color: string | null
  logo_url: string | null
  /**
   * WHOSE assessment this is.
   *
   * Optional in the TYPE only so a stored response predating the field does
   * not have to be migrated; the API always sends the key. Absent renders as
   * absent — never as an empty line where a name should be.
   */
  name?: string | null
}

// Module-scoped, like the candidate session itself: every surface shares one
// answer and one in-flight request.
const logoUrl = ref<string | null>(null)
const organizationName = ref<string | null>(null)
let primed = false
let inFlight: Promise<void> | null = null

export function useCandidateBranding() {
  /**
   * Accept branding somebody else already fetched.
   *
   * Applying the colour here rather than in the caller keeps the one write to
   * `--color-primary` in the one module that owns it.
   */
  function prime(branding: CandidateBranding | null | undefined): void {
    primed = true
    logoUrl.value = branding?.logo_url ?? null
    // Trimmed to null rather than stored blank: an organization with a blank
    // name must render as no name at all, not as an empty line sitting where
    // one should be.
    organizationName.value = branding?.name?.trim() || null
    applyBrandColor(branding?.primary_color)
  }

  /**
   * Fetch and apply, unless somebody already primed it.
   *
   * NEVER THROWS. Branding is decoration on top of an interview that must run
   * regardless — a candidate blocked from their assessment because a logo
   * could not be resolved would be a far worse failure than an unbranded page.
   */
  async function ensureLoaded(): Promise<void> {
    if (primed) return
    if (inFlight !== null) return inFlight

    inFlight = candidateFetch<{ branding?: CandidateBranding }>('/candidate/session', {
      method: 'GET',
    })
      .then((response) => prime(response.branding))
      .catch(() => {
        // Primed either way: a failed read is a settled answer ("we have no
        // branding for this candidate"), and retrying it on every component
        // mount would turn one bad response into a stream of them.
        prime(null)
      })
      .finally(() => {
        inFlight = null
      })

    return inFlight
  }

  /** Test seam — module-scoped state outlives a component, and so would a stale logo. */
  function reset(): void {
    primed = false
    inFlight = null
    logoUrl.value = null
    organizationName.value = null
    applyBrandColor(null)
  }

  return {
    logoUrl: readonly(logoUrl),
    organizationName: readonly(organizationName),
    prime,
    ensureLoaded,
    reset,
  }
}
