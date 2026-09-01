<template>
  <main
    class="flex min-h-screen flex-col items-center justify-center bg-background p-4"
    :aria-label="$t('interview.consent.title')"
  >
    <!--
      Player mount layer (invisible-competency-handover D3/D5/D6) — ALWAYS
      rendered whenever `session.players` is non-empty, entirely independent
      of which "screen" below is currently showing. This is what makes the
      exactly-once teardown guarantee structural: a `ProviderSession` is
      rendered by exactly ONE keyed `<AvatarPlayer>` instance for its ENTIRE
      lifetime, from publication to release, and is NEVER re-parented into a
      different part of the template — Vue only unmounts (and therefore
      `stop()`s, AvatarPlayer:onUnmounted) a session when it actually drops
      out of `session.players`, never as a side effect of an unrelated
      state-branch switch (e.g. the bound-exceeded fallback below, where the
      LIVE slot releases but a hidden `incoming` must survive to be promoted
      once it paints).

      `hasLivePlayer` collapses this to zero visual footprint (`sr-only`)
      whenever there is no `live`-role player yet — the bound-exceeded
      fallback's hidden incoming session connects invisibly behind whichever
      screen (the transition-panel) is showing.

      Rendered from ONE keyed v-for (D6): two separate elements would each
      unmount independently and `stop()` the session that just won a
      handover the moment it is promoted.
    -->
    <div
      v-if="session.players.value.length > 0"
      class="relative mx-auto w-full max-w-3xl overflow-hidden rounded-xl shadow-avatar"
      :class="hasLivePlayer ? '' : 'sr-only'"
    >
      <template v-for="p in session.players.value" :key="p.key">
        <ClientOnly>
          <AvatarPlayer
            :provider="p.provider"
            :config="p.config"
            :muted="p.muted"
            :overlay="p.role !== 'live'"
            @state="onProviderState"
            @transcript="onTranscriptFromPlayer(p.role, $event)"
            @error="onProviderError"
            @painted="session.notifyPainted(p.key)"
          />
        </ClientOnly>
      </template>
    </div>

    <!-- Consent screen -->
    <section
      v-if="session.state.value === 'idle'"
      class="flex max-w-lg flex-col gap-6 rounded-xl border border-border bg-card p-8 shadow-md"
      aria-labelledby="consent-heading"
    >
      <h1 id="consent-heading" class="text-2xl font-semibold text-foreground">
        {{ $t('interview.consent.title') }}
      </h1>
      <p class="text-sm text-muted-foreground">{{ $t('interview.consent.body') }}</p>
      <Separator />
      <InterviewGuide />
      <Button @click="session.acceptConsent()">
        {{ $t('interview.consent.accept') }}
      </Button>
    </section>

    <!-- Device check screen. max-w-xl (not max-w-md, DA4): max-w-md was sized for
         the old 320px thumbnail — the native-ratio preview, two device pickers,
         and the mic meter do not fit a 448px card. -->
    <section
      v-else-if="session.state.value === 'device_check'"
      class="w-full max-w-xl rounded-xl border border-border bg-card shadow-md"
      aria-labelledby="device-check-heading"
    >
      <h1 id="device-check-heading" class="sr-only">{{ $t('interview.device_check.title') }}</h1>
      <ClientOnly>
        <DeviceCheck @confirmed="onDevicesConfirmed" />
      </ClientOnly>
    </section>

    <!--
      Between competencies (D12). With the interstitial gone, confirmDevices()
      tears the provider down and rebuilds it while the candidate watches, and a
      bare skeleton there reads as the avatar vanishing mid-conversation.

      NO control and NO minimum display time: it is dismissed by the state
      machine alone, so it can never quietly become the second interstitial this
      change exists to remove.
    -->
    <section
      v-else-if="session.state.value === 'connecting' && !avatarMounted && hasRunACompetency"
      data-testid="transition-panel"
      class="flex max-w-lg flex-col items-center gap-4 rounded-xl border border-border bg-card p-8 shadow-md"
      aria-live="polite"
      aria-busy="true"
    >
      <h2 class="text-xl font-semibold text-foreground">{{ $t('interview.transition.title') }}</h2>
      <p class="text-sm text-muted-foreground">{{ $t('interview.transition.body') }}</p>
      <p class="text-sm text-muted-foreground">
        {{ session.endedCompetencies.value ?? 0 }} / {{ session.totalCompetencies.value ?? 0 }}
      </p>
    </section>

    <!--
      First connect — the plain skeleton stays. It follows a device check the
      candidate has just interacted with, which sets a different expectation from
      an avatar disappearing mid-interview.
    -->
    <section
      v-else-if="session.state.value === 'connecting' && !avatarMounted"
      class="flex flex-col items-center gap-4"
      aria-live="polite"
      aria-busy="true"
    >
      <Skeleton class="h-48 w-full max-w-2xl rounded-lg" />
      <Skeleton class="h-4 w-48 rounded" />
    </section>

    <!--
      Avatar + live interview screen.

      Rendered from `connecting` (as soon as useInterviewSession publishes the provider)
      through `live`, so AvatarPlayer mounts EXACTLY ONCE per question and the provider
      is started against a stable <video> element. Gating this on `state === 'live'`
      alone was unreachable: the session only becomes live once the provider emits
      'ready', which it cannot do until it has been started by the player.
    -->
    <section
      v-else-if="avatarMounted"
      class="flex w-full max-w-3xl flex-col gap-4"
      aria-label="Live interview"
    >
      <!--
        The <AvatarPlayer> instance(s) themselves render from the persistent
        player mount layer above `<main>`'s exclusive chain, not here — see
        that block's comment (invisible-competency-handover D3/D5/D6). This
        section owns only the surrounding chrome: timer, caption, pause,
        proctoring, and the paused panel.
      -->

      <template v-if="session.state.value === 'live'">
        <InterviewCaption :text="currentCaption" />

        <div class="flex items-center justify-between">
          <InterviewTimer
            :seconds="questionRemaining"
            @tick="questionRemaining = $event"
            @expired="onTimerExpired"
          />
          <!-- No Skip control: a competency must not be skippable. The timer is
               the only client-side early end, so a question cannot hang the
               session while the candidate cannot opt out of one.

               invisible-competency-handover D2: DISABLED (never hidden) while
               a HeyGen handover is in flight. Hiding it is itself a visible
               break; an enabled-but-inert button is the defect the live
               pause was fixed for. -->
          <Button
            variant="outline"
            size="sm"
            :loading="session.handoverInFlight.value"
            @click="session.pause()"
          >
            {{ $t('interview.live.pause') }}
          </Button>
        </div>

        <!-- Invisible proctoring overlay -->
        <ClientOnly v-if="confirmedStream">
          <ProctorOverlay
            :stream="confirmedStream"
            :session-id="session.sessionId.value"
            :on-events-updated="onIntegrityEventsUpdated"
          />
        </ClientOnly>
      </template>

      <!--
        Paused mid-question.

        The provider session stays up while paused — tearing it down would restart
        the question from its opening line on resume — so `avatarMounted` is still
        true and this branch keeps rendering. The standalone `paused` section below
        is ordered AFTER this one in the v-if chain and therefore unreachable here,
        which left a candidate who paused a live question with no way to resume.
        That section still serves the between-competencies pause, where the
        provider has already been unpublished.
      -->
      <div
        v-else-if="session.state.value === 'paused'"
        class="flex flex-col items-center gap-4 rounded-xl border border-border bg-card p-6"
        data-testid="paused-live-panel"
      >
        <h2 class="text-lg font-semibold text-foreground">{{ $t('interview.paused.title') }}</h2>
        <p class="text-sm text-muted-foreground">{{ $t('interview.paused.mic_muted') }}</p>
        <Button @click="session.resume()">
          {{ $t('interview.paused.resume') }}
        </Button>
      </div>
    </section>

    <!-- End of Question screen -->
    <section
      v-else-if="session.state.value === 'end_of_question'"
      class="flex max-w-lg flex-col gap-6 rounded-xl border border-border bg-card p-8 shadow-md"
      aria-labelledby="end-of-question-heading"
    >
      <h1 id="end-of-question-heading" class="text-2xl font-semibold text-foreground">
        {{ $t('interview.scheduled_pause.title') }}
      </h1>
      <p class="text-sm text-muted-foreground">{{ $t('interview.scheduled_pause.body') }}</p>
      <!-- Progress comes from the server (D6/D7). The page used to compare an
           index against a local array it never filled, which is why every
           interview believed it was over after one question. -->
      <InterviewProgressBar
        :current="session.endedCompetencies.value ?? 0"
        :total="session.totalCompetencies.value ?? 0"
      />
      <p class="text-sm text-muted-foreground">
        {{ session.endedCompetencies.value ?? 0 }} / {{ session.totalCompetencies.value ?? 0 }}
      </p>
      <!-- One control only. This screen IS the pause, so a secondary Pause
           button on it would be meaningless. -->
      <Button @click="onNextCompetency">
        {{ $t('interview.scheduled_pause.resume') }}
      </Button>
    </section>

    <!-- The standalone `paused` section lived here. It is gone: `live` is the
         only entry to `paused` now, so `paused` implies `avatarMounted` and the
         in-avatar panel above is the only reachable one. Leaving this would have
         left a second, unreachable resume control for a future reader to wire
         back up. The invariant is pinned by a unit test. -->

    <!-- Done screen -->
    <section
      v-else-if="session.state.value === 'done'"
      class="flex max-w-lg flex-col gap-6 rounded-xl border border-border bg-card p-8 shadow-md"
      aria-labelledby="done-heading"
      data-testid="done-screen"
    >
      <h1 id="done-heading" class="text-2xl font-semibold text-foreground">
        {{ $t('interview.done.title') }}
      </h1>
      <p class="text-sm text-muted-foreground">{{ $t('interview.done.body') }}</p>
    </section>

    <!--
      Expired-session screen (D-D/D-F) — takes priority over BOTH the
      error-retry and terminal sections below. Reached either because:
        (a) the session machine's OWN 401 handling set
            terminalReason = 'session_expired' (Task 2.7), or
        (b) the separate useExitRedirect() session fetch hit a 401 and no
            error_redirect_url is configured to route through instead —
            "surfaced, not just logged" (D-D).
      No retry control: a candidate 401 is unrecoverable by construction, and
      retrying here would just repeat it.
    -->
    <section
      v-else-if="showExpiredSessionVariant"
      class="flex max-w-lg flex-col gap-6 rounded-xl border border-border bg-card p-8 shadow-md"
      aria-labelledby="session-expired-heading"
      data-testid="session-expired-screen"
    >
      <h1 id="session-expired-heading" class="text-2xl font-semibold text-foreground">
        {{ $t('interview.terminal.session_expired.title') }}
      </h1>
      <p class="text-sm text-muted-foreground">
        {{ $t('interview.terminal.session_expired.body') }}
      </p>
    </section>

    <!-- Error + Retry screen -->
    <section
      v-else-if="session.state.value === 'error'"
      class="flex max-w-lg flex-col gap-6 rounded-xl border border-border bg-card p-8 shadow-md"
      aria-labelledby="error-heading"
      data-testid="error-screen"
    >
      <Alert variant="destructive">
        <AlertTitle id="error-heading">{{ $t('interview.error.title') }}</AlertTitle>
      </Alert>
      <Button data-testid="retry-button" @click="onRetry">
        {{ $t('interview.error.retry') }}
      </Button>
    </section>

    <!-- Terminal screen -->
    <section
      v-else-if="session.state.value === 'terminal'"
      class="flex max-w-lg flex-col gap-6 rounded-xl border border-border bg-card p-8 shadow-md"
      aria-labelledby="terminal-heading"
      data-testid="terminal-screen"
    >
      <template v-if="session.terminalReason.value === '403'">
        <h1 id="terminal-heading" class="text-2xl font-semibold text-foreground">
          {{ $t('interview.terminal.403.title') }}
        </h1>
        <p class="text-sm text-muted-foreground">{{ $t('interview.terminal.403.body') }}</p>
      </template>
      <template v-else>
        <h1 id="terminal-heading" class="text-2xl font-semibold text-foreground">
          {{ $t('interview.terminal.absent_phrase.title') }}
        </h1>
        <p class="text-sm text-muted-foreground">
          {{ $t('interview.terminal.absent_phrase.body') }}
        </p>
        <a
          href="mailto:support@beai.app"
          class="text-sm text-primary underline underline-offset-4 hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="terminal-contact"
        >
          {{ $t('interview.terminal.absent_phrase.contact') }}
        </a>
      </template>
    </section>
  </main>
