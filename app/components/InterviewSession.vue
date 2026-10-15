<template>
  <BrandCanvas
    test-id="interview-session"
    :aria-label="$t('interview.document_title')"
    :surface="false"
    :footer="false"
    :load-branding="false"
    :wide="callStageLive"
    :plate="!callStageLive"
  >
    <!--
      The whole interview sits on the brand canvas the candidate arrived on
      (DESIGN.md §7.0.1, §7.2): every state is a white surface on it, and the
      avatar panel keeps its own dark surface. `load-branding` is off because
      `useExitRedirect` reads the same session on mount and primes the branding
      from it; a second reader would be a second request. No tagline footer:
      inside the session the vertical room belongs to the device check and
      the avatar, which already fill a 1440x900 viewport.

      The header carries the where-am-I chrome: the three steps on the two
      pre-interview screens, the live call header (title, clock, captions,
      microphone, Exit) while live. The logo loses its white plate only while
      live (`plate`), so every other screen is unchanged.
    -->
    <template v-if="preInterviewStep" #header-end>
      <InterviewSteps :current="preInterviewStep" />
    </template>
    <template v-else-if="callStageLive" #header-end>
      <CallHeader
        :title="callTitle"
        :elapsed-seconds="elapsedSeconds"
        :captions-enabled="captionsEnabled"
        :mic-muted="session.micMuted.value || session.handoverInFlight.value"
        :mic-disabled="session.handoverInFlight.value"
        @toggle-captions="captionsEnabled = !captionsEnabled"
        @toggle-mic="session.setMicMuted(!session.micMuted.value)"
      >
        <template #exit>
          <CallExitDialog :loading="session.handoverInFlight.value" @confirm="onExitConfirmed" />
        </template>
      </CallHeader>
    </template>

    <!--
      The one Toaster of the interview: IntegrityToast (inside ProctorOverlay)
      fires its notices into it. Outside every state branch, so it is mounted
      exactly once and a notice survives the live screen giving way to another.
    -->
    <IntegrityToaster position="top-left" />

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
    <!--
      candidate-interview-call-ui D3 — the SAME layer, inside the call
      layout. `CallStage` renders this slot in every state, so the layer element
      and every keyed `AvatarPlayer` in it survive connecting, live, paused and a
      handover; only the classes change. The interviewer's tile frame (name chip
      and speaking ring) is inside the layer, around the players.
    -->
    <p
      v-if="session.pendingUtterances.value > 0"
      data-testid="network-pending-notice"
      role="status"
      aria-live="polite"
      class="mx-auto mb-2 max-w-3xl rounded-md border border-border bg-card px-3 py-2 text-sm text-card-foreground"
    >
      {{ $t('interview.call.network_pending') }}
    </p>
    <CallStage :live="callStageLive" :embedded="embedded">
      <template #layer="{ live }">
        <div
          data-slot="avatar-layer"
          class="relative"
          :aria-hidden="session.players.value.length === 0 ? 'true' : undefined"
          :class="[
            live
              ? 'self-start [grid-area:layer]'
              : 'mx-auto w-full max-w-3xl overflow-hidden rounded-surface',
            hasLivePlayer ? '' : 'sr-only',
          ]"
        >
          <CallTile
            :name="interviewerName"
            :speaking-label="$t('interview.call.avatar_speaking')"
            :speaking="speaker === 'avatar' || session.boundaryInFlight.value"
          >
            <template v-for="p in session.players.value" :key="p.key">
              <ClientOnly>
                <AvatarPlayer
                  :provider="p.provider"
                  :config="p.config"
                  :muted="p.muted"
                  :mic-muted="session.micMuted.value"
                  :audio-only="p.audioOnly"
                  :overlay="p.role !== 'live'"
                  @state="onPlayerState(p.key, $event)"
                  @transcript="onTranscriptFromPlayer(p.role, $event)"
                  @error="onProviderError"
                  @painted="session.notifyPainted(p.key)"
                  @stream="onAvatarStream(p.key, $event)"
                />
              </ClientOnly>
            </template>
          </CallTile>
          <!--
            The captions overlay (live-interview-call-chrome D8): a SIBLING of the tile inside the
            layer, so the keyed players are never re-parented. Rendered only while live; when the
            candidate turns captions off it stays mounted as the screen-reader region.
          -->
          <CallQuestion
            v-if="live"
            ref="callQuestion"
            :text="currentCaption"
            :speaker-name="interviewerName"
            :visible="captionsEnabled"
          />
        </div>
      </template>

      <template #panel>
        <CallPanel
          :ended="panelEnded"
          :total="session.totalCompetencies.value ?? null"
          :elapsed-seconds="elapsedSeconds"
          :question-seconds="interviewRemaining"
          :timer-key="session.sessionId.value ?? null"
          :max-seconds="session.interviewMaxSeconds.value"
          :storyboard="storyboard"
          :primary-index="session.primaryIndex.value"
          @tick="interviewRemaining = $event"
          @expired="onTimerExpired"
        >
          <template #help>
            <CallHelpLink />
          </template>
        </CallPanel>
      </template>

      <template v-if="confirmedStream" #self>
        <ClientOnly>
          <CallSelfView
            :stream="confirmedStream"
            :speaking-label="$t('interview.call.candidate_speaking')"
            :name="candidateName"
            :speaking="speaker === 'candidate' && !session.micMuted.value"
          />
        </ClientOnly>
      </template>
    </CallStage>

    <!-- Consent screen -->
    <section
      v-if="session.state.value === 'idle'"
      class="flex flex-col gap-6 w-full max-w-[34rem] rounded-surface bg-card p-6 text-card-foreground shadow-surface lg:p-9 brand-canvas__surface"
      aria-labelledby="consent-heading"
    >
      <h1
        id="consent-heading"
        class="text-2xl leading-tight font-semibold tracking-[-0.01em] text-balance text-foreground"
      >
        {{ $t('interview.consent.title') }}
      </h1>
      <p class="text-sm leading-6 text-muted-foreground">{{ $t('interview.consent.body') }}</p>
      <Separator />
      <InterviewGuide />
      <Button class="h-(--spacing-control) px-6" @click="session.acceptConsent()">
        {{ $t('interview.consent.accept') }}
      </Button>
    </section>

    <!-- Device check screen. max-w-xl (not max-w-md, DA4): max-w-md was sized for
         the old 320px thumbnail — the native-ratio preview, two device pickers,
         and the mic meter do not fit a 448px card. -->
    <section
      v-else-if="session.state.value === 'device_check'"
      class="brand-canvas__surface w-full max-w-xl rounded-surface bg-card text-card-foreground shadow-surface"
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
      class="flex flex-col items-center gap-4 text-center w-full max-w-[34rem] rounded-surface bg-card p-6 text-card-foreground shadow-surface lg:p-9 brand-canvas__surface"
      aria-labelledby="transition-heading"
      aria-live="polite"
      aria-busy="true"
    >
      <h2 id="transition-heading" class="text-xl font-semibold text-foreground">
        {{ $t('interview.transition.title') }}
      </h2>
      <p class="text-sm text-muted-foreground">{{ $t('interview.transition.body') }}</p>
      <p class="text-sm text-muted-foreground">
        <span class="sr-only">{{ $t('interview.transition.progressLabel') }}</span>
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
      class="flex w-full max-w-3xl flex-col items-center gap-4"
      aria-live="polite"
      aria-busy="true"
    >
      <!--
        The avatar's own dark panel, at the size the avatar will take, so the
        page does not jump when it paints. Still, no pulse: nothing on the
        canvas loops (DESIGN.md §7.0.1).
      -->
      <div
        aria-hidden="true"
        class="aspect-video w-full rounded-surface bg-avatar-bg shadow-avatar"
      />
      <p class="text-sm text-on-primary-muted">{{ $t('shell.loading.title') }}</p>
    </section>

    <!--
      Avatar + live interview screen.

      Rendered from `connecting` (as soon as useInterviewSession publishes the provider)
      through `live`, so AvatarPlayer mounts EXACTLY ONCE per question and the provider
      is started against a stable <video> element. Gating this on `state === 'live'`
      alone was unreachable: the session only becomes live once the provider emits
      'ready', which it cannot do until it has been started by the player.
    -->
    <!--
      Paused.

      ITS OWN BRANCH, ordered BEFORE `avatarMounted`, and that ordering is the
      whole point. This panel used to live inside the avatar section because a
      pause kept the provider session up, so `avatarMounted` stayed true.
      Pausing now TEARS THAT SESSION DOWN — the only way to stop the provider
      billing conversation minutes for an interview nobody is having — so
      `avatarMounted` goes false the moment the candidate pauses. Left where it
      was, the panel would unmount with the player and strand the candidate on a
      blank screen with no way to resume.

      `pauseReason` (public-api SPEC §4.4) distinguishes WHY the interview is
      paused — a manual click, the tab-hidden>60s guard, or a network drop —
      and shows an extra line for the two automatic causes. The Resume button
      is the SAME single control for all three: `useTabVisibilityGuard` never
      auto-resumes on its own (only the candidate coming back and pressing
      Resume does), and `useNetworkGuard` auto-resumes only if IT was the one
      that paused (see `pausedByNetworkGuard`, below).
    -->
    <section
      v-else-if="session.state.value === 'paused'"
      class="flex flex-col items-center gap-4 text-center w-full max-w-[34rem] rounded-surface bg-card p-6 text-card-foreground shadow-surface lg:p-9 brand-canvas__surface"
      aria-labelledby="paused-heading"
      data-testid="paused-live-panel"
    >
      <!--
        candidate-interview-call-ui D9 — a deliberate Exit (the only way
        `pauseReason` becomes 'exit') gets the "suspended" wording. The Exit
        button that held focus has just unmounted, so the heading takes focus
        (`tabindex="-1"`: focusable by script, not a tab stop). The automatic
        pauses keep today's copy below, untouched.
      -->
      <template v-if="pauseReason === 'exit'">
        <h2
          id="paused-heading"
          ref="suspendedHeading"
          tabindex="-1"
          class="text-lg font-semibold text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {{ $t('interview.call.suspended.title') }}
        </h2>
        <p class="text-sm text-muted-foreground">
          {{
            resumeDeadline
              ? $t('interview.call.suspended.body', { time: resumeDeadline })
              : $t('interview.call.suspended.body_no_deadline')
          }}
        </p>
      </template>
      <template v-else>
        <h2 id="paused-heading" class="text-lg font-semibold text-foreground">
          {{ $t('interview.paused.title') }}
        </h2>
        <p class="text-sm text-muted-foreground">{{ $t('interview.paused.body') }}</p>
      </template>
      <p
        v-if="pauseReason === 'tab_hidden' && !silentIntegrity"
        class="text-sm text-muted-foreground"
        data-testid="tab-hidden-warning"
      >
        {{ $t('interview.paused.tab_hidden_warning') }}
      </p>
      <p
        v-else-if="pauseReason === 'network' && networkPermanentlyFailed"
        class="text-sm text-destructive"
        data-testid="network-failed-warning"
      >
        {{ $t('interview.paused.network_failed') }}
      </p>
      <p
        v-else-if="pauseReason === 'network'"
        class="text-sm text-muted-foreground"
        aria-live="polite"
        data-testid="network-reconnecting-notice"
      >
        {{ $t('interview.paused.network_reconnecting') }}
      </p>
      <Button class="h-(--spacing-control) px-6" @click="onResumeClicked">
        {{ $t('interview.paused.resume') }}
      </Button>
    </section>

    <!--
      candidate-interview-call-ui — the stage itself is rendered with the player layer (CallStage). What is left here
      is the invisible proctoring overlay: mounted only in `live`, so a suspend
      unmounts it, and fed the very stream the own tile shows (one camera request).
    -->
    <template v-else-if="avatarMounted">
      <ClientOnly v-if="session.state.value === 'live' && confirmedStream">
        <ProctorOverlay
          :stream="confirmedStream"
          :session-id="session.sessionId.value"
          :silent="silentIntegrity"
          :on-events-updated="onIntegrityEventsUpdated"
        />
      </ClientOnly>
    </template>

    <!-- End of Question screen -->
    <section
      v-else-if="session.state.value === 'end_of_question'"
      class="flex flex-col gap-6 w-full max-w-[34rem] rounded-surface bg-card p-6 text-card-foreground shadow-surface lg:p-9 brand-canvas__surface"
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
      <!-- One control only. This screen IS the pause, so a secondary Pause
           button on it would be meaningless. -->
      <Button class="h-(--spacing-control) px-6" @click="onNextCompetency">
        {{ $t('interview.scheduled_pause.resume') }}
      </Button>
    </section>

    <!-- Done screen -->
    <section
      v-else-if="session.state.value === 'done'"
      class="flex flex-col gap-6 w-full max-w-[34rem] rounded-surface bg-card p-6 text-card-foreground shadow-surface lg:p-9 brand-canvas__surface"
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
      class="flex flex-col gap-6 w-full max-w-[34rem] rounded-surface bg-card p-6 text-card-foreground shadow-surface lg:p-9 brand-canvas__surface"
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
      class="flex flex-col gap-6 w-full max-w-[34rem] rounded-surface bg-card p-6 text-card-foreground shadow-surface lg:p-9 brand-canvas__surface"
      aria-labelledby="error-heading"
      data-testid="error-screen"
    >
      <Alert variant="destructive">
        <AlertTitle id="error-heading">{{ $t('interview.error.title') }}</AlertTitle>
      </Alert>
      <Button data-testid="retry-button" class="h-(--spacing-control) px-6" @click="onRetry">
        {{ $t('interview.error.retry') }}
      </Button>
    </section>

    <!-- Terminal screen -->
    <section
      v-else-if="session.state.value === 'terminal'"
      class="flex flex-col gap-6 w-full max-w-[34rem] rounded-surface bg-card p-6 text-card-foreground shadow-surface lg:p-9 brand-canvas__surface"
      aria-labelledby="terminal-heading"
      data-testid="terminal-screen"
    >
      <template v-if="session.terminalReason.value === '403'">
        <h1 id="terminal-heading" class="text-2xl font-semibold text-foreground">
          {{ $t('interview.terminal.403.title') }}
        </h1>
        <p class="text-sm text-muted-foreground">{{ $t('interview.terminal.403.body') }}</p>
      </template>
      <!--
        One branch per TerminalReason, and a fallback keyed to NO reason.
        `absent_phrase` used to be both its own case and the catch-all, so
        `malformed_response` — a broken /start body, which the composable is at
        pains to keep a SEPARATE non-retryable terminal — rendered under a key
        naming a candidate behaviour. The copy happened not to lie; the next
        reason added would not have been so lucky.
      -->
      <template v-else-if="session.terminalReason.value === 'absent_phrase'">
        <h1 id="terminal-heading" class="text-2xl font-semibold text-foreground">
          {{ $t('interview.terminal.absent_phrase.title') }}
        </h1>
        <p class="text-sm text-muted-foreground">
          {{ $t('interview.terminal.absent_phrase.body') }}
        </p>
        <a
          :href="supportUrl"
          class="text-sm font-medium text-primary-ink underline underline-offset-4 hover:no-underline"
          data-testid="terminal-contact"
        >
          {{ $t('interview.terminal.absent_phrase.contact') }}
        </a>
      </template>
      <template v-else-if="session.terminalReason.value === 'malformed_response'">
        <h1 id="terminal-heading" class="text-2xl font-semibold text-foreground">
          {{ $t('interview.terminal.malformed_response.title') }}
        </h1>
        <p class="text-sm text-muted-foreground">
          {{ $t('interview.terminal.malformed_response.body') }}
        </p>
        <a
          :href="supportUrl"
          class="text-sm font-medium text-primary-ink underline underline-offset-4 hover:no-underline"
          data-testid="terminal-contact"
        >
          {{ $t('interview.terminal.malformed_response.contact') }}
        </a>
      </template>
      <template v-else>
        <h1 id="terminal-heading" class="text-2xl font-semibold text-foreground">
          {{ $t('interview.terminal.generic.title') }}
        </h1>
        <p class="text-sm text-muted-foreground">{{ $t('interview.terminal.generic.body') }}</p>
        <a
          :href="supportUrl"
          class="text-sm font-medium text-primary-ink underline underline-offset-4 hover:no-underline"
          data-testid="terminal-contact"
        >
          {{ $t('interview.terminal.generic.contact') }}
        </a>
      </template>
    </section>
  </BrandCanvas>
