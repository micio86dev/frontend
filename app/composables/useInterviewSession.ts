/**
 * useInterviewSession — Interview session state machine composable (Task 3.2 GREEN)
 *
 * Orchestrates the per-competency interview loop:
 *   POST /start → POST /utterance → POST /integrity → POST /end
 *
 * POST /snapshot is NOT owned here: the periodic proctoring snapshot is captured
 * from the camera video element, which only `useProctor` holds. `useProctor.takeSnapshot()`
 * is the single authoritative snapshot path; this composable supplies it with the
 * session id via the `sessionId` ref.
 *
 * State machine:
 *   idle → device_check → connecting → live → end_of_question → paused → done | error | terminal
 *
 * Provider ownership: this composable CREATES the provider and wires its events, then
 * publishes it via `players` (and the `activeProvider`/`activeConfig` aliases).
 * `AvatarPlayer` mounts each published handle and calls `provider.start(videoEl, config)`
 * — the provider must be attached to the real <video> element, which does not exist
 * until the page renders the player. Starting the provider here against a detached
 * element left the interviewer's media unattached.
 *
 * SSR invariant: NO module-scope browser globals. All window/navigator access is inside
 * functions guarded by import.meta.client or callback context.
 *
 * Design refs: D3, D4, D5 (resize listener ownership), D10 (testing strategy)
 *
 * ---------------------------------------------------------------------------
 * invisible-competency-handover (D1-D9, F1-F4)
 * ---------------------------------------------------------------------------
 * On a HeyGen `continue`, the outgoing provider session stays mounted, live and
 * visible while the incoming session connects behind it, and only crosses over
 * once the incoming has painted a real frame. Two `ProviderSession` handles can
 * therefore coexist for a bounded window (`HANDOVER_BOUND_MS`):
 *
 *   activeSession   — the handle the candidate is looking at right now.
 *   incomingSession — mounted, hidden and muted; promoted once it paints.
 *
 * D2 is the crux: every provider event handler closes over the HANDLE that
 * emitted it and resolves by IDENTITY (`handle === activeSession.value` /
 * `=== incomingSession.value`) instead of reading shared module state. Reading
 * shared state with two live sessions does not merely overlap — it corrupts:
 * an outgoing `transcript` would post against the incoming `dbSessionId`, an
 * outgoing `ready` would flip the machine live prematurely, an outgoing
 * `error` would kill a healthy incoming session.
 *
 * D3: `handle.provider.stop()` is wrapped IDEMPOTENT at creation
 * (`withIdempotentStop`, below) — the underlying provider is torn down at
 * MOST once no matter how many call sites reach for it. This is a real
 * guarantee, not a call-ordering coincidence: `AvatarPlayer:onUnmounted`'s
 * structural `stop()` (fired when a `ProviderSession` drops out of
 * `players`) and every pre-existing explicit call site (`endQuestion`,
 * `teardown`, the resize/unsupported gate, `confirmDevices`'s resume guard)
 * can all reach for the same handle without coordinating, because the
 * wrapper — not the caller's discipline — is what makes "exactly once" true.
 *
 * ---------------------------------------------------------------------------
 * Post-review restructuring — the handover lifecycle is now TOTAL
 * ---------------------------------------------------------------------------
 * A four-lens review of the first cut found five distinct symptoms that were
 * really one defect: the handover had FIVE real exit sites (promote, the
 * bound firing, an incoming error, an incoming `/start` failure, and page
 * teardown) but only four named functions, and two more call sites
 * (`teardown()`, `confirmDevices()`) inlined their OWN ad hoc "stop both,
 * clear both". Two functions now own the WHOLE lifecycle, and every exit —
 * old and new — is routed through them:
 *
 *   `endHandover()`      — the ONLY place `handoverActive`, the bound timer,
 *                           the crossfade (promote) timer, and the NEW
 *                           connecting-ceiling timer are ever cleared.
 *   `clearIncomingProvider()` — the ONLY place the incoming slot is ever
 *                           stopped and nulled.
 *
 * `transitionTo()` itself now calls both, unconditionally, whenever the
 * machine lands on `done` | `error` | `terminal` — so ANY exit that reaches
 * one of those states (today's or a future one) tears down an in-flight
 * handover FOR FREE, without that call site having to remember to. This is
 * also what closes a bug found WHILE restructuring, not named by the review:
 * a bound timer armed before a 401/malformed `/start` sent the machine
 * `terminal` used to keep ticking and could resurrect a terminal session back
 * to `connecting` ten seconds later.
 *
 * `handoverActive` (not `incomingSession.value !== null`) is what
 * `endQuestion()` and `pause()` guard on — it is set the INSTANT
 * `beginHandover()` runs, before `/end` and before the incoming even exists,
 * closing the exact window a per-question timer could previously race.
 *
 * A NEW connecting-ceiling timer, armed only when the bound fires
 * (`releaseOutgoing`), bounds the ONE `connecting` entry point this feature
 * added that was not already bounded by `startSession()`'s own retry loop —
 * an incoming that reports readiness but never paints, or one whose retries
 * are still exhausting after the bound already released the outgoing. It
 * degrades to the existing retryable `error` screen, never an infinite wait.
 * `CONNECTING_CEILING_MS` is a NEW number this restructuring introduces — it
 * is not pinned by the spec the way `HANDOVER_BOUND_MS` is, and needs the
 * same kind of product sign-off; see the constant's own comment.
 *
 * Tavus is unchanged this cut (D9): the handover only ever begins when
 * `handle.providerName === 'heygen'`.
 */

import { ref, shallowRef, computed, type ComputedRef } from 'vue'
import { createProvider } from '~/app/providers/factory'
import type { InterviewProvider, ProviderName, StartConfig } from '~/app/types/interview-provider'
import type { operations } from '~~/types/api'

import type { IntegrityEventInternal } from '~/app/utils/proctor-config'
import {
  candidateFetch,
  flushIntegrityKeepalive,
  CandidateUnauthorizedError,
} from '~/app/utils/candidate-api'
import { useCandidateSession } from '~/app/composables/useCandidateSession'

/**
 * The `/candidate/interview/start` success body, DERIVED from the generated
 * client.
 *
 * It used to be hand-written here twice — once as this `candidateFetch<…>`
 * generic and once as `isValidStartResponse`'s type predicate — and both copies
 * had already drifted from the contract they claimed to describe:
 * `session_id` is an integer in the spec and was typed `string` here, the same
 * for `question_context.question_index`, and `audio_only` is published as
 * REQUIRED while the local copy called it optional and carried a comment
 * defending that on the grounds of an older API version that does not exist.
 *
 * `bun run codegen` regenerates `types/api.ts` from the committed spec and
 * `scripts/check-client-drift.sh` guards it — but nothing in the app imported
 * the artifact, so the check was green while the app read a parallel truth.
 *
 * The RUNTIME validation below is unchanged and still earns its place: a type
 * is a claim about what the server promised, never evidence of what it sent.
 */
type StartResponse = operations['interview.start']['responses'][200]['content']['application/json']