</template>

<script setup lang="ts">
/**
 * Interview session page — ssr:false container (D1, D-A).
 *
 * The interview UI itself, moved verbatim from `[token].vue` (candidate-session-auth
 * D-A): `[token].vue` is now the entry route that exchanges the sso-link token
 * exactly once and `replace`-redirects here. This route carries NO token in its
 * URL — a refresh or Back navigation lands here safely, by construction, never
 * re-triggering the exchange.
 *
 * Orchestrates the full interview flow: consent → device-check → live loop →
 * end_of_question/pause → done/error/terminal.
 *
 * Drives useInterviewSession state machine. Wires DeviceCheck stream handoff,
 * AvatarPlayer provider events, proctoring overlay, and integrity flush.
 *
 * Route gate: `app/middleware/candidate-session.ts` runs before this page
 * mounts and `replace`-redirects to the expired-session terminal when no
 * valid stored candidate session exists — this page never renders without one.
 *
 * noindex: this route is session-gated and must never be indexed.
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useInterviewSession } from '~/composables/useInterviewSession'
import type { HandoverRole } from '~/composables/useInterviewSession'
import { useExitRedirect } from '~/composables/useExitRedirect'
import { Button } from '~/components/ui/button'
import { Alert, AlertTitle } from '~/components/ui/alert'
import { Skeleton } from '~/components/ui/skeleton'
import InterviewTimer from '~/components/InterviewTimer.vue'
import InterviewCaption from '~/components/InterviewCaption.vue'
import InterviewGuide from '~/components/molecules/InterviewGuide.vue'
import { Separator } from '~/components/ui/separator'
import InterviewProgressBar from '~/components/ProgressBar.vue'
import type { IntegrityEventInternal } from '~/utils/proctor-config'

definePageMeta({ ssr: false, middleware: ['candidate-session'] })

const { t } = useI18n()

useHead({
  // WCAG 2.4.2 (Page Titled), Level A. This page had NO title at all — the one
  // screen a candidate spends their entire session on, and the only one axe
  // never ran against, because the a11y check was wired to /health and
  // /unsupported and nothing else. Found the moment C13 wired it here.
  //
  // Localized rather than static: the candidate's whole session runs in their
  // language, and a tab reading "Interview" to an Italian candidate is a small
  // but real wart. (/unsupported and / still carry static titles — a
  // consistency gap worth closing, but not by this fix.)
  title: t('interview.document_title'),
  meta: [
    { name: 'robots', content: 'noindex, nofollow' },
    { name: 'referrer', content: 'no-referrer' },
  ],
})

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------

const pendingIntegrityEvents = ref<IntegrityEventInternal[]>([])

/**
 * Supplied by ProctorOverlay alongside each event batch. Events are dropped from the
 * proctor's buffer only once a flush has actually succeeded — never on read — so a
 * refused beacon leaves them pending instead of discarding them.
 */