</template>

<script setup lang="ts">
/**
 * InterviewSession — the shared interview UI (public-api SPEC §4.4).
 *
 * EXTRACTED from `app/pages/interview/session.vue` verbatim (public-api step 10),
 * so BOTH the hosted `/interview/session` page and the embed `/embed/{token}`
 * page render exactly the same consent → device-check → live loop →
 * end_of_question/pause → done/error/terminal flow. SPEC §4.4: "Reuses the
 * hosted page component. Hosted mode differs only in chrome (branding header,
 * full-page layout)." — this component IS the non-chrome part; each page owns
 * only its own entry flow (route gating, token exchange) around it.
 *
 * Not a page: NO `definePageMeta` here — that compiler macro is only valid in
 * files under `app/pages/`, so route meta (`ssr: false`, the
 * `candidate-session` middleware) stays declared in `interview/session.vue`
 * itself. `useHead` (document title, noindex) DOES work from a plain
 * component and is kept here — both hosted and embed modes want the same
 * title, and duplicating it in two pages would be the first place the two
 * copies drift.
 *
 * Orchestrates the full interview flow: consent → device-check → live loop →
 * end_of_question/pause → done/error/terminal.
 *
 * Drives useInterviewSession state machine. Wires DeviceCheck stream handoff,
 * AvatarPlayer provider events, proctoring overlay, and integrity flush.
 *
 * Also owns the two SPEC §4.4 guards that apply to EITHER mode — a candidate
 * can background the tab or drop connectivity from the hosted page exactly as
 * easily as from an iframe:
 *   - `useTabVisibilityGuard` — tab hidden > 60s → pause & warn.
 *   - `useNetworkGuard` — network drop → reconnect attempt, then a
 *     `network_failed` notice on the existing paused/Resume screen (see
 *     `useNetworkGuard`'s own doc for why no new persistence call was added).
 *
 * noindex: this UI is session-gated and must never be indexed.
 */
