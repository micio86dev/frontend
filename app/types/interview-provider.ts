/* eslint-disable no-unused-vars */
/**
 * Provider-agnostic contract for the candidate interview session.
 *
 * The composable layer (useInterviewSession) and UI talk ONLY to this interface,
 * making HeyGen and Tavus interchangeable behind it.
 *
 * Ported from legacy-demo/src/providers/types.ts with the following changes:
 *   - StartConfig is FULLY explicit: no [k:string]:unknown index signature (D27 / strict TS)
 *   - endPhrase and finalPhrase are REQUIRED, non-optional fields (D4 contract)
 *   - Hardcoded phrase constants removed: phrases come from the /start API response
 *     (question_context.end_phrase and question_context.final_phrase)
 *
 * API → StartConfig field mapping (from POST /candidate/interview/start 201 response):
 *   provider_token                 → sessionToken    (HeyGen)
 *   conversation_url               → conversationUrl (Tavus)
 *   question_context.end_phrase    → endPhrase       (both providers — intermediate question signal)
 *   question_context.final_phrase  → finalPhrase     (both providers — last question signal)
 *
 * IMPORTANT: end_phrase and final_phrase are NESTED inside question_context — they are NOT
 * top-level fields on the /start response. Reading from the top level yields `undefined`,
 * which triggers the absent-phrase guard and transitions to `terminal`. Always destructure as:
 *   const { end_phrase, final_phrase } = response.question_context
 */

/** The set of supported provider backends. */
export type ProviderName = 'heygen' | 'tavus'

/** UI-facing connection lifecycle states. Providers map their own lifecycle onto these. */
export type ProviderState =
  'connecting' | 'ready' | 'listening' | 'speaking' | 'stopped' | 'complete'

/** Events the InterviewProvider can emit. */
export type ProviderEvent = 'transcript' | 'state' | 'error'

/** Normalized transcript entry emitted on each 'transcript' event. */
export interface TranscriptEntry {
  role: 'user' | 'avatar'
  text: string
  ts: number
  seq?: number
}

/**
 * Typed, closed config passed from useInterviewSession → createProvider → provider.start().
 *
 * NO index signature ([k:string]:unknown) — banned under strict + exactOptionalPropertyTypes.
 *
 * Both endPhrase and finalPhrase MUST be non-empty strings before provider.start() is called.
 * If either is absent after the /start response, the HeyGen provider MUST emit 'error' and
 * the state machine transitions to 'terminal' (NOT 'error', which is retryable).
 */
export interface StartConfig {
  /** The DB session_id from the POST /start response (used in subsequent endpoint calls). */
  dbSessionId: number
  /** Provider-assigned session identifier returned by provider.start() (optional). */
  providerSessionId?: string
  /** HeyGen authentication token — from /start response field `provider_token`. */
  sessionToken?: string
  /** Tavus room URL — from /start response field `conversation_url`. */
  conversationUrl?: string
  /**
   * Project-language phrase signalling end of an intermediate question.
   * Source: /start response `question_context.end_phrase` (NOT top-level).
   * HeyGen: avatar speaks this phrase verbatim; matched via matchesEndPhrase.
   * Tavus: unused for completion detection (uses tool_call instead).
   */
  endPhrase: string
  /**
   * Project-language phrase signalling end of the FINAL question.
   * Source: /start response `question_context.final_phrase` (NOT top-level).
   * Distinct from endPhrase to disambiguate last-question completion.
   */
  finalPhrase: string
}

/**
 * Provider-agnostic interview session interface.
 *
 * Implementations: HeyGenProvider (app/providers/heygen.ts),
 *                  TavusProvider  (app/providers/tavus.ts)
 * Factory:         createProvider (app/providers/factory.ts)
 */
export interface InterviewProvider {
  /**
   * Mounts and starts the provider session.
   * First param: DOM element to mount the video/avatar into.
   * Second param: Session config derived from the /start API response.
   * Returns: Promise resolving with an optional provider-assigned session id.
   */
  start(mountEl: HTMLElement, cfg: StartConfig): Promise<{ providerSessionId?: string }>

  /** Toggle microphone mute/unmute. */
  toggleMic(): Promise<void>

  /** Tear down the session and release resources. */
  stop(): Promise<void>

  /**
   * Subscribe to provider events.
   * First param: 'transcript' | 'state' | 'error'
   * Second param: Callback receiving the event payload.
   */
  on(evt: ProviderEvent, cb: (payload: unknown) => void): void

  /**
   * Optional: ~20s before the question timer expires, nudge the avatar to wrap up.
   * HeyGen: calls session.message() with a wrap-up prompt.
   * Tavus: no-op (relies on server-side hard cap).
   */
  nudgeWrapUp?(): void
}
