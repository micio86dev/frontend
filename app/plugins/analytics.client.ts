import { analyticsPlan, createGtagStub, gaConfigPayload } from '~/app/utils/analytics'
import { ANALYTICS_CONSENT_EVENT, readAnalyticsConsent } from '~/app/utils/analytics-consent'
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
  window.gtag = createGtagStub(window)

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

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()
  const router = useRouter()

  const gaMeasurementId = String(config.public.gaMeasurementId ?? '')
  const clarityProjectId = String(config.public.clarityProjectId ?? '')

  // Mutable, because consent can be granted mid-visit through the banner. It is
  // never revoked here: withdrawing consent has to unload third-party scripts
  // that are already running, which no SDK reliably supports, so that path is a
  // reload. Flipping this to false without a reload would LOOK like it worked.
  let consentGranted = readAnalyticsConsent(
    typeof window === 'undefined' ? undefined : window.localStorage
  )

  function startFor(path: string): void {
    const plan = analyticsPlan({ gaMeasurementId, clarityProjectId, consentGranted, path })

    if (plan.loadGa) {
      startGa(gaMeasurementId, plan.pagePath)
    }

    if (plan.loadClarity) {
      startClarity(clarityProjectId)
    }
  }

  startFor(router.currentRoute.value.fullPath)

  // The banner announces a grant rather than calling in here, so this plugin
  // stays the single owner of script injection. Without it, consenting would do
  // nothing visible until the next page load — which reads as a broken button,
  // and is the sort of thing that gets "fixed" by making the banner reload the
  // page over the user's work.
  window.addEventListener(ANALYTICS_CONSENT_EVENT, () => {
    consentGranted = true
    startFor(router.currentRoute.value.fullPath)
  })

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
})