import {
  ref,
  shallowReactive,
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUnmounted,
  watch,
} from 'vue'
import type { Ref } from 'vue'
import { useInterviewSession } from '~/composables/useInterviewSession'
import type { HandoverRole, SessionState } from '~/composables/useInterviewSession'
import type { ProviderState } from '~/types/interview-provider'
import { useExitRedirect } from '~/composables/useExitRedirect'
import { useTabVisibilityGuard } from '~/composables/useTabVisibilityGuard'
import { useNetworkGuard } from '~/composables/useNetworkGuard'
import { useCandidateSession } from '~/composables/useCandidateSession'
import { formatDeadline } from '~/utils/call-deadline'
import { useSpeakerTurn } from '~/composables/useSpeakerTurn'
import { useInterviewClock } from '~/composables/useInterviewClock'
import { useSupportUrl } from '~/composables/useSupportUrl'
import { Button } from '~/components/ui/button'
import { Alert, AlertTitle } from '~/components/ui/alert'
import CallQuestion from '~/components/molecules/CallQuestion.vue'
import CallExitDialog from '~/components/molecules/CallExitDialog.vue'
import CallHelpLink from '~/components/molecules/CallHelpLink.vue'
import { interviewRemainingSeconds } from '~/app/utils/interview-max-seconds'
import { INTERVIEW_CLOSING_GRACE_MS } from '~/app/utils/interview-budget'
import CallSelfView from '~/components/molecules/CallSelfView.client.vue'
import CallTile from '~/components/molecules/CallTile.vue'
import CallHeader from '~/components/organisms/CallHeader.vue'
import CallPanel from '~/components/organisms/CallPanel.vue'
import { useInterviewOutline } from '~/composables/useInterviewOutline'
import { useCaptionsPreference } from '~/composables/useCaptionsPreference'
import CallStage from '~/components/organisms/CallStage.vue'
import InterviewGuide from '~/components/molecules/InterviewGuide.vue'
import { Separator } from '~/components/ui/separator'
import InterviewProgressBar from '~/components/ProgressBar.vue'
import InterviewSteps from '~/components/molecules/InterviewSteps.vue'
import IntegrityToaster from '~/components/molecules/IntegrityToaster.vue'
import BrandCanvas from '~/components/organisms/BrandCanvas.vue'
import type { IntegrityEventInternal } from '~/utils/proctor-config'

