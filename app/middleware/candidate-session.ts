/**
 * candidate-session.ts — sync entry gate on `/interview/session` (D-E).
 *
 * Named (non-global) middleware, opted into by `session.vue` via
 * `definePageMeta({ middleware: ['candidate-session'] })`. Client-only,
 * synchronous, no network: reads the stored candidate session directly via
 * `useCandidateSession().read()` (which already purges an expired session on
 * read, without a round-trip) and `replace`-redirects to the expired-session
 * terminal when absent or expired.
 *
 * Zero milliseconds — no flash, no skeleton-for-a-decision, no optimistic
 * render to unwind. `session.vue` never renders without a valid session.
 *
 * SSR invariant: `localStorage` does not exist server-side, and this route
 * already renders `ssr: false` — the server-side middleware pass is a no-op;
 * the client-side pass is what actually gates entry.
 *
 * `defineNuxtRouteMiddleware`, `navigateTo`, and `useLocalePath` are Nuxt
 * auto-imports, used here as globals (not imported from `#imports`) — the
 * same convention this project's pages and composables already follow for
 * `definePageMeta`, `useHead`, and `navigateTo` elsewhere, and the only style
 * Vitest can exercise directly without a full Nuxt build resolving `#imports`.
 *
 * `useLocalePath()` matters here, not cosmetically: a bare `navigateTo('/interview/terminal?...')`
 * resolves against the DEFAULT locale (no prefix), silently dropping an
 * English candidate back into the Italian terminal screen.
 */

import { useCandidateSession } from '~/app/composables/useCandidateSession'

export default defineNuxtRouteMiddleware(() => {
  if (import.meta.server) return

  const session = useCandidateSession().read()
  if (!session) {
    const localePath = useLocalePath()
    return navigateTo(localePath('/interview/terminal?reason=session_expired'), { replace: true })
  }
})