let acknowledgeIntegrityEvents: ((acknowledged: IntegrityEventInternal[]) => void) | null = null

const session = useInterviewSession({
  getPendingIntegrityEvents: () => pendingIntegrityEvents.value,
  onIntegrityEventsFlushed: (flushed) => {
    acknowledgeIntegrityEvents?.(flushed)
    pendingIntegrityEvents.value = pendingIntegrityEvents.value.filter(
      (event) => !flushed.includes(event)
    )
  },
})

// ---------------------------------------------------------------------------
// Exit redirect (D10, C10) — GET /api/candidate/session fetched once on mount
// (not at `done`), so a network failure at the very end cannot strand the
// candidate on a blank screen. Redirect fires only once BOTH the session has
// reached `done` AND exit_redirect_url has resolved — whichever happens last.
// ---------------------------------------------------------------------------

const exitRedirect = useExitRedirect()

onMounted(() => {
  void exitRedirect.fetchSession()
})

watch([() => session.state.value, exitRedirect.exitRedirectUrl], async ([currentState, url]) => {
  if (currentState === 'done' && url) {
    // Flush pending integrity events / stop the provider before navigating
    // away — precedent: the unsupported-gate resize handler, the
    // `resizeListener` closure built inside `attachResizeListener()` in
    // useInterviewSession.ts (flush-then-stop-then-navigate). Referenced
    // symbolically, not by line number: this diff already pushed one stale
    // line-number citation out of date once.
    await session.teardown()
    exitRedirect.redirect()
  }
})