withDefaults(
  defineProps<{
    /**
     * Rendered inside the host's iframe (`/embed/{token}`). The call stage then uses
     * no viewport-height unit: the host sizes the iframe from the height the embed
     * page reports, and a height that follows the iframe's own height never settles.
     */
    embedded?: boolean
  }>(),
  { embedded: false }
)

const { t, locale } = useI18n()
const candidateSession = useCandidateSession()

/**
 * Reusable-link interviews are run as live demos: an integrity warning on screen
 * pulls the candidate's eyes off the camera. Events are still recorded and sent;
 * only the toast is suppressed. Read once: the entry marker never changes mid-session.
 */
const silentIntegrity = candidateSession.read()?.entry === 'reusable'

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
/**
 * The step the header's indicator marks on the two pre-interview screens, or
 * null once the interview runs (the header then carries the live status).
 */
const preInterviewStep = computed(() => {
  if (session.state.value === 'idle') return 'consent' as const
  if (session.state.value === 'device_check') return 'device_check' as const
  return null
})

const hasRunACompetency = computed(() => (session.endedCompetencies.value ?? 0) > 0)

const currentCaption = ref('')

// The target of the three terminal-state support links: the configured support
// URL (https: or mailto: only), else the shipped mailbox.
const supportUrl = useSupportUrl()

