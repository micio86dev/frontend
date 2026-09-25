/**
 * useEmbedBridge — the `/embed/{token}` iframe's own half of the `@beai/embed`
 * postMessage protocol (public-api SPEC §4.3/§4.4).
 *
 * The mirror-image counterparty of `embed/src/embed.ts`'s `BeaiEmbed` class
 * (the HOST side, already built this session) — see that file's own
 * `handleMessage`/`postToIframe` for the wire-level discipline this
 * composable adapts. The envelope shape (`source`, `version`, `type`,
 * `payload`) and event names are duplicated here from `embed/src/protocol.ts`
 * rather than imported: `@beai/embed` is a separate package in a separate git
 * submodule with no dependency relationship to `frontend` today, and adding
 * one for a handful of string literals and two type unions would be a much
 * larger change than this feature's actual scope.
 *
 * ORIGIN VALIDATION — adapted, not copied verbatim
 * -------------------------------------------------
 * The SDK validates inbound messages against `event.origin !== this.embedOrigin`,
 * a value the HOST explicitly configures at `mount()`-time. The IFRAME has no
 * such pre-configured value — it does not know in advance which domain will
 * embed it. It learns its organization's allowed origins from the SAME
 * `allowed_domains` list `server/middleware/embed-csp.ts` already resolved
 * for the `Content-Security-Policy` header (`getAllowedOrigins()`, supplied
 * by the caller — `app/pages/embed/[token].vue` fetches the SAME
 * `GET /api/embed/frame-policy` endpoint client-side). An inbound message is
 * accepted only if BOTH:
 *   (a) `event.source === window.parent` (structural — cannot be spoofed by
 *       a different frame, the same check `embed.ts` makes against its own
 *       iframe's `contentWindow`), AND
 *   (b) `event.origin`'s hostname is in the resolved allow-list.
 * Outbound messages before any inbound message has been received (the very
 * first `ready`) are posted with `targetOrigin: '*'` — the iframe cannot know
 * the host's exact origin before hearing from it, and every outbound payload
 * is a non-PII protocol event by SPEC §4.3 contract ("No candidate PII,
 * transcript, or scores cross postMessage"), so a wildcard target on that ONE
 * message is the accepted, standard shape for an embeddable widget's initial
 * handshake. Every SUBSEQUENT outbound message targets the CONFIRMED host
 * origin from the first validated inbound message instead — tightening the
 * moment it can.
 */

import { isHostnameAllowed } from '~/app/utils/embed-csp'

const EMBED_MESSAGE_SOURCE = 'beai-embed' as const
const EMBED_MESSAGE_VERSION = 1 as const

export type OutgoingEventType =
  | 'ready'
  | 'consent:granted'
  | 'permissions:denied'
  | 'started'
  | 'question:changed'
  | 'completed'
  | 'error'
  | 'resize'

export interface QuestionChangedPayload {
  index: number
  total: number
}

export interface CompletedPayload {
  interviewId: string
}

export interface ErrorPayload {
  code: string
  message: string
  recoverable: boolean
}

export interface ResizePayload {
  height: number
}

/** Payload shape for each outgoing event; `undefined` means "no payload". */
export interface OutgoingPayloadMap {
  ready: undefined
  'consent:granted': undefined
  'permissions:denied': undefined
  started: undefined
  'question:changed': QuestionChangedPayload
  completed: CompletedPayload
  error: ErrorPayload
  resize: ResizePayload
}

/** Host → iframe message types this bridge understands. `set-theme` is accepted but a no-op — white-labeling the embed page is `@beai/embed`'s own concern (out of scope here). */
type IncomingMessageType = 'start' | 'end' | 'set-theme'

interface RawEnvelope {
  source: unknown
  version: unknown
  type: unknown
}