// ---------------------------------------------------------------------------
// Error / terminal → configurable error page.
//
// The binding integration doc asks for "redirect a pagina errore configurabile"
// on a technical failure, and until now nothing implemented it — the spec
// recorded it as an open gap.
//
// This matters more than the `done` redirect above. On completion the candidate
// is finished; on failure they are stranded on a BEAI screen, on a domain they
// have no account on, belonging to a company they have no relationship with.
// Only the calling system can tell them whether the interview will be re-issued
// or whether their application is affected.
//
// `error` and `terminal` share one destination on purpose: the candidate's need
// is identical in both — they cannot continue and need to get back to whoever
// sent them. Splitting them would ask an operator to configure a distinction
// their candidates cannot perceive.
//
// Unconfigured is a supported state, not a gap: redirectToError() returns false
// and the existing inline screen renders unchanged, retry button included.
// ---------------------------------------------------------------------------
watch([() => session.state.value, exitRedirect.errorRedirectUrl], async ([currentState, url]) => {
  if ((currentState === 'error' || currentState === 'terminal') && url) {
    await session.teardown()
    exitRedirect.redirectToError()
  }
})

// ---------------------------------------------------------------------------
// Expired-session variant (D-D/D-F) — "surfaced, not just logged". Reached
// via two independent signals that both mean the same thing to the
// candidate: the session that was authenticating them is gone.
//   (a) the session machine's OWN 401 handling (Task 2.7):
//       session.terminalReason.value === 'session_expired'
//   (b) useExitRedirect's session fetch also 401'd, and there is no
//       error_redirect_url to route through instead — the watcher above
//       already handles the configured case; this is its unconfigured
//       fallback, made visible instead of silently no-opping.
// ---------------------------------------------------------------------------
const showExpiredSessionVariant = computed(() => {
  const currentState = session.state.value
  if (currentState !== 'error' && currentState !== 'terminal') return false
  if (session.terminalReason.value === 'session_expired') return true
  return (
    exitRedirect.sessionFetchFailed.value === 'unauthenticated' &&
    !exitRedirect.errorRedirectUrl.value
  )
})