/**
 * The call stage is showing: the interview is live and its avatar is mounted. Only
 * then do the question band, the side panel and the own tile exist, and only then
 * does the canvas widen to the stage's column.
 */
const callStageLive = computed(() => session.state.value === 'live' && avatarMounted.value)

// ---------------------------------------------------------------------------
// Call stage signals (candidate-interview-call-ui D4, D7).
// ---------------------------------------------------------------------------

/**
 * The latest provider state and the audio stream of EACH player, by key. Read for
 * whichever player is `live` right now: a handover promotes the very instance that
 * was `incoming`, and what it reported while hidden must still count after.
 */
const playerStates = shallowReactive(new Map<number, ProviderState>())
const playerStreams = shallowReactive(new Map<number, MediaStream>())

const liveKey = computed(() => session.players.value.find((p) => p.role === 'live')?.key ?? null)
const liveProviderState = computed(() =>
  liveKey.value === null ? null : (playerStates.get(liveKey.value) ?? null)
)
const liveAvatarStream = computed(() =>
  liveKey.value === null ? null : (playerStreams.get(liveKey.value) ?? null)
)

/** The stage's `state` handler: the per-player record. */
function onPlayerState(key: number, state: ProviderState): void {
  playerStates.set(key, state)
}

/** `AvatarPlayer` emits its stream once painted and `null` as it goes away. */
function onAvatarStream(key: number, stream: MediaStream | null): void {
  if (stream) {
    playerStreams.set(key, stream)
    return
  }
  playerStreams.delete(key)
  playerStates.delete(key)
}