/**
 * The `/candidate/interview/end` 200 body, DERIVED for the same reason.
 *
 * It was an inline generic inventing three fields, and the committed spec said
 * the body was EMPTY — Scramble could not follow `buildDirective()`, so it
 * published nothing. The whole directive machine (continue / pause / done) and
 * the progress readout hung off fields the contract denied existed, and the
 * drift check could not see it: that check compares the spec to the generated
 * types, never to a hand-written generic. The API now publishes the shape.
 */
type EndResponse = operations['interview.end']['responses'][200]['content']['application/json']

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionState =
  | 'idle'
  | 'device_check'
  | 'connecting'
  | 'live'
  | 'end_of_question'
  | 'paused'
  | 'done'
  | 'error'
  | 'terminal'

/**
 * What the server says happens after a competency ends (D7).
 *
 * `noop` is not a server value — it is how this composable represents an HTTP
 * 409, the loser of the avatar-complete/timer race. It has no directive and
 * must not transition.
 */
export type EndDirective = 'continue' | 'pause' | 'done' | 'noop'

export type TerminalReason = '403' | 'absent_phrase' | 'session_expired' | 'malformed_response'

/**
 * Reason passed to POST /end when a question is cut short.
 *
 * `timeout` only. The Skip control is gone (D11): a candidate must not be able
 * to skip a competency, so the timer is the sole client-side early end. The API
 * still accepts `skipped` — removing an enum value from a shipped contract is
 * churn with no benefit — but nothing here can produce it.
 */
export type EndQuestionReason = 'timeout'

/**
 * A live (or connecting) provider session, identified by its DB session id.
 *
 * D1: two named slots hold at most one of these each (`activeSession` /
 * `incomingSession`) — never a queue. `dbSessionId` REPLACES the old
 * module-level `currentSessionId` as the id every event handler resolves
 * against (D2).
 */
export interface ProviderSession {
  provider: InterviewProvider
  config: StartConfig
  dbSessionId: number
  /** From the `/start` response. Never surfaced to the UI (D9) — provider-anonymity. */
  providerName: ProviderName
  /**
   * This project's template runs voice-only (`/start` → `audio_only`).
   *
   * Per SESSION rather than read once for the interview: a competency handover
   * mints a fresh `/start`, and reading it from the session that is actually
   * mounted keeps the answer attached to the stream it describes.
   *
   * Not provider identity and safe to surface: it says the interview has no
   * video, never who renders it.
   */
  audioOnly: boolean
}

/** The visual/audio role a mounted provider session currently plays (D6). */
export type HandoverRole = 'live' | 'incoming' | 'entering'

/** One entry of `players` — everything `session.vue`'s keyed v-for needs. */
export interface SessionPlayer {
  key: number
  provider: InterviewProvider
  config: StartConfig
  role: HandoverRole
  /** Downlink control for AvatarPlayer's `muted` prop (D4). */
  muted: boolean
  /** Render the voice visualizer instead of a video element. */
  audioOnly: boolean
}

export interface UseInterviewSessionOptions {
  /** Pending integrity events for sendBeacon flush on resize. Managed externally by useProctor. */
  getPendingIntegrityEvents?: () => IntegrityEventInternal[]
  /**
   * Called with the exact events that were successfully handed to sendBeacon, so the
   * owner of the buffer can acknowledge (drop) them. NOT called when the beacon fails —
   * unacknowledged events stay pending rather than being silently lost.
   */

  onIntegrityEventsFlushed?: (events: IntegrityEventInternal[]) => void
}

export interface UseInterviewSessionReturn {
  state: ReturnType<typeof ref<SessionState>>
  retryAttemptCount: ReturnType<typeof ref<number>>
  currentCompetencyIndex: ReturnType<typeof ref<number>>
  terminalReason: ReturnType<typeof ref<TerminalReason | null>>
  /** DB session id from the latest /start response — null until the first /start succeeds. */
  sessionId: ReturnType<typeof ref<number | null>>
  /** Competencies ended so far, from the /end directive. Null until the first /end. */
  endedCompetencies: ReturnType<typeof ref<number | null>>
  /** Total competencies in the project, from the /end directive. */
  totalCompetencies: ReturnType<typeof ref<number | null>>
  /**
   * Provider awaiting mount by AvatarPlayer; null whenever no question is in flight.
   *
   * D1: read-only COMPUTED alias of `activeSession` — the live slot only. A
   * hidden `incomingSession` never affects this.
   */
  activeProvider: ComputedRef<InterviewProvider | null>
  /** StartConfig for `activeProvider`; published together with it, never separately. */
  activeConfig: ComputedRef<StartConfig | null>
  /**
   * Every provider session `session.vue` must currently render, keyed by
   * `dbSessionId` (D6). At most two entries: the live slot and, during a
   * handover, the incoming slot. Render from ONE keyed list — two separate
   * elements would unmount and `stop()` the session that just won the
   * handover.
   */
  players: ComputedRef<SessionPlayer[]>
  /** True while an incoming HeyGen session is connecting behind the live one (D2). */
  handoverInFlight: ComputedRef<boolean>
  acceptConsent: () => void
  /** @param audioDeviceId Microphone from device check; remembered for later competencies. */
  confirmDevices: (audioDeviceId?: string) => void
  pause: () => void
  resume: () => void
  retry: () => void
  nextCompetency: () => void
  /** End the current question early (5-minute timer expiry, or the candidate skipping). */