function isValidEnvelopeShape(data: unknown): data is RawEnvelope & { type: string } {
  if (typeof data !== 'object' || data === null) return false
  const candidate = data as Record<string, unknown>
  return (
    candidate['source'] === EMBED_MESSAGE_SOURCE &&
    candidate['version'] === EMBED_MESSAGE_VERSION &&
    typeof candidate['type'] === 'string'
  )
}

function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin).hostname
  } catch {
    return null
  }
}

export interface UseEmbedBridgeOptions {
  /** Bare hostnames this candidate's organization allows to embed this page — same source as the CSP header. */
  getAllowedOrigins: () => string[]
  /**
   * Called once a VALIDATED `start` message arrives from the host. Per SPEC
   * §4.4 ("start() before consent is queued, not executed"), this bridge
   * itself never gates anything on it — the candidate-driven consent/device-
   * check flow always runs regardless of whether or when `start` arrives.
   * The caller may use it purely informationally (e.g. analytics) without
   * risking a bypass, because there is nothing here TO bypass.
   */
  onStart?: () => void
}

export interface UseEmbedBridgeReturn {
  /** Attaches the `message` listener. Safe to call once; a second call is a no-op. */
  attach: () => void
  /** Detaches the listener. Safe to call repeatedly. */
  detach: () => void
  /**
   * Posts a protocol event to the host, IF running inside an iframe
   * (`window.parent !== window`). A no-op outside an iframe (e.g. the hosted
   * `/interview/session` page also renders `InterviewSession.vue`, which has
   * no bridge — but a defensive no-op costs nothing and needs no separate
   * "am I embedded" flag duplicated at every call site).
   */
  post: <T extends OutgoingEventType>(type: T, payload?: OutgoingPayloadMap[T]) => void
}

export function useEmbedBridge(options: UseEmbedBridgeOptions): UseEmbedBridgeReturn {
  let listening = false
  let onMessageBound: ((event: MessageEvent) => void) | null = null
  let confirmedHostOrigin: string | null = null

  function handleMessage(event: MessageEvent): void {
    if (typeof window === 'undefined' || event.source !== window.parent) return
    if (!isValidEnvelopeShape(event.data)) return

    const hostname = hostnameOf(event.origin)
    if (!hostname || !isOriginAllowed(hostname)) return

    // First validated message from the host confirms its origin — every
    // later `post()` targets it directly instead of '*'.
    confirmedHostOrigin = event.origin

    // Only a recognized host→iframe message type reaches this branch — an
    // unknown `type` string still passed `isValidEnvelopeShape()`, so it is
    // narrowed here rather than trusted from the envelope check alone.
    const type = event.data.type as IncomingMessageType
    if (type === 'start') {
      options.onStart?.()
    }
    // 'end' and 'set-theme': accepted (validated, no warning logged) but
    // deliberately inert here — 'end' has no defined page-side action yet
    // (the candidate's own controls own ending an in-progress interview),
    // and 'set-theme' is `@beai/embed`'s white-label concern, out of scope
    // for this page (see this module's own top-of-file doc).
  }

  function isOriginAllowed(hostname: string): boolean {
    return isHostnameAllowed(hostname, options.getAllowedOrigins())
  }

  function attach(): void {
    if (listening || typeof window === 'undefined') return
    listening = true
    onMessageBound = handleMessage
    window.addEventListener('message', onMessageBound)
  }

  function detach(): void {
    if (onMessageBound && typeof window !== 'undefined') {
      window.removeEventListener('message', onMessageBound)
    }
    onMessageBound = null
    listening = false
  }

  function post<T extends OutgoingEventType>(type: T, payload?: OutgoingPayloadMap[T]): void {
    if (typeof window === 'undefined' || window.parent === window) return

    const message = {
      source: EMBED_MESSAGE_SOURCE,
      version: EMBED_MESSAGE_VERSION,
      type,
      payload,
    }
    window.parent.postMessage(message, confirmedHostOrigin ?? '*')
  }

  return { attach, detach, post }
}