// ---------------------------------------------------------------------------
// Device check flow
// ---------------------------------------------------------------------------

const confirmedStream = ref<MediaStream | null>(null)

function onDevicesConfirmed(stream: MediaStream, micDeviceId?: string): void {
  confirmedStream.value = stream
  // The mic id travels with the stream: the avatar provider opens its own capture
  // track and cannot inherit this one, so it would otherwise use the OS default
  // rather than the device the candidate just tested.
  session.confirmDevices(micDeviceId)
}

// ---------------------------------------------------------------------------
// Provider / AvatarPlayer wiring
// ---------------------------------------------------------------------------

// useInterviewSession creates the provider and publishes it here once POST /start has
// resolved; AvatarPlayer mounts it onto the real <video> element and calls
// provider.start(). These are NOT page-local state — the page only reads them.
const avatarProvider = computed(() => session.activeProvider.value)
const avatarConfig = computed(() => session.activeConfig.value)
const avatarMounted = computed(() => avatarProvider.value !== null && avatarConfig.value !== null)

/**
 * invisible-competency-handover D6 — whether the player mount layer has a
 * `live`-role entry right now. While false (only a hidden `incoming`
 * survives, e.g. the D5 bound-exceeded fallback), the layer collapses to
 * `sr-only` so it never visually competes with whichever screen (the
 * transition-panel) is showing underneath it.
 */