const speakerTurn = useSpeakerTurn({
  // Same `ref` no-argument-overload artifact as `sessionId` below: the domain
  // value is never `undefined`.
  state: session.state as Ref<SessionState>,
  providerState: liveProviderState,
  avatarStream: liveAvatarStream,
  micStream: confirmedStream,
})
const speaker = speakerTurn.speaker

// ---------------------------------------------------------------------------
// Live header (live-interview-call-chrome D12, D13, D17).
// ---------------------------------------------------------------------------

const outlineApi = useInterviewOutline()
const captionsEnabled = useCaptionsPreference()

/**
 * Refetch the outline when the live screen first shows and whenever the session id moves
 * while it does (a boundary, a continuation, a re-offer) - never per utterance, and not
 * again when the SAME session resumes after a pause. A failed fetch keeps the bare title.
 */
let outlineSessionId: number | null = null
watch(
  () => (callStageLive.value ? session.sessionId.value : null),
  (id) => {
    if (id === null || id === outlineSessionId) return
    outlineSessionId = id
    void outlineApi.refresh()
  }
)

/** The candidate's own name for the self tile; blank or an outline that never loaded leaves its generic label. */
const candidateName = computed(() => outlineApi.outline.value?.candidate_name?.trim() || undefined)

/** The persona name the admin configured, or the generic label: never a technology provider's name. */
const interviewerName = computed(
  () => outlineApi.outline.value?.avatar_name?.trim() || t('interview.call.interviewer_name')
)

/**
 * The panel's named path, one item per outline entry. A name that is missing or blank gets the
 * generic "Competenza {ordinal}": the panel is never handed, and never shows, a competency code.
 * `null` (no outline, or it failed) omits the storyboard; the rest of the panel renders.
 */
const storyboard = computed(
  () =>
    outlineApi.outline.value?.competencies.map((competency) => ({
      name:
        competency.name?.trim() ||
        t('interview.call.storyboard.unnamed', { ordinal: competency.ordinal }),
      ordinal: competency.ordinal,
      status: competency.status,
      primaryTotal: competency.primary_total,
    })) ?? null
)

/**
 * Competencies already ended, for "Competenza n di N": the `/end` tally when there is one, else
 * the position the `/start` response named minus one, so a run resumed on its third competency
 * does not read "1 of N" until its first `/end`.
 */
const panelEnded = computed(
  () =>
    session.endedCompetencies.value ??
    (session.competencyOrdinal.value === null ? null : session.competencyOrdinal.value - 1)
)

/**
 * "Colloquio di assessment · {role}" for a standard assessment, "... · Potenziale" for a
 * potential one, the bare title when the role is unknown: no separator, no placeholder.
 */