  endQuestion: (reason: EndQuestionReason) => Promise<void>
  teardown: () => Promise<void>
  /**
   * Called by `session.vue` when a `SessionPlayer`'s `<AvatarPlayer>` emits
   * `painted`. A no-op unless `dbSessionId` matches the CURRENT incoming
   * handle — the live handle's own paint only drives its own opacity (D6).
   */
  notifyPainted: (dbSessionId: number) => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 3000

/**
 * D5: the overlap's upper bound, and its release backstop. Armed the instant
 * the live handle's `complete` is handled (before `POST /end`), cancelled by
 * `endHandover()` — the single exit both `promote()` and `releaseOutgoing()`
 * route through. Not configurable: the spec fixes the number.
 */
const UTTERANCE_DRAIN_CEILING_MS = 3_000

const HANDOVER_BOUND_MS = 10_000

/** DESIGN.md §10 — fade, 200ms, ease-in-out; instant under reduced motion. */
const CROSSFADE_MS = 200

/**
 * Bounds how long the candidate can sit in the bound-exceeded `connecting`
 * fallback before the machine gives up and surfaces the existing retryable
 * `error` screen (B3/B4/C3 from the four-lens review).
 *
 * Armed once, by `releaseOutgoing()`, at the exact moment `HANDOVER_BOUND_MS`
 * has already fired — it does not extend the overlap, it bounds what was an
 * UNBOUNDED wait after the overlap already ended. Covers two distinct
 * failures with one mechanism: an incoming that reports readiness but never
 * paints (a throttled tab, a stalled decoder — nothing else would ever
 * resolve this), and an incoming whose own `/start` retries (up to
 * `MAX_ATTEMPTS` × `RETRY_DELAY_MS` backoff, worst case ~6s, plus network
 * latency) are still exhausting after the bound already released the
 * outgoing.
 *
 * UNLIKE `HANDOVER_BOUND_MS`, this number is NOT pinned by the spec — it is
 * introduced by this restructuring to close a genuine "no ceiling at all"
 * gap. 20s is comfortably above the worst-case retry backoff while still
 * being a firm, finite bound; it needs the same product sign-off
 * `HANDOVER_BOUND_MS` already has, not just an engineering judgment call.
 */
const CONNECTING_CEILING_MS = 20_000

// ---------------------------------------------------------------------------
// Provider error normalisation
// ---------------------------------------------------------------------------

/**
 * Extract the machine-readable error code from a provider 'error' payload.
 *
 * Providers emit `{ code, message }` objects (heygen.ts / tavus.ts); the mock and
 * some tests emit a bare string. Reading the payload as a string unconditionally
 * meant `absent_phrase` was never matched against a real provider, and the state
 * fallback below silently absorbed every other failure under the same reason.
 */
function providerErrorCode(payload: unknown): string | null {
  if (typeof payload === 'string') return payload
  if (payload && typeof payload === 'object') {
    const code = (payload as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}

// ---------------------------------------------------------------------------
// /start response shape guard
// ---------------------------------------------------------------------------

/**
 * Explicit shape guard for the `/start` response, checked BEFORE
 * `question_context.end_phrase` is ever read.
 *
 * Without this, an unguarded destructure throws inside the try block on a
 * bad body; `status` is undefined on a plain TypeError, so it used to land in
 * the retryable `error` state — retrying forever against a server that will
 * answer identically. That is the same defect class the 401 fix addresses:
 * retry cannot fix a contract violation, so this is a non-retryable terminal.
 */
function isValidStartResponse(response: unknown): response is StartResponse {
  if (!response || typeof response !== 'object') return false
  const r = response as Record<string, unknown>

  // `number` ONLY, as the contract publishes it. Also accepting a string
  // widened the predicate past the type it returns: `response is StartResponse`
  // asserts `session_id: number`, so a string body passed a guard whose whole
  // job is to catch exactly that shape drift.
  if (typeof r['session_id'] !== 'number') return false

  // CHECKED, because the predicate claims it. `StartResponse` derives from the
  // generated client, where `audio_only` is REQUIRED — so a guard that returns
  // `response is StartResponse` without looking at it makes a claim it has not
  // earned. A server that dropped the field would pass, and the app would
  // silently mount a video panel for a voiceless stream: precisely the contract
  // drift this guard exists to catch.
  if (typeof r['audio_only'] !== 'boolean') return false
  if (typeof r['provider'] !== 'string' || r['provider'].length === 0) return false

  const questionContext = r['question_context']
  if (!questionContext || typeof questionContext !== 'object') return false
  const q = questionContext as Record<string, unknown>

  if (typeof q['end_phrase'] !== 'string' || q['end_phrase'].length === 0) return false
  if (typeof q['final_phrase'] !== 'string' || q['final_phrase'].length === 0) return false
  // Same reason: the generated type says `number`, so a non-null check alone
  // let a string through a claim that it is one.
  if (typeof q['question_index'] !== 'number') return false

  return true
}

// ---------------------------------------------------------------------------
// Idempotent teardown (C2)
// ---------------------------------------------------------------------------

/**
 * Wraps `provider.stop()` so the underlying teardown runs AT MOST once, no
 * matter how many call sites reach for it — mutated in place, same object
 * identity, so every existing `.toBe()` / registry-index assertion across
 * the test suite is unaffected.
 *
 * This is what makes "exactly once" a real guarantee again (C2 from the
 * four-lens review) rather than a call-ordering coincidence: `teardown()`,
 * the resize/unsupported gate, `confirmDevices()`'s resume guard, and
 * `AvatarPlayer:onUnmounted`'s structural `stop()` (D3) can all call
 * `handle.provider.stop()` freely — concurrently, redundantly, defensively —
 * and the real SDK/network teardown still only happens once.
 */
function withIdempotentStop(provider: InterviewProvider): InterviewProvider {
  const originalStop = provider.stop.bind(provider)
  let stopPromise: Promise<void> | null = null
  provider.stop = () => {
    if (!stopPromise) stopPromise = originalStop()
    return stopPromise
  }
  return provider
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export function useInterviewSession(
  options: UseInterviewSessionOptions = {}
): UseInterviewSessionReturn {
  // ---- State ---------------------------------------------------------------
  const state = ref<SessionState>('idle')
  const retryAttemptCount = ref(0)
  const currentCompetencyIndex = ref(0)
  const terminalReason = ref<TerminalReason | null>(null)
  const sessionId = ref<number | null>(null)
  /** Server-fed progress (D6/D7). Never derived here — deriving it is the defect. */
  const endedCompetencies = ref<number | null>(null)
  const totalCompetencies = ref<number | null>(null)

  /** D1: the live slot — what the candidate is looking at right now. */
  const activeSession = shallowRef<ProviderSession | null>(null)
  /** D1: mounted, hidden, muted; promoted once it paints. */
  const incomingSession = shallowRef<ProviderSession | null>(null)
  /** True once the incoming handle has painted and its fade-in has begun (D6). */
  const incomingEntering = ref(false)
  /**
   * True for the ENTIRE handover window — from the instant `beginHandover()`
   * runs (before `/end`, before the incoming exists) until `endHandover()`
   * runs. `incomingSession.value !== null` used to stand in for this and
   * left a gap: `beginHandover()` mutes the outgoing and arms the bound
   * BEFORE `/end`, and `incomingSession` is only populated several round
   * trips later. `endQuestion()` and `pause()` guard on THIS flag now (B2).
   */
  const handoverActive = ref(false)

  const activeProvider = computed(() => activeSession.value?.provider ?? null)
  const activeConfig = computed(() => activeSession.value?.config ?? null)
  const handoverInFlight = computed(() => handoverActive.value)

  const players = computed<SessionPlayer[]>(() => {
    const list: SessionPlayer[] = []
    const live = activeSession.value
    if (live) {
      list.push({
        key: live.dbSessionId,
        provider: live.provider,
        config: live.config,
        role: 'live',
        muted: false,
        audioOnly: live.audioOnly,
      })
    }
    const incoming = incomingSession.value
    if (incoming) {
      list.push({
        key: incoming.dbSessionId,
        provider: incoming.provider,
        config: incoming.config,
        role: incomingEntering.value ? 'entering' : 'incoming',
        muted: !incomingEntering.value,
        audioOnly: incoming.audioOnly,
      })
    }
    return list
  })

  // ---- Internal refs -------------------------------------------------------
  let isResuming = false
  let resizeListener: (() => void) | null = null
  /** Microphone chosen at device check; reused for every subsequent competency. */
  let confirmedAudioDeviceId: string | undefined
  let handoverBoundTimer: ReturnType<typeof setTimeout> | null = null
  let promoteTimer: ReturnType<typeof setTimeout> | null = null
  let connectingCeilingTimer: ReturnType<typeof setTimeout> | null = null

  // ---- Helpers -------------------------------------------------------------

  /**
   * Observability (four-lens review "also fix"): every handover degrade path
   * is deliberately non-throwing, so nothing recorded them happening — a full
   * day was lost this week diagnosing a defect that left no trace. A
   * structured, greppable breadcrumb on each one is cheap and non-fatal by
   * construction (console calls do not throw).
   */
  function logHandoverEvent(event: string, detail?: Record<string, unknown>) {
    console.info(`[handover] ${event}`, detail ?? {})
  }

  function isMock(): boolean {
    const config = useRuntimeConfig()
    const value = (config.public as Record<string, unknown>).interviewProviderMock
    // C10 PR7 regression: Nuxt/Nitro coerces NUXT_PUBLIC_* env values via destr at
    // runtime, so a real deployment exposes the BOOLEAN `true`, not the string
    // 'true' — despite the string default ('') suggesting otherwise. A strict
    // `=== 'true'` comparison silently never activated the mock provider outside
    // of Vitest (which stubs useRuntimeConfig with literal strings).
    return value === true || value === 'true'
  }

  function transitionTo(next: SessionState) {
    state.value = next

    // Remove resize listener on terminal states
    if (next === 'done' || next === 'terminal' || next === 'error') {
      removeResizeListener()
    }

    // The provider only exists for the duration of a question. Unpublishing it here
    // unmounts AvatarPlayer, which releases the media session on its way out.
    if (next === 'end_of_question' || next === 'done' || next === 'error' || next === 'terminal') {
      clearActiveProvider()
    }

    // Verification Finding #1: the candidate session MUST be cleared on
    // EVERY `done`/`terminal` transition — not only on a live 401 (which
    // candidateFetch already clears internally, redundantly-but-harmlessly
    // re-cleared here too). Centralized here, not scattered per catch block,
    // so 403, absent_phrase, malformed_response, session_expired, and any
    // future terminal reason all go through the SAME line — a per-branch
    // patch is exactly the shape of fix the next new reason could forget.
    // `error` is deliberately excluded: it is retryable and the session may
    // still be valid (a 502/429 is an infrastructure failure, not an auth one).
    if (next === 'done' || next === 'terminal') {
      useCandidateSession().clear()
    }

    // Post-review restructuring: ANY transition to done/error/terminal tears
    // down an in-flight handover UNCONDITIONALLY — the single place this is
    // guaranteed, not a discipline every exit path has to remember. Found
    // while restructuring (not one of the review's five named findings): a
    // bound timer armed before a 401/malformed `/start` sent the machine
    // `terminal` used to keep ticking and could fire ten seconds later,
    // resurrecting a terminal session back to `connecting`. `connecting`
    // itself is deliberately EXCLUDED — the bound-exceeded fallback (D5)
    // transitions here on purpose while leaving a hidden incoming alive to
    // be promoted once it paints.
    if (next === 'done' || next === 'error' || next === 'terminal') {
      endHandover()
      clearIncomingProvider()
    }
  }

  /** D1: clears the LIVE slot only — a hidden incoming is untouched by this. */
  function clearActiveProvider() {
    activeSession.value = null
  }

  function removeResizeListener() {
    if (resizeListener && typeof window !== 'undefined') {
      window.removeEventListener('resize', resizeListener)
      resizeListener = null
    }
  }

  function attachResizeListener() {
    if (typeof window === 'undefined') return

    resizeListener = () => {
      if (window.innerWidth < 1024) {
        // Flush integrity before navigating away, via the shared keepalive
        // transport (D-C) — replaces the hand-built `navigator.sendBeacon`
        // duplicate that used to live here (a second copy was a second chance
        // to miss the Authorization header). `fetch(..., { keepalive: true })`
        // returns a promise that will not settle before navigation completes,
        // so acknowledgement happens on dispatch, not on settlement — and if
        // the request never actually lands (refused, oversized, or racing the
        // navigation it precedes), these events are already acknowledged and
        // gone from the pending buffer, with only a console.warn (from a page
        // that is about to navigate away) marking the loss. Same ceiling
        // sendBeacon already had; written down here because it was not before.
        const pending = options.getPendingIntegrityEvents?.() ?? []
        if (pending.length > 0) {
          const payload = {
            session_id: activeSession.value?.dbSessionId ?? null,
            events: pending.map((e) => ({ kind: e.type, ts: e.ts, payload: e.meta ?? null })),
          }
          flushIntegrityKeepalive(payload)
          options.onIntegrityEventsFlushed?.(pending)
        }

        // Stop provider before navigating (suppress errors — non-fatal during teardown).
        // Pre-existing, unrelated to the handover machinery — kept explicit and
        // immediate since the page is navigating away right now.
        if (activeSession.value) {
          activeSession.value.provider.stop().catch(() => {})
        }
        if (incomingSession.value) {
          incomingSession.value.provider.stop().catch(() => {})
        }

        removeResizeListener()
        navigateTo('/unsupported')
      }
    }

    window.addEventListener('resize', resizeListener)
  }

  /**
   * Utterance POSTs still awaiting a response.
   *
   * `/utterance` inserts only `WHERE status = 'in_corso'` and answers 409
   * otherwise — deliberately, to close a TOCTOU window. The cost was that an
   * utterance whose POST was still in flight when `/end` flipped the row came
   * back 409 and was dropped on the floor, and the client swallowed it without
   * so much as a warning. The phrase most exposed was the avatar's closing
   * sentence: it is what TRIGGERS the end, so its POST and its own `/end`
   * always raced.
   */
  const inFlightUtterances = new Set<Promise<void>>()

  /**
   * Wait for the utterance tail, bounded.
   *
   * Bounded because a hung POST must not hold an interview open indefinitely —
   * losing one line is bad, stranding the candidate is worse. The ceiling is
   * generous relative to a normal round trip, so reaching it means something is
   * wrong rather than merely slow, and it says so.
   */
  async function drainUtterances(): Promise<void> {
    if (inFlightUtterances.size === 0) return
    const pending = Array.from(inFlightUtterances)
    let timer: ReturnType<typeof setTimeout> | undefined
    const ceiling = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), UTTERANCE_DRAIN_CEILING_MS)
    })
    const outcome = await Promise.race([
      Promise.allSettled(pending).then(() => 'drained' as const),
      ceiling,
    ])
    if (timer) clearTimeout(timer)
    if (outcome === 'timeout') {
      console.warn('[useInterviewSession] utterance drain hit its ceiling; ending anyway')
    }
  }

