<template>
  <main
    class="flex min-h-screen flex-col items-center justify-center bg-background p-4"
    role="main"
    :aria-label="$t('interview.consent.title')"
  >
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
      <Button @click="session.acceptConsent()">
        {{ $t('interview.consent.accept') }}
      </Button>
    </section>

    <!-- Device check screen -->
    <section
      v-else-if="session.state.value === 'device_check'"
      class="w-full max-w-md rounded-xl border border-border bg-card shadow-md"
      aria-labelledby="device-check-heading"
    >
      <h1 id="device-check-heading" class="sr-only">{{ $t('interview.device_check.title') }}</h1>
      <ClientOnly>
        <DeviceCheck @confirmed="onDevicesConfirmed" />
      </ClientOnly>
    </section>

    <!-- Connecting / loading screen — shown until the provider handles are published -->
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
      <div class="relative w-full rounded-xl overflow-hidden shadow-avatar">
        <ClientOnly v-if="avatarProvider && avatarConfig">
          <AvatarPlayer
            :provider="avatarProvider"
            :config="avatarConfig"
            @state="onProviderState"
            @transcript="onTranscript"
            @error="onProviderError"
          />
        </ClientOnly>
      </div>

      <template v-if="session.state.value === 'live'">
        <InterviewCaption :text="currentCaption" />

        <div class="flex items-center justify-between">
          <InterviewTimer :seconds="questionTimeLimit" @expired="onTimerExpired" />
          <div class="flex gap-2">
            <Button variant="outline" size="sm" @click="session.pause()">
              {{ $t('interview.live.pause') }}
            </Button>
            <Button variant="ghost" size="sm" @click="skipQuestion">
              {{ $t('interview.live.skip') }}
            </Button>
          </div>
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
    </section>

    <!-- End of Question screen -->
    <section
      v-else-if="session.state.value === 'end_of_question'"
      class="flex max-w-lg flex-col gap-6 rounded-xl border border-border bg-card p-8 shadow-md"
      aria-labelledby="end-of-question-heading"
    >
      <h1 id="end-of-question-heading" class="text-2xl font-semibold text-foreground">
        {{ $t('interview.end_of_question.title') }}
      </h1>
      <InterviewProgressBar
        :current="(session.currentCompetencyIndex.value ?? 0) + 1"
        :total="competencies.length"
      />
      <div class="flex gap-3">
        <Button @click="onNextCompetency">
          {{ $t('interview.end_of_question.next') }}
        </Button>
        <Button variant="outline" @click="session.pause()">
          {{ $t('interview.end_of_question.pause') }}
        </Button>
      </div>
    </section>

    <!-- Paused screen -->
    <section
      v-else-if="session.state.value === 'paused'"
      class="flex max-w-lg flex-col gap-6 rounded-xl border border-border bg-card p-8 shadow-md"
      aria-labelledby="paused-heading"
    >
      <h1 id="paused-heading" class="text-2xl font-semibold text-foreground">
        {{ $t('interview.paused.title') }}
      </h1>
      <Button @click="session.resume()">
        {{ $t('interview.paused.resume') }}
      </Button>
    </section>

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
 * Interview page — ssr:false container (D1).
 *
 * Orchestrates the full interview flow: consent → device-check → live loop →
 * end_of_question/pause → done/error/terminal.
 *
 * Drives useInterviewSession state machine. Wires DeviceCheck stream handoff,
 * AvatarPlayer provider events, proctoring overlay, and integrity flush.
 *
 * noindex: this route is session-gated and must never be indexed.
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useInterviewSession } from '~/composables/useInterviewSession'
import { useExitRedirect } from '~/composables/useExitRedirect'
import { Button } from '~/components/ui/button'
import { Alert, AlertTitle } from '~/components/ui/alert'
import { Skeleton } from '~/components/ui/skeleton'
import InterviewTimer from '~/components/InterviewTimer.vue'
import InterviewCaption from '~/components/InterviewCaption.vue'
import InterviewProgressBar from '~/components/ProgressBar.vue'
import type { IntegrityEventInternal } from '~/utils/proctor-config'

definePageMeta({ ssr: false })
useHead({
  meta: [
    { name: 'robots', content: 'noindex, nofollow' },
    { name: 'referrer', content: 'no-referrer' },
  ],
})

// ---------------------------------------------------------------------------
// Route + config
// ---------------------------------------------------------------------------

// The token param is part of this route; useInterviewSession reads it internally.

// In production, competency list comes from the C6 bootstrap endpoint.
// For now, useInterviewSession is initialized with an empty list;
// the composable handles last-competency detection internally when /start
// returns question_context.question_index vs total.
const competencies: string[] = []

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------

const pendingIntegrityEvents = ref<IntegrityEventInternal[]>([])

/**
 * Supplied by ProctorOverlay alongside each event batch. Events are dropped from the
 * proctor's buffer only once a flush has actually succeeded — never on read — so a
 * refused beacon leaves them pending instead of discarding them.
 */
let acknowledgeIntegrityEvents:
  // eslint-disable-next-line no-unused-vars
  ((acknowledged: IntegrityEventInternal[]) => void) | null = null

const session = useInterviewSession({
  competencies,
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
    // away — precedent: the unsupported-gate resize handler at
    // useInterviewSession.ts:130-158 (flush-then-stop-then-navigate).
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
// Device check flow
// ---------------------------------------------------------------------------

const confirmedStream = ref<MediaStream | null>(null)

function onDevicesConfirmed(stream: MediaStream): void {
  confirmedStream.value = stream
  session.confirmDevices()
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

const currentCaption = ref('')
const questionTimeLimit = 300 // 5 minutes default

// AvatarPlayer state changes are handled internally by the session machine
function onProviderState(): void {}

function onTranscript(entry: { text: string }): void {
  currentCaption.value = entry.text
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

async function skipQuestion(): Promise<void> {
  await session.endQuestion('skipped')
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
  // eslint-disable-next-line no-unused-vars
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
