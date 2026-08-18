import * as Sentry from '@sentry/nuxt'
import { sentryPosture } from './app/utils/sentry-init'
import {
  scrubBreadcrumb,
  scrubSentryEvent,
  type ScrubbableBreadcrumb,
  type ScrubbableEvent,
} from './app/utils/sentry-scrub'

/**
 * Sentry — server-side (Nitro / SSR), C13 task 5.1, Nuxt half.
 *
 * Same posture and the same scrubber as `sentry.client.config.ts`. The
 * server side is the MORE dangerous half by SDK default: unlike the browser
 * SDK, Sentry's server SDKs attach request headers and cookies when
 * `sendDefaultPii` is not explicitly pinned off — and this app's SSR
 * requests can carry the candidate's session cookie/JWT on every render.
 */

const config = useRuntimeConfig()
const posture = sentryPosture(
  String(config.public.sentryDsn ?? ''),
  String(config.public.appEnv ?? 'local')
)

Sentry.init({
  ...posture,
  beforeSend: (event) =>
    scrubSentryEvent(event as unknown as ScrubbableEvent) as unknown as typeof event,
  beforeBreadcrumb: (breadcrumb) =>
    scrubBreadcrumb(breadcrumb as unknown as ScrubbableBreadcrumb) as unknown as typeof breadcrumb,
})