const callTitle = computed(() => {
  const outline = outlineApi.outline.value
  const subject =
    outline?.assessment_type === 'potential'
      ? t('interview.call.header.potential')
      : outline?.role_name?.trim()

  return subject
    ? t('interview.call.header.title_with_subject', { subject })
    : t('interview.call.header.title')
})

/** Whole seconds of live interview time, for "03:12 / 25:00". It stops while suspended. */
const interviewClock = useInterviewClock({ isRunning: () => session.state.value === 'live' })
const elapsedSeconds = interviewClock.elapsed

/**
 * Used only when the server sent no template limit (an older API). Once a start
 * response names the template's total, that number is the clock.
 */
const FALLBACK_INTERVIEW_SECONDS = 300

/**
 * Seconds left in the WHOLE interview, owned HERE, not by InterviewTimer.
 *
 * The timer renders inside the `v-if="state === 'live'"` block, so pausing
 * unmounts it and takes its internal countdown with it. Keeping the value on the
 * page outlives the unmount, so a pause suspends the clock and a resume continues
 * from the same second.
 *
 * The limit is the template's total (`maxCallDurationSec`), not a per-question
 * allowance: it is NOT reset when the next competency starts.
 */
const interviewRemaining = ref(FALLBACK_INTERVIEW_SECONDS)

// The start response names the template's limit. It seeds the clock ONCE, even when it
// arrives after some live time has already run; later competencies keep counting down.
// One interview per page mount: the page is not reused for a second interview, so the seed is one-shot.
let interviewLimitSeeded = false
watch(
  () => session.interviewMaxSeconds.value,
  (maxSeconds) => {
    if (maxSeconds === null || interviewLimitSeeded) return
    interviewLimitSeeded = true
    interviewRemaining.value = interviewRemainingSeconds(maxSeconds, elapsedSeconds.value)
  },
  { immediate: true }
)

function onTranscript(entry: { text: string }): void {
  currentCaption.value = entry.text
}

/**
 * candidate-interview-call-ui D6 — a new session id (a
 * competency boundary, a resume) starts the written question again from the
 * listen hint, so the previous competency's closing phrase is never shown as the
 * new question. `sync` because the new competency's first avatar utterance must
 * never be erased by this reset running late.
 */
const callQuestion = ref<InstanceType<typeof CallQuestion> | null>(null)

/**
 * A competency boundary is a NEW session id after the first one: the first id is
 * the start of the interview, not a boundary, and a resume keeps its id. Focus
 * moves to the band once the DOM holds the cleared state (`nextTick`), so a
 * screen reader meets the listen hint; the band itself skips an open dialog.
 */
watch(
  () => session.sessionId.value,
  (id, previous) => {
    currentCaption.value = ''
    if (previous != null && id != null && id !== previous) {
      void nextTick(() => callQuestion.value?.focusOnBoundary())
    }
  },
  { flush: 'sync' }
)

/**
 * invisible-competency-handover D2 — the caption reflects whichever player
 * is `live`. A hidden `incoming` session (still connecting behind the
 * scenes, or newly promoted a beat before the page re-renders) has not been
 * asked a question and must never overwrite the caption the candidate is
 * currently reading.
 */
function onTranscriptFromPlayer(
  role: HandoverRole,
  entry: { text: string; role?: 'user' | 'avatar' }
): void {
  if (role !== 'live') return
  // candidate-interview-call-ui D6 — only the avatar's
  // words are displayed. The filter is on the DISPLAY alone: every entry,
  // candidate's included, still reaches POST /utterance through the provider's
  // own `transcript` listener in useInterviewSession.
  if (entry.role !== 'avatar') return
  onTranscript(entry)
}

// Provider errors are handled by the session machine via provider.on('error')
function onProviderError(): void {}

// ---------------------------------------------------------------------------
// Timer / skip
// ---------------------------------------------------------------------------

// Both affordances dispatch POST /end through the session machine. They used to call a
// local stub with an empty body, so the 5-minute timer and the Skip button did nothing.
let closingGraceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * The WHOLE interview's time is spent. The question in progress is not cut off: the avatar
 * finishes its closing phrase, and that completes it. Nothing after it starts (the session
 * composable turns any further `continue` into `done`). The grace timer only closes the
 * interview if that closing phrase never arrives.
 */
function armClosingGrace(): void {
  closingGraceTimer ??= setTimeout(() => {
    closingGraceTimer = null
    void session.endQuestion('timeout')
  }, INTERVIEW_CLOSING_GRACE_MS)
}