const hasLivePlayer = computed(() => session.players.value.some((p) => p.role === 'live'))

/**
 * True once at least one competency has ended (D12).
 *
 * Read from the server tally rather than a local flag: `endedCompetencies` is
 * null until the first /end returns, which is exactly "no competency has run
 * yet". A page-local boolean would be a second source for a fact the server
 * already states — the shape of the defect this whole change removes.
 */
const hasRunACompetency = computed(() => (session.endedCompetencies.value ?? 0) > 0)

const currentCaption = ref('')
const QUESTION_TIME_LIMIT = 300 // 5 minutes default

/**
 * Seconds left on the current question — owned HERE, not by InterviewTimer.
 *
 * The timer renders inside the `v-if="state === 'live'"` block, so pausing
 * unmounts it and takes its internal countdown with it. While it owned the
 * value, every resume mounted a fresh instance starting from the full limit:
 * pause, resume, and the candidate had five more minutes, as often as they
 * liked. On an assessment that is a fairness hole, not a cosmetic bug.
 *
 * Keeping it on the page outlives the unmount, so a pause suspends the clock
 * and a resume continues from the same second.
 */
const questionRemaining = ref(QUESTION_TIME_LIMIT)

// A new competency gets a full clock — the pause exemption above must not leak
// across questions. Keyed on the DB session id, which /start reissues per
// competency, rather than on the `live` transition, which a resume also makes.
watch(
  () => session.sessionId.value,
  () => {
    questionRemaining.value = QUESTION_TIME_LIMIT
  }
)

// AvatarPlayer state changes are handled internally by the session machine
function onProviderState(): void {}

function onTranscript(entry: { text: string }): void {
  currentCaption.value = entry.text
}

/**
 * invisible-competency-handover D2 — the caption reflects whichever player
 * is `live`. A hidden `incoming` session (still connecting behind the
 * scenes, or newly promoted a beat before the page re-renders) has not been
 * asked a question and must never overwrite the caption the candidate is
 * currently reading.
 */
function onTranscriptFromPlayer(role: HandoverRole, entry: { text: string }): void {
  if (role === 'live') onTranscript(entry)
}

// Provider errors are handled by the session machine via provider.on('error')
function onProviderError(): void {}

// ---------------------------------------------------------------------------
// Timer / skip
// ---------------------------------------------------------------------------

// Both affordances dispatch POST /end through the session machine. They used to call a
// local stub with an empty body, so the 5-minute timer and the Skip button did nothing.
async function onTimerExpired(): Promise<void> {
  await session.endQuestion('timeout')
}

// ---------------------------------------------------------------------------
// End of Question / next competency
// ---------------------------------------------------------------------------

function onNextCompetency(): void {
  session.nextCompetency()
}

// ---------------------------------------------------------------------------
// Error / retry
// ---------------------------------------------------------------------------

function onRetry(): void {
  session.retry()
}

// ---------------------------------------------------------------------------
// Proctoring events
// ---------------------------------------------------------------------------

function onIntegrityEventsUpdated(
  events: IntegrityEventInternal[],

  acknowledge: (acknowledged: IntegrityEventInternal[]) => void
): void {
  pendingIntegrityEvents.value = events
  acknowledgeIntegrityEvents = acknowledge
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

onUnmounted(async () => {
  await session.teardown()
})
</script>
