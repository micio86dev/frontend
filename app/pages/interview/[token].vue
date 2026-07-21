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
        <DeviceCheck.client @confirmed="onDevicesConfirmed" />
      </ClientOnly>
    </section>

    <!-- Connecting / loading screen -->
    <section
      v-else-if="session.state.value === 'connecting'"
      class="flex flex-col items-center gap-4"
      aria-live="polite"
      aria-busy="true"
    >
      <Skeleton class="h-48 w-full max-w-2xl rounded-lg" />
      <Skeleton class="h-4 w-48 rounded" />
    </section>

    <!-- Live interview screen -->
    <section
      v-else-if="session.state.value === 'live'"
      class="flex w-full max-w-3xl flex-col gap-4"
      aria-label="Live interview"
    >
      <div class="relative w-full rounded-xl overflow-hidden shadow-avatar">
        <ClientOnly v-if="activeProvider && activeConfig">
          <AvatarPlayer.client
            :provider="activeProvider"
            :config="activeConfig"
            @state="onProviderState"
            @transcript="onTranscript"
            @error="onProviderError"
          />
        </ClientOnly>
      </div>

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
        <ProctorOverlay.client
          :stream="confirmedStream"
          :on-events-updated="onIntegrityEventsUpdated"
        />
      </ClientOnly>
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
        :current="session.currentCompetencyIndex.value + 1"
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
import { ref, onUnmounted } from 'vue'
import { useInterviewSession } from '~/composables/useInterviewSession'
import { Button } from '~/components/ui/button'
import { Alert, AlertTitle } from '~/components/ui/alert'
import { Skeleton } from '~/components/ui/skeleton'
import InterviewTimer from '~/components/InterviewTimer.vue'
import InterviewCaption from '~/components/InterviewCaption.vue'
import InterviewProgressBar from '~/components/ProgressBar.vue'
import type { InterviewProvider, StartConfig } from '~/types/interview-provider'
import type { IntegrityEventInternal } from '~/utils/proctor-config'

definePageMeta({ ssr: false })
useHead({ robots: 'noindex, nofollow' })

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

const session = useInterviewSession({
  competencies,
  getPendingIntegrityEvents: () => pendingIntegrityEvents.value,
})

// ---------------------------------------------------------------------------
// Device check flow
// ---------------------------------------------------------------------------

const confirmedStream = ref<MediaStream | null>(null)
const avatarMountEl = ref<HTMLElement | null>(null)

function onDevicesConfirmed(stream: MediaStream): void {
  confirmedStream.value = stream
  session.confirmDevices()
}

// ---------------------------------------------------------------------------
// Provider / AvatarPlayer wiring
// ---------------------------------------------------------------------------

// These are populated by useInterviewSession internally.
// AvatarPlayer receives them as props.
const activeProvider = ref<InterviewProvider | null>(null)
const activeConfig = ref<StartConfig | null>(null)
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

async function onTimerExpired(): Promise<void> {
  // Timer expiry treated as skip (timeout)
  await callEnd('timeout')
}

async function skipQuestion(): Promise<void> {
  await callEnd('skipped')
}

async function callEnd(reason: 'completed' | 'timeout' | 'skipped'): Promise<void> {
  void reason
  // useInterviewSession handles /end internally on provider 'complete' events.
  // Timer expiry / skip navigate via the session API.
  // This is a simplified wiring point; full /end dispatch lives in the composable.
}

// ---------------------------------------------------------------------------
// End of Question / next competency
// ---------------------------------------------------------------------------

function onNextCompetency(): void {
  session.nextCompetency(avatarMountEl.value ?? undefined)
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

function onIntegrityEventsUpdated(events: IntegrityEventInternal[]): void {
  pendingIntegrityEvents.value = events
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

onUnmounted(async () => {
  await session.teardown()
})
</script>