  async function sendUtterance(dbSessionId: number, text: string, speaker: 'candidate' | 'avatar') {
    try {
      await candidateFetch('/candidate/interview/utterance', {
        method: 'POST',
        body: {
          session_id: dbSessionId,
          speaker,
          text,
          ts: new Date().toISOString(),
        },
      })
    } catch (err) {
      // 401 → the stored session has already expired or been cleared
      // (candidateFetch clears it before throwing). Distinct, non-retryable
      // terminal — never falls into the "non-fatal, keep going" path below.
      if (err instanceof CandidateUnauthorizedError) {
        terminalReason.value = 'session_expired'
        transitionTo('terminal')
        return
      }

      // 409 = silently dropped; any other error is also non-fatal for utterance
      const status =
        (err as Record<string, unknown>)?.status ?? (err as Record<string, unknown>)?.statusCode
      if (status !== 409) {
        console.warn('[useInterviewSession] /utterance error (non-fatal):', err)
      }
    }
  }

  async function callEnd(
    dbSessionId: number,
    endedReason: 'completed' | EndQuestionReason
  ): Promise<EndDirective | null> {
    // Inside callEnd, not at its call sites. Both callers would have to
    // remember, and the one most likely to be added next is a new exit path
    // written under time pressure. A choke point cannot be forgotten.
    await drainUtterances()

    try {
      const response = await candidateFetch<Partial<EndResponse>>('/candidate/interview/end', {
        method: 'POST',
        body: {
          session_id: dbSessionId,
          ended_reason: endedReason,
        },
      })

      // Progress is server-fed. The page renders these; it never derives them.
      if (typeof response?.ended_competencies === 'number') {
        endedCompetencies.value = response.ended_competencies
      }
      if (typeof response?.total_competencies === 'number') {
        totalCompetencies.value = response.total_competencies
      }

      const action = response?.next_action
      // An unrecognised value is treated exactly like an absent one.
      return action === 'continue' || action === 'pause' || action === 'done' ? action : null
    } catch (err) {
      // 401 → distinct, non-retryable terminal — checked BEFORE 403 so a
      // cleared/expired session is never mistaken for a gate refusal.
      if (err instanceof CandidateUnauthorizedError) {
        terminalReason.value = 'session_expired'
        transitionTo('terminal')

        return null
      }

      const status =
        (err as Record<string, unknown>)?.status ?? (err as Record<string, unknown>)?.statusCode
      if (status === 409) {
        // 409 = the loser of the avatar-complete/timer race. Distinct from
        // "no directive": the winner is already advancing, so this caller must
        // not transition at all.
        return 'noop'
      }
      if (status === 403) {
        terminalReason.value = '403'
        transitionTo('terminal')

        return null
      }
      // Other errors on /end — log; the caller degrades to the pause screen
      console.warn('[useInterviewSession] /end unexpected error:', err)

      return null
    }
  }

