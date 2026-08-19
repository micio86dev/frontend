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
 * The gtag stub, which MUST push the `arguments` object.
 *
 * `gtag.js` identifies a command tuple by checking that the pushed value is an
 * `arguments` object. A rest-parameter Array — `(...args) => dataLayer.push(args)`
 * — has an IDENTICAL TypeScript signature and is treated as an inert data push
 * instead. Nothing errors: the script loads, the container registers itself,
 * the dataLayer fills up, and not one command ever runs. No `_ga` cookie, no
 * `/g/collect` beacon, zero in Realtime.
 *
 * The rest-parameter form is what TypeScript and every lint rule push you
 * toward, which is exactly why this broke — `prefer-rest-params` cannot know
 * that Google reads the argument object's shape. The contract is not
 * expressible in the type system, so it is pinned in a test instead
 * (tests/unit/analytics-gtag-stub.spec.ts).
 */
export function createGtagStub(target: { dataLayer?: unknown[] }): (...args: unknown[]) => void {
  return function gtag(): void {
    // eslint-disable-next-line prefer-rest-params
    target.dataLayer?.push(arguments)
  }
}

/**
 * Clarity's queue stub, which MUST exist BEFORE the tag script is injected.
 *
 * The tag script does not define `window.clarity` — it CALLS it, on its first
 * line, to queue its own initialisation. Injecting the tag without this stub
 * produces `TypeError: a[c] is not a function` inside a third-party file and
 * nothing else: no failing build, no visible symptom, and a recorder that
 * never records.
 *
 * `??=` rather than an unconditional assignment, because the real Clarity
 * replaces this stub once it loads and drains `.q`. Overwriting it afterwards
 * would throw away a live recorder and re-queue into an object nobody reads.
 *
 * Same contract as the gtag stub above, and dropped for the same reason: the
 * queue takes `arguments`, which is what a modernising rewrite deletes first.
 */
export function createClarityStub(target: {
  clarity?: ((...args: unknown[]) => void) & { q?: unknown[] }
}): void {
  target.clarity ??= Object.assign(
    function clarity(): void {
      const self = target.clarity
      if (self === undefined) {
        return
      }
      self.q ??= []
      // eslint-disable-next-line prefer-rest-params
      self.q.push(arguments)
    },
    { q: [] as unknown[] }
  )
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
