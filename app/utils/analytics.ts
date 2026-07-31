import { isAnalyticsSafeRoute, redactAnalyticsPath } from '~/app/utils/analytics-path'

/**
 * Decides what analytics may load, and what it may send (C13, tasks 5.3 / 5.4).
 *
 * A pure function rather than logic inside the plugin, because "does a
 * third-party session recorder start on the page showing this candidate's
 * transcript" should be answerable in one line of test — not by reading control
 * flow in a browser and hoping.
 */

export interface AnalyticsOptions {
  gaMeasurementId: string
  clarityProjectId: string
  consentGranted: boolean
  path: string
}

export interface AnalyticsPlan {
  loadGa: boolean
  loadClarity: boolean
  pagePath: string
}

export function analyticsPlan(options: AnalyticsOptions): AnalyticsPlan {
  const { gaMeasurementId, clarityProjectId, consentGranted, path } = options

  // Two independent conditions, and BOTH default to off: an ID that was never
  // configured, and a consent that was never granted. Neither is a fallback for
  // the other — a missing ID is "this deployment does not use the tool", while
  // missing consent is "this visitor has not agreed", and confusing them is how
  // analytics ends up running for people who declined.
  const enabled = consentGranted

  return {
    loadGa: enabled && gaMeasurementId !== '',

    // Clarity is additionally refused on the whole interview branch, whatever
    // the configuration says. See isAnalyticsSafeRoute for why this is not left
    // to whoever fills in the env var.
    loadClarity: enabled && clarityProjectId !== '' && isAnalyticsSafeRoute(path),

    pagePath: redactAnalyticsPath(path),
  }
}

export interface GaConfigPayload {
  page_path: string
  page_location: string
  anonymize_ip: true
  allow_google_signals: false
  allow_ad_personalization_signals: false
  send_page_view: false
}

/**
 * The GA4 config object. Every field here exists to take something away.
 *
 * `page_location` is pinned empty because GA4 reads `window.location` itself
 * when it is absent — so overriding `page_path` alone would still ship the
 * magic-link token, and the redaction would look like it was working.
 */
export function gaConfigPayload(pagePath: string): GaConfigPayload {
  return {
    page_path: pagePath,
    page_location: '',
    anonymize_ip: true,

    // A candidate taking a hiring assessment has not agreed to become an
    // advertising audience. Remarketing lists built from this traffic would
    // leak the fact that a named person is job-hunting to every advertiser who
    // buys that segment — an inference this product exists to keep private.
    allow_google_signals: false,
    allow_ad_personalization_signals: false,

    // Page views are sent explicitly, per navigation, with the redacted path.
    // GA4's automatic page_view fires before any of the above can be applied.
    send_page_view: false,
  }
}