  // ---- Handover machinery (D2, D3, D5, D6) ---------------------------------

  function clearHandoverBoundTimer() {
    if (handoverBoundTimer) {
      clearTimeout(handoverBoundTimer)
      handoverBoundTimer = null
    }
  }

  function clearPromoteTimer() {
    if (promoteTimer) {
      clearTimeout(promoteTimer)
      promoteTimer = null
    }
  }

  function clearConnectingCeilingTimer() {
    if (connectingCeilingTimer) {
      clearTimeout(connectingCeilingTimer)
      connectingCeilingTimer = null
    }
  }

  /**
   * THE single place the handover lifecycle ends — every timer it owns
   * (bound, crossfade/promote, connecting-ceiling) is cancelled here and
   * ONLY here, and `handoverActive` drops here and only here. Routed through
   * by every exit: `promote()`, `releaseOutgoing()`, `releaseIncoming()`,
   * `confirmDevices()`'s defensive cleanup, and — unconditionally — by
   * `transitionTo()` itself on `done`/`error`/`terminal`.
   */
  function endHandover() {
    clearHandoverBoundTimer()
    clearPromoteTimer()
    clearConnectingCeilingTimer()
    handoverActive.value = false
  }

  /** D5: armed the instant the live handle's `complete` is handled, before `/end`. */
  function armHandoverBound() {
    clearHandoverBoundTimer()
    handoverBoundTimer = setTimeout(() => {
      handoverBoundTimer = null
      releaseOutgoing('bound')
    }, HANDOVER_BOUND_MS)
  }

  /**
   * B3/B4/C3: armed only when the bound fires (`releaseOutgoing`) — bounds
   * what would otherwise be an UNBOUNDED wait in the degraded `connecting`
   * fallback, where `InterviewTimer` is not mounted and nothing else ever
   * gives up. See `CONNECTING_CEILING_MS`'s own comment for the two failure
   * modes this closes and why one mechanism covers both.
   */
  function armConnectingCeiling() {
    clearConnectingCeilingTimer()
    connectingCeilingTimer = setTimeout(() => {
      connectingCeilingTimer = null
      giveUpOnHandover()
    }, CONNECTING_CEILING_MS)
  }

  /**
   * The connecting-ceiling fired: whatever was going to rescue this handover
   * (a late paint, a retry finally succeeding) has not, within a generous,
   * finite bound. `transitionTo('error')` — not a bespoke dead-end — because
   * it already routes through the SAME unconditional cleanup every other
   * done/error/terminal transition does (see `transitionTo()`), so the
   * incoming (if one still exists) is stopped and cleared right there. The
   * candidate lands on the existing, retryable error screen instead of being
   * stranded on the transition panel forever.
   */
  function giveUpOnHandover() {
    logHandoverEvent('connecting-ceiling-exceeded')
    transitionTo('error')
  }

  function beginHandover(handle: ProviderSession) {
    handoverActive.value = true
    // Uplink guard (D4) — before /end, so the outgoing never speaks again once
    // the candidate is being handed over.
    handle.provider.setMicMuted(true).catch(() => {})
    armHandoverBound()
  }

  /**
   * D3: releases the LIVE slot only. Structural teardown — no explicit
   * `stop()` call here; Vue unmounts the outgoing's `AvatarPlayer` once it
   * drops out of `players`, and its existing `onUnmounted` calls `stop()`.
   *
   * Used by: the bound timer firing, and an outgoing that dies mid-overlap
   * (falls to the exact same fallback — "what we were holding open is
   * already gone").
   */
  function releaseOutgoing(reason: 'bound' | 'dead') {
    logHandoverEvent('outgoing-released', { reason })
    endHandover()
    activeSession.value = null
    transitionTo('connecting')
    // incomingSession is left exactly as-is — still hidden and muted, and is
    // promoted whenever it eventually paints (D5) — bounded now by the
    // connecting-ceiling armed below (B3/B4/C3).
    armConnectingCeiling()
  }

  /**
   * THE single place the incoming slot is ever stopped and cleared —
   * idempotent-safe by construction (`withIdempotentStop`), so calling this
   * on an already-empty slot, or racing `AvatarPlayer`'s own structural
   * `stop()`, is always safe. Used by `releaseIncoming()`, `confirmDevices()`,
   * and unconditionally by `transitionTo()` on done/error/terminal.
   */
  function clearIncomingProvider() {
    if (incomingSession.value) {
      incomingSession.value.provider.stop().catch(() => {})
    }
    incomingSession.value = null
    incomingEntering.value = false
  }

  /**
   * D2/D3: an incoming provider ERROR EVENT (as opposed to a failed `/start`
   * call, see `abandonIncomingAttempt`) ends the WHOLE handover — both slots
   * clear, timer cancelled — and falls through to today's error/terminal
   * handling. A failed next competency is a real error.
   */
  function releaseIncoming() {
    logHandoverEvent('incoming-released')
    endHandover()
    clearIncomingProvider()
  }

