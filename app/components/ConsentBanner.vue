<template>
  <div
    v-if="visible"
    data-testid="analytics-consent"
    role="region"
    :aria-label="$t('analytics_consent.region_label')"
    aria-describedby="analytics-consent-description"
    class="consent-banner"
  >
    <div class="consent-banner__text">
      <p class="consent-banner__title">
        {{ $t('analytics_consent.title') }}
      </p>
      <p id="analytics-consent-description" class="consent-banner__description">
        {{ $t('analytics_consent.description') }}
      </p>
    </div>

    <div class="consent-banner__actions">
      <button
        type="button"
        data-testid="analytics-consent-reject"
        class="consent-banner__button"
        @click="decide(false)"
      >
        {{ $t('analytics_consent.reject') }}
      </button>
      <button
        type="button"
        data-testid="analytics-consent-accept"
        class="consent-banner__button"
        @click="decide(true)"
      >
        {{ $t('analytics_consent.accept') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Analytics consent — ONE banner, not two (C13, task 5.6).
 *
 * The interview page already collects a RECORDING consent before a session
 * starts, and that one is a precondition of the service: refuse it and there is
 * no interview. Analytics consent must be refusable at no cost whatsoever.
 *
 * Bundling those into a single "Accept" is precisely what makes a consent
 * invalid — it is not freely given if saying no costs you the thing you came
 * for. So they stay separate decisions, and this banner never appears on the
 * pages where the other one lives. The candidate is only ever asked one thing
 * at a time.
 *
 * Everything below is shaped by one fact: NOT answering already means no.
 * Analytics defaults to denied, so an ignored banner is a safe banner. That is
 * what licenses the rest — no focus trap, no modal, no scroll lock, no dimmed
 * page, no second prompt.
 */
import {
  ANALYTICS_CONSENT_EVENT,
  hasAnalyticsDecision,
  writeAnalyticsConsent,
} from '~/app/utils/analytics-consent'
import { isAnalyticsSafeRoute } from '~/app/utils/analytics-path'

const props = defineProps<{
  /** Current route, so the banner can stand down where analytics never runs. */
  path: string
  /** Whether any analytics tool is configured for this deployment. */
  enabled: boolean
}>()

const answered = ref(false)

function storage(): Storage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage
}

const visible = computed(() => {
  if (answered.value || !props.enabled) {
    return false
  }

  // Never on the interview branch. Analytics does not run there, and a cookie
  // dialog stacked on the consent that actually gates somebody's assessment is
  // the exact "two banners" this component exists to avoid.
  if (!isAnalyticsSafeRoute(props.path)) {
    return false
  }

  return !hasAnalyticsDecision(storage())
})

function decide(granted: boolean): void {
  writeAnalyticsConsent(storage(), granted)
  answered.value = true

  if (granted) {
    // Announced so the analytics plugin starts NOW rather than on the next page
    // load — consenting and then watching nothing happen reads as a broken
    // button. An event rather than a call into the plugin, so the plugin stays
    // the single owner of script injection and this component knows nothing
    // about Google or Microsoft.
    window.dispatchEvent(new CustomEvent(ANALYTICS_CONSENT_EVENT))
  }
}
</script>

<style scoped>
.consent-banner {
  position: fixed;
  inset-inline: 0;
  bottom: 0;
  z-index: 50;

  display: flex;
  flex-wrap: wrap;
  gap: 1rem 1.5rem;
  align-items: center;
  justify-content: space-between;

  padding: 1rem 1.25rem;
  /* Clears the home indicator on notched devices; harmless everywhere else. */
  padding-bottom: max(1rem, env(safe-area-inset-bottom));

  background: var(--color-background, #fff);
  border-top: 1px solid var(--color-border, #e5e7eb);
  color: var(--color-foreground, #111827);
  box-shadow: 0 -4px 16px rgb(0 0 0 / 8%);

  animation: consent-banner-in 200ms ease-out;
}

.consent-banner__text {
  flex: 1 1 22rem;
  min-width: 0;
}

.consent-banner__title {
  margin: 0 0 0.25rem;
  font-weight: 600;
}

.consent-banner__description {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--color-muted-foreground, #6b7280);
}

.consent-banner__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

/*
 * IDENTICAL styling for both buttons — load-bearing, not laziness.
 *
 * A prominent "Accept" beside a faint "Reject" link is a dark pattern that
 * regulators now name explicitly: a choice harder to refuse than to accept is
 * not freely given. consent-banner.spec.ts asserts the two carry the same
 * classes, because this is the detail a redesign erodes by accident.
 */
.consent-banner__button {
  flex: 1 1 auto;
  min-width: 8rem;
  padding: 0.5rem 1.25rem;

  font: inherit;
  font-weight: 500;
  color: inherit;

  background: transparent;
  border: 1px solid var(--color-border, #d1d5db);
  border-radius: 0.375rem;
  cursor: pointer;

  transition: background-color 150ms ease;
}

.consent-banner__button:hover {
  background: var(--color-muted, #f3f4f6);
}

.consent-banner__button:focus-visible {
  outline: 2px solid var(--color-ring, #2563eb);
  outline-offset: 2px;
}

@keyframes consent-banner-in {
  from {
    transform: translateY(100%);
  }

  to {
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .consent-banner {
    animation: none;
  }

  .consent-banner__button {
    transition: none;
  }
}
</style>
