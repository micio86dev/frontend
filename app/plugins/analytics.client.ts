import { analyticsPlan, gaConfigPayload } from '~/app/utils/analytics'
import { readAnalyticsConsent } from '~/app/utils/analytics-consent'
import { redactAnalyticsPath } from '~/app/utils/analytics-path'

/**
 * Loads Microsoft Clarity and GA4 — if, and only if, they are allowed to run
 * (C13, tasks 5.3 / 5.4).
 *
 * `.client` because both are browser SDKs, and because an SSR render has no
 * consent to read: server-side loading would track everyone unconditionally.
 *
 * The plugin itself holds no policy. Every decision about what may load and
 * what may be sent lives in the pure functions it calls, so those decisions can
 * be asserted in unit tests instead of inferred from control flow. What is left
 * here is script injection and route subscription.
 */

declare global {
  interface Window {
    dataLayer?: unknown[]
    gtag?: (...args: unknown[]) => void
    clarity?: (...args: unknown[]) => void
  }
}

function injectScript(src: string, id: string): void {
  if (document.getElementById(id) !== null) {
    return
  }

  const script = document.createElement('script')
  script.id = id
  script.async = true
  script.src = src
  document.head.appendChild(script)
}

function startGa(measurementId: string, pagePath: string): void {
  injectScript(`https://www.googletagmanager.com/gtag/js?id=${measurementId}`, 'beai-ga4')

  window.dataLayer = window.dataLayer ?? []
  window.gtag = function gtag(...args: unknown[]): void {
    window.dataLayer?.push(args)
  }

  window.gtag('js', new Date())

  // Consent Mode v2, denied by default for everything this product does not
  // need. The plugin only runs at all once analytics consent is granted, so
  // `analytics_storage` is the one signal that flips — the advertising ones
  // stay denied permanently, because a candidate taking a hiring assessment is
  // not an advertising audience under any consent they could give here.
  window.gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'granted',
  })

  window.gtag('config', measurementId, gaConfigPayload(pagePath))
}

function startClarity(projectId: string): void {
  injectScript(`https://www.clarity.ms/tag/${projectId}`, 'beai-clarity')
}

export default defineNuxtPlugin((nuxtApp) => {
  const config = useRuntimeConfig()
  const router = useRouter()

  const gaMeasurementId = String(config.public.gaMeasurementId ?? '')
  const clarityProjectId = String(config.public.clarityProjectId ?? '')

  // Read once at startup rather than per navigation. Consent changing mid-visit
  // means a page reload in practice, and re-reading on every route change would
  // let a tab that was granted consent start recording a page it entered before
  // the grant.
  const consentGranted = readAnalyticsConsent(
    typeof window === 'undefined' ? undefined : window.localStorage
  )

  const initial = analyticsPlan({
    gaMeasurementId,
    clarityProjectId,
    consentGranted,
    path: router.currentRoute.value.fullPath,
  })

  if (initial.loadGa) {
    startGa(gaMeasurementId, initial.pagePath)
  }

  if (initial.loadClarity) {
    startClarity(clarityProjectId)
  }

  // Per-navigation page views, sent explicitly because gaConfigPayload turns
  // GA4's automatic ones off — those fire before the redaction can be applied
  // and would ship the raw URL exactly once per session, which is all it takes.
  router.afterEach((to) => {
    if (window.gtag === undefined) {
      return
    }

    window.gtag('event', 'page_view', {
      page_path: redactAnalyticsPath(to.fullPath),
      page_location: '',
    })
  })

  // Clarity is never STARTED on an interview route, but a candidate reaching
  // one after browsing elsewhere would already have it running. Stopping it is
  // the difference between "we do not begin recording the interview" and "the
  // interview is not recorded".
  router.afterEach((to) => {
    if (
      window.clarity !== undefined &&
      !analyticsPlan({
        gaMeasurementId,
        clarityProjectId,
        consentGranted,
        path: to.fullPath,
      }).loadClarity
    ) {
      window.clarity('stop')
    }
  })

  nuxtApp.provide('analyticsActive', initial.loadGa || initial.loadClarity)
})
