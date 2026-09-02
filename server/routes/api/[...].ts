import { proxyRequest } from 'h3'

/**
 * Same-origin API proxy.
 *
 * WHY THIS EXISTS
 * ---------------
 * `NUXT_PUBLIC_API_BASE` was `http://api:8000/api` — the Docker-internal
 * hostname. That is correct for SSR, which runs inside the network, and wrong
 * for everything else: `pages/interview/[token].vue` is `ssr: false`, so the
 * BROWSER performs that fetch, from the user's machine, where `api` does not
 * resolve at all.
 *
 * The failure was silent and misread for hours. `[token].vue` sends a 401 to
 * `reason=spent_link` and EVERY other failure — including a DNS error that
 * never reached a server — to `reason=403`, which renders "Sessione non
 * autorizzata. La sessione è scaduta o non è più disponibile." So a candidate
 * whose browser simply could not resolve a hostname was told their interview
 * had expired.
 *
 * A public config value is shipped to the browser by definition, so it MUST be
 * browser-reachable; and inside the container `localhost` is the container
 * itself, not the api. One value cannot serve both — which is why this is a
 * proxy rather than a corrected URL.
 *
 * The backoffice already solved this exact problem the same way (nginx
 * proxying `/api/` on its own origin, change `backoffice-same-origin-api`),
 * and it is why the backoffice never had this bug. This is that pattern for a
 * Nitro app, so both frontends now reach the API the same way and the browser
 * makes NO cross-origin request at all — the CORS surface disappears rather
 * than being configured correctly.
 *
 * `server/routes/api/health.get.ts` keeps its own meaning: Nitro matches the
 * more specific route first, so the frontend's own liveness probe is answered
 * here and never forwarded. The candidate app never calls the API's
 * `/api/health`, so nothing is lost.
 *
 * The target is read from RUNTIME config, not baked at build: the same image
 * runs in compose and on Railway, where the API lives at a different origin.
 */
export default defineEventHandler(async (event) => {
  const origin = String(useRuntimeConfig(event).apiOrigin ?? '')

  if (!origin) {
    // Fail loudly. A proxy silently returning 404 would look exactly like the
    // bug this file exists to remove.
    throw createError({
      statusCode: 500,
      statusMessage: 'BEAI_API_ORIGIN is not configured; the API proxy has no target.',
    })
  }

  // `event.path` already carries the `/api/...` prefix and the query string,
  // and the API expects that prefix — so it is forwarded verbatim rather than
  // stripped and rebuilt, which is how `/api/api/...` happens.
  return proxyRequest(event, `${origin.replace(/\/+$/, '')}${event.path}`, {
    // Hop-by-hop only. Authorization, Content-Type and the rest travel as
    // sent: the candidate's bearer token is the whole point of the call.
    headers: { host: undefined },
  })
})