async function onTimerExpired(): Promise<void> {
  session.interviewBudgetSpent.value = true
  armClosingGrace()
}

function clearClosingGrace(): void {
  if (closingGraceTimer !== null) clearTimeout(closingGraceTimer)
  closingGraceTimer = null
}

// The closing phrase may complete the question before the grace period ends. A session
// that has left `live` must not be closed again by a timer armed for the question before.
// A pause clears the grace; resuming re-arms it, so a budget that ran out is still closed.
watch(
  () => session.state.value,
  (state) => {
    if (state !== 'live') clearClosingGrace()
    else if (session.interviewBudgetSpent.value) armClosingGrace()
  }
)

onBeforeUnmount(clearClosingGrace)

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
// Pause guards (public-api SPEC §4.4) — tab-hidden>60s and network-drop.
//
// Both call the SAME `session.pause()`/`session.resume()` the manual Pause
// button already uses (D13's own "ending the provider session, not muting
// it" semantics apply identically here — a backgrounded tab or a dead
// connection must stop billing exactly like a manual pause does).
// `pauseReason` is display-only: it never gates `session.pause()` itself
// (that guard already lives inside `pause()` — `state.value !== 'live'` /
// `handoverActive`), it only picks which secondary line the paused panel
// shows.
// ---------------------------------------------------------------------------

type PauseReason = 'manual' | 'tab_hidden' | 'network' | 'exit'

const pauseReason = ref<PauseReason>('manual')
/** True only while THIS guard is the reason the session is paused — so its onReconnected never resumes a pause the candidate started manually. */
const pausedByNetworkGuard = ref(false)
const networkPermanentlyFailed = ref(false)

/**
 * candidate-interview-call-ui D9 — the candidate confirmed Exit. This IS the
 * existing suspend (`session.pause()` stops the provider and reports
 * `/suspend`); `pauseReason` only picks the suspended wording. It is never
 * `useExitRedirect().redirect()`, which would clear the stored session and make
 * "you can resume later" false.
 */
function onExitConfirmed(): void {
  pauseReason.value = 'exit'
  session.pause()
}

const suspendedHeading = ref<HTMLElement | null>(null)

/** Until when the stored session can be resumed; null when it cannot be read. Evaluated on entering the suspended screen. */
const resumeDeadline = computed(() =>
  session.state.value === 'paused' && pauseReason.value === 'exit'
    ? formatDeadline(candidateSession.read()?.exp, locale.value)
    : null
)

watch(
  () => session.state.value === 'paused' && pauseReason.value === 'exit',
  async (suspended) => {
    if (!suspended) return
    await nextTick()
    suspendedHeading.value?.focus()
  }
)

function onResumeClicked(): void {
  networkPermanentlyFailed.value = false
  pausedByNetworkGuard.value = false
  session.resume()
}

const tabVisibilityGuard = useTabVisibilityGuard({
  isActive: () => session.state.value === 'live',
  onHiddenTimeout: () => {
    if (session.state.value !== 'live') return
    pauseReason.value = 'tab_hidden'
    session.pause()
  },
})

const networkGuard = useNetworkGuard({
  isActive: () => session.state.value === 'live' || session.state.value === 'paused',
  onOffline: () => {
    if (session.state.value === 'live') {
      pauseReason.value = 'network'
      pausedByNetworkGuard.value = true
      networkPermanentlyFailed.value = false
      session.pause()
    }
  },
  onReconnected: () => {
    if (pausedByNetworkGuard.value) {
      pausedByNetworkGuard.value = false
      networkPermanentlyFailed.value = false
      session.resume()
    }
  },
  onFailed: () => {
    // The provider session is already torn down (onOffline's pause() above) —
    // there is nothing further to stop. `networkPermanentlyFailed` swaps the
    // paused panel's notice from "reconnecting…" to "press Resume to try
    // again", reusing the EXISTING Resume affordance (which re-issues /start
    // via session.resume()) as the manual retry, rather than inventing a
    // second one.
    pausedByNetworkGuard.value = false
    networkPermanentlyFailed.value = true
  },
})

onMounted(() => {
  tabVisibilityGuard.start()
  networkGuard.start()
})

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

onUnmounted(async () => {
  tabVisibilityGuard.stop()
  networkGuard.stop()
  await session.teardown()
})

defineExpose({ session })
</script>