  /**
   * The incoming's OWN `/start` HTTP call failed before any provider session
   * existed. Abandon just this attempt — the bound timer (or, if it has
   * already fired, the connecting-ceiling armed by `releaseOutgoing`) is left
   * running exactly as armed, so the handover still resolves on schedule via
   * the existing fallback rather than an ad hoc branch here.
   */
  function abandonIncomingAttempt() {
    logHandoverEvent('incoming-attempt-abandoned')
    incomingSession.value = null
    incomingEntering.value = false
  }

  function crossfadeDelayMs(): number {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return CROSSFADE_MS
    }
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : CROSSFADE_MS
    } catch {
      return CROSSFADE_MS
    }
  }

  /**
   * D6: promotion is two steps so the fade happens while both are still
   * mounted. Called `crossfadeDelayMs()` after `notifyPainted()` marks the
   * incoming as `entering`. The outgoing's key drops out of `players` here —
   * Vue unmounts it and its `onUnmounted` calls `stop()` (D3), exactly once.
   */
  function promote() {
    const incoming = incomingSession.value
    if (!incoming) return

    endHandover()
    incomingSession.value = null
    incomingEntering.value = false
    // B1: the incoming's microphone was muted at creation (AvatarPlayer,
    // right after its own provider.start() resolved) and stays muted for the
    // WHOLE overlap — unmuted here, exactly once, only now that it is
    // actually about to become the session the candidate is speaking to.
    // Mirrors the outgoing's own mute/unmute symmetry (`beginHandover`
    // mutes it going out; this unmutes the incoming coming in). Deliberately
    // NOT tied to the `entering` role's reactive `muted` prop (which only
    // ever governs the VIDEO element) — unmuting the mic at `entering`
    // instead of here would reopen a smaller-scoped version of B1 for the
    // ~200ms crossfade window, with two unmuted mics again.
    incoming.provider.setMicMuted(false).catch(() => {})
    activeSession.value = incoming
    sessionId.value = incoming.dbSessionId
    // The machine stays `live` for the whole handover (D2); this also covers
    // a LATE promotion reached from the bound-exceeded `connecting` fallback.
    transitionTo('live')
  }

  /**
   * D6: called by `session.vue` when a `SessionPlayer`'s `<AvatarPlayer>`
   * emits `painted`. A no-op unless `dbSessionId` matches the CURRENT
   * incoming handle — the live handle's own paint only drives its own
   * opacity, never the handover (F3: `ready` is not a frame; painted is).
   */
  function notifyPainted(dbSessionId: number) {
    const incoming = incomingSession.value
    if (!incoming || incoming.dbSessionId !== dbSessionId) return
    if (incomingEntering.value) return // idempotent — a defensive re-fire is a no-op

    incomingEntering.value = true
    endHandover() // cancels the bound timer — the incoming is no longer at risk
    const delay = crossfadeDelayMs()
    promoteTimer = setTimeout(() => {
      promoteTimer = null
      promote()
    }, delay)
  }

  function wireProviderEvents(handle: ProviderSession) {
    handle.provider.on('state', (payload) => {
      const providerState = payload as string
      const isLive = handle === activeSession.value

      if (providerState === 'ready' || providerState === 'listening') {
        // D2/F3: the swap trigger is a painted FRAME, never `ready` — HeyGen
        // emits `ready` unconditionally, so gating the handover on it would
        // fade to a black rectangle. `ready`/`listening` only ever drives the
        // ORIGINAL connecting→live transition (first connect / Tavus /
        // post-bound reconnect) and ONLY for the live handle — an incoming
        // handle's (or a stale, already-released handle's) `ready` is inert.
        if (isLive && state.value === 'connecting') {
          transitionTo('live')
          attachResizeListener()
        }
      }

      if (providerState === 'complete' && isLive) {
        handleProviderComplete(handle)
      }
      // An incoming handle's own `complete` is ignored (D2) — it has not
      // been asked a question at handover time; the guard makes it inert.
    })

    handle.provider.on('transcript', (payload) => {
      const entry = payload as { role: 'user' | 'avatar'; text: string; ts: number }
      const speaker = entry.role === 'user' ? 'candidate' : 'avatar'
      // D2: resolved by the EMITTING handle's own dbSessionId — never shared
      // module state. This is the permanent fix for the api v0.26.4-shaped
      // defect: an outgoing's tail transcript can never land on the
      // incoming's row, because it never reads the incoming's id at all.
      // Tracked, not merely fired: `callEnd()` drains this set before it runs,
      // so the tail cannot be 409-dropped by its own /end.
      const inFlight = sendUtterance(handle.dbSessionId, entry.text, speaker).catch(() => {})
      inFlightUtterances.add(inFlight)
      void inFlight.finally(() => inFlightUtterances.delete(inFlight))
    })

    handle.provider.on('error', (payload) => {
      const code = providerErrorCode(payload)
      const isLive = handle === activeSession.value
      const isIncoming = handle === incomingSession.value

      if (isIncoming) {
        // C2: capture the OUTGOING handle BEFORE transitioning — `transitionTo`
        // itself now nulls `activeSession` for done/error/terminal, so reading
        // `activeSession.value` AFTER it ran (the previous `stopActiveSession()`
        // idiom) was already null there: a defensive call that could never
        // actually fire. `.stop()` is idempotent-safe (`withIdempotentStop`),
        // so this is genuinely redundant-but-real defense in depth against
        // `AvatarPlayer:onUnmounted`'s own structural stop, not dead code.
        const outgoing = activeSession.value
        // D2/D3: an incoming error releases the outgoing too and falls
        // through to today's error/terminal handling — a failed next
        // competency is a real error, not a silent fallback.
        releaseIncoming()
        if (code === 'absent_phrase') {
          terminalReason.value = 'absent_phrase'
          transitionTo('terminal')
        } else {
          transitionTo('error')
        }
        outgoing?.provider.stop().catch(() => {})
        return
      }

      if (!isLive) return // a stale handle, already released — ignore

      if (code === 'absent_phrase') {
        if (incomingSession.value) releaseIncoming()
        terminalReason.value = 'absent_phrase'
        transitionTo('terminal')
        handle.provider.stop().catch(() => {})
        return
      }

      if (incomingSession.value) {
        if (incomingEntering.value) {
          // C1: the outgoing died INSIDE the ~200ms crossfade window — the
          // incoming has already painted, its video is already unmuted and
          // fading in, and it has already won the handover in every
          // observable way but state. Falling to `releaseOutgoing('dead')`
          // would cancel `promoteTimer` (via `endHandover()`) with nothing to
          // re-arm it — `notifyPainted()`'s own idempotency guard makes a
          // repeat paint a no-op — stranding an already-visible, already-
          // audible incoming behind the transition panel (`hasLivePlayer`
          // goes false the instant `activeSession` is nulled). Finish the
          // promotion immediately instead of discarding it.
          logHandoverEvent('promote-raced-outgoing-death')
          promote()
          return
        }
        // The outgoing died while its replacement was still connecting,
        // before any frame existed to show — "what we were holding open is
        // already gone." Falls to the exact same fallback the bound timer
        // uses.
        releaseOutgoing('dead')
        return
      }

      if (state.value === 'live' || state.value === 'connecting') {
        transitionTo('error')
        handle.provider.stop().catch(() => {})
      }
    })
  }

  /**
   * Act on the server's directive (D11) for the `endQuestion()` (timeout)
   * path only. UNCHANGED by this slice — a timed-out question never begins
   * a handover.
   *
   * The client no longer decides whether the interview continues. It used to
   * compare `question_index + 1` against a competency list the page never
   * filled, so the comparison was `0 >= 0` and EVERY interview ended after one
   * question. Whether to continue, pause or finish is tenant policy — SA-04
   * cadence lives on the project — and the server answers it.
   *
   * `null` means "we did not get an answer": a stale server, a stripped body, an
   * unrecognised future value. All of them degrade to `pause`, which shows the
   * screen asking the candidate to continue. Degrading to `done` would end an
   * interview that is not over — the exact defect being removed here.
   */
  function advanceAfterQuestion(directive: EndDirective | null) {
    // May already be terminal from a 403 on /end.
    if (state.value === 'terminal') return

    // HTTP 409 — the loser of the avatar-complete/timer race. It has no
    // directive and must not act: the winner is already advancing.
    if (directive === 'noop') return

    if (directive === 'continue') {
      confirmDevices()

      return
    }

    transitionTo(directive === 'done' ? 'done' : 'end_of_question')
  }

  /**
   * D2/D8/D9: the directive handler for the `complete`-driven HeyGen handover
   * path. A parallel track to `advanceAfterQuestion` (kept unchanged above
   * for `endQuestion()`), so neither caller's existing behaviour regresses.
   */
  function handleHandoverDirective(directive: EndDirective | null, handle: ProviderSession) {
    if (state.value === 'terminal') return

    if (directive === 'noop') {
      // Lost the /end race — undo the handover prep: nothing is actually
      // advancing, so the mic mute and the bound timer must not stick.
      endHandover()
      handle.provider.setMicMuted(false).catch(() => {})
      return
    }

    if (directive === 'continue') {
      startNextSession()
      return
    }

    // pause/done/unrecognised: no next competency. Abandon the handover prep
    // — transitionTo() below unmounts this handle's player anyway.
    endHandover()
    handle.provider.setMicMuted(false).catch(() => {})
    transitionTo(directive === 'done' ? 'done' : 'end_of_question')
  }

  function handleProviderComplete(handle: ProviderSession) {
    const isHeyGen = handle.providerName === 'heygen'

    if (isHeyGen) {
      beginHandover(handle)
    }

    // Avatar signalled completion → call /end with 'completed'
    callEnd(handle.dbSessionId, 'completed')
      .then((directive) => {
        if (isHeyGen && handle === activeSession.value) {
          handleHandoverDirective(directive, handle)
          return
        }
        advanceAfterQuestion(directive)
      })
      .catch(() => {})
  }

  /**
   * D8: extracted tail of `confirmDevices()` — the isResuming guard plus
   * `startSession(0)`, WITHOUT the pre-emptive teardown. This is what the
   * HeyGen `continue` handover calls: the outgoing must stay live while the
   * incoming session is requested.
   */
  function startNextSession() {
    if (isResuming) return
    isResuming = true
    startSession(0, 'incoming')
  }

  async function startSession(attemptNumber = 0, target: 'active' | 'incoming' = 'active') {
    if (target === 'active') {
      transitionTo('connecting')
    }
    // target === 'incoming': state stays `live` throughout (D2) — it never
    // enters `connecting` for the happy handover path.

    try {
      const response = await candidateFetch<StartResponse>('/candidate/interview/start', {
        method: 'POST',
      })

      if (!isValidStartResponse(response)) {
        isResuming = false
        if (target === 'incoming') {
          abandonIncomingAttempt()
          return
        }
        terminalReason.value = 'malformed_response'
        transitionTo('terminal')
        return
      }

      // D4: end_phrase and final_phrase come from NESTED question_context — NOT top-level
      const { end_phrase, final_phrase } = response.question_context
      const dbSessionId = Number(response.session_id)
      const providerName = response.provider as ProviderName
      // `question_index` is deliberately NOT stored: it was only ever read to
      // derive last-competency detection, which the server owns now. It also
      // carries a pre-existing off-by-one (-1 on the first competency of every
      // project, because `position` is written 0-based while the query subtracts
      // one), so keeping it around invites someone to compute progress from it.
      // `competency_ordinal` is the field to trust.

      const startConfig: StartConfig = {
        dbSessionId,
        sessionToken: response.provider_token ?? undefined,
        conversationUrl: response.conversation_url ?? undefined,
        endPhrase: end_phrase,
        finalPhrase: final_phrase,
        // Omitted, not set to undefined-as-a-value: the provider treats an absent
        // id as "use the default device", which is the correct degradation when the
        // browser withheld one.
        ...(confirmedAudioDeviceId ? { audioDeviceId: confirmedAudioDeviceId } : {}),
      }

      const handle: ProviderSession = {
        // C2: idempotent-wrapped at creation — the ONE place every
        // `ProviderSession` handle's `stop()` becomes safe to call more than
        // once, from any of the call sites that legitimately reach for it.
        provider: withIdempotentStop(createProvider(providerName, isMock())),
        config: startConfig,
        dbSessionId,
        providerName,
        // `=== true`, not a truthy read: an older API that does not send the
        // field must resolve to "show the avatar", and `undefined` must never
        // become "hide it".
        audioOnly: response.audio_only === true,
      }

      // Wire BEFORE publishing: AvatarPlayer mounts and starts the provider as soon as
      // the handle is published, and the very first event it can emit
      // (absent_phrase) must already have a listener.
      wireProviderEvents(handle)

      if (target === 'incoming') {
        incomingSession.value = handle
      } else {
        sessionId.value = dbSessionId
        activeSession.value = handle
      }
    } catch (err) {
      isResuming = false

      // 401 → distinct, non-retryable terminal. Checked BEFORE any status
      // inspection: CandidateUnauthorizedError carries no .status/.statusCode
      // (it is thrown by candidateFetch's onResponseError, or synchronously
      // when the stored session had already expired before the call was
      // attempted), so it would otherwise fall through to the generic
      // "any other error → retryable" branch below — retrying forever
      // against a session that can never re-authenticate itself.
      if (err instanceof CandidateUnauthorizedError) {
        if (target === 'incoming') abandonIncomingAttempt()
        terminalReason.value = 'session_expired'
        transitionTo('terminal')
        return
      }

      const status =
        (err as Record<string, unknown>)?.status ?? (err as Record<string, unknown>)?.statusCode

      if (status === 403) {
        if (target === 'incoming') abandonIncomingAttempt()
        terminalReason.value = '403'
        transitionTo('terminal')
        return
      }

      if (status === 429) {
        // provider_busy: retry with backoff (max MAX_ATTEMPTS total)
        const nextAttempt = attemptNumber + 1
        if (nextAttempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
          await startSession(nextAttempt, target)
        } else {
          // Exhausted all attempts.
          retryAttemptCount.value = 0
          if (target === 'incoming') {
            // Abandon this attempt; the bound timer's existing fallback
            // handles releasing the outgoing on schedule.
            abandonIncomingAttempt()
          } else {
            transitionTo('error')
          }
        }
        return
      }

      // 502 or any other error → retryable, for the active target. For the
      // incoming target, abandon this attempt and let the bound timer's
      // existing fallback release the outgoing on schedule.
      if (target === 'incoming') {
        abandonIncomingAttempt()
      } else {
        transitionTo('error')
      }
    } finally {
      isResuming = false
    }
  }

  // ---- Public API ----------------------------------------------------------

  function acceptConsent() {
    transitionTo('device_check')
  }

  /**
   * Begin (or re-begin) a question after the device check.
   *
   * `audioDeviceId` is the microphone the candidate settled on. It is REMEMBERED
   * rather than required, because this function is also the entry point for
   * nextCompetency() and retry(), which have no device check to read it from —
   * dropping it there would silently switch microphones mid-interview.
   *
   * D8: this is the FULL-teardown path — first connect, retry(), Tavus
   * continue, and the SA-04 resume. The HeyGen handover's continue path calls
   * `startNextSession()` instead, which skips the teardown below entirely.
   */
  function confirmDevices(audioDeviceId?: string) {
    if (isResuming) return
    isResuming = true

    if (audioDeviceId !== undefined) confirmedAudioDeviceId = audioDeviceId

    // M1: a fresh confirmDevices() call always starts over, so any leftover
    // in-flight handover is abandoned rather than left to leak — UNCONDITIONALLY.
    // The bound timer is armed by `beginHandover()` BEFORE `incomingSession`
    // is ever populated (the multi-round-trip /end + /start window), so the
    // old `if (incomingSession.value)` guard missed exactly that window: a
    // `retry()` (which calls this) landing there left the bound timer ticking
    // against a session this call is about to replace, and it would later
    // fire and null out the FRESH `activeSession` `confirmDevices()` just
    // built. `endHandover()` + `clearIncomingProvider()` are always
    // idempotent-safe — calling them with no handover in flight is a no-op.
    endHandover()
    clearIncomingProvider()

    // If there's an existing provider, stop it (resume-on-remount guard).
    // Pre-existing, explicit and immediate — unrelated to the handover's
    // structural-release rule.
    if (activeSession.value) {
      activeSession.value.provider.stop().catch(() => {})
    }
    clearActiveProvider()

    startSession(0, 'active')
  }

  /**
   * Pause a LIVE question (D13). The mic is muted and the provider session is
   * kept alive; a pause that leaves the mic open is not a pause.
   *
   * `live` is now the ONLY entry. `end_of_question` no longer offers a Pause
   * control because it IS the scheduled-pause screen — a Pause button on a pause
   * screen is meaningless.
   *
   * NOT YET a pause that stops the provider billing. Tearing the session down
   * and re-issuing it on resume is written and parked: it is held back because
   * its interaction with server-side transcript harvesting is unproven, and the
   * transcript is the one thing here that cannot be reconstructed.
   *
   * D2/B2: also refused for the WHOLE handover window (`handoverActive`, not
   * `incomingSession !== null` — the latter left a gap between
   * `beginHandover()` arming the bound and `incomingSession` actually being
   * populated several round trips later, during which this guard used to be
   * open) — `handoverInFlight` (aliased to `handoverActive`) drives
   * `:disabled` on the Pause control instead of hiding it. Hiding it is
   * itself a visible break; an enabled-but-inert button is the defect the
   * live pause was fixed for.
   *
   * INVARIANT: assigns `state.value` DIRECTLY and must never be routed through
   * `transitionTo()`, which calls `clearActiveProvider()` for the terminal
   * states. `paused` is deliberately absent from that list; routing it there as
   * a "consistency" cleanup would unmount AvatarPlayer and destroy the very
   * session this pause exists to preserve.
   */
  function pause() {
    if (state.value !== 'live') return
    if (handoverActive.value) return

    state.value = 'paused'
    activeSession.value?.provider.setMicMuted(true).catch(() => {})
  }

  /**
   * Resume to `live`. The provider session was kept alive through the pause,
   * so this only lifts the microphone mute.
   */
  function resume() {
    if (state.value !== 'paused') return

    state.value = 'live'
    activeSession.value?.provider.setMicMuted(false).catch(() => {})
  }

  function retry() {
    retryAttemptCount.value = 0
    confirmDevices()
  }

  function nextCompetency() {
    if (state.value === 'end_of_question') {
      currentCompetencyIndex.value += 1
      confirmDevices()
    }
  }

  /**
   * End the current question early — the 5-minute timer expired, or the candidate
   * pressed Skip. Both were previously inert affordances on the interview page.
   *
   * Unlike the `completed` path (the avatar signalled its own completion), the
   * provider is cut off mid-turn here, so it is stopped explicitly.
   *
   * D2/B2 (Task 1.6): additionally refused for the WHOLE handover window
   * (`handoverActive`, armed by `beginHandover()` before `/end` — NOT
   * `incomingSession.value !== null`, which left the window between
   * `beginHandover()` and the incoming actually being populated open: a
   * per-question timer firing there raced a second `POST /end` against a
   * `handle` that was still the rendered live player, tearing it down while
   * the state machine still believed it was `live`). A timer expiry landing
   * anywhere in the handover must not `POST /end` a session that is already
   * ended (or about to be superseded).
   */
  async function endQuestion(reason: EndQuestionReason): Promise<void> {
    if (state.value !== 'live') return
    if (handoverActive.value) return

    const handle = activeSession.value
    if (!handle) return

    const directive = await callEnd(handle.dbSessionId, reason)
    handle.provider.stop().catch(() => {})
    advanceAfterQuestion(directive)
  }

  async function teardown() {
    removeResizeListener()
    endHandover()
    const live = activeSession.value
    const incoming = incomingSession.value
    activeSession.value = null
    incomingSession.value = null
    incomingEntering.value = false
    // C2: awaited and explicit — the page is navigating away RIGHT NOW and
    // must not proceed until the provider is actually torn down, so this
    // cannot rely solely on Vue's own (asynchronous, next-tick) unmount of
    // the AvatarPlayer instances these refs just dropped. Both `stop()`
    // calls are idempotent-safe (`withIdempotentStop`) against that
    // structural unmount firing on the same handle around the same time —
    // the underlying SDK/network teardown still runs at most once each.
    if (live) {
      await live.provider.stop().catch(() => {})
    }
    if (incoming) {
      await incoming.provider.stop().catch(() => {})
    }
  }

  return {
    state,
    retryAttemptCount,
    currentCompetencyIndex,
    terminalReason,
    sessionId,
    endedCompetencies,
    totalCompetencies,
    activeProvider,
    activeConfig,
    players,
    handoverInFlight,
    acceptConsent,
    confirmDevices,
    pause,
    resume,
    retry,
    nextCompetency,
    endQuestion,
    teardown,
    notifyPainted,
  }
}
