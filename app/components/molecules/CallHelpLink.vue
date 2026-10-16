<template>
  <!--
    «Problemi con audio o video?» (DESIGN.md §7.3). A full-width outlined button-looking link
    in the foreground ink (never the raw client colour, §3.1 rule 3). An `https:` support page opens in a new tab, so
    it carries `rel="noopener noreferrer"` and a hidden note for screen readers;
    a `mailto:` target opens the mail client and carries neither.
  -->
  <a
    :href="href"
    :target="external ? '_blank' : undefined"
    :rel="external ? 'noopener noreferrer' : undefined"
    data-testid="call-help-link"
    class="flex min-h-(--spacing-control) w-full items-center justify-center rounded-lg border border-border bg-transparent px-4 text-center text-base font-semibold text-foreground transition-colors outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-primary-ink"
  >
    {{ $t('interview.call.help.label') }}
    <span v-if="external" class="sr-only">{{ $t('interview.call.help.new_tab') }}</span>
  </a>
</template>

<script setup lang="ts">
/**
 * CallHelpLink — the help link of the candidate call screen
 * (candidate-interview-call-ui, UI-08; design D10).
 *
 * No props: the target is the configured support URL, read through
 * `useSupportUrl()` (sanitized to `https:` or `mailto:`).
 */
import { computed } from 'vue'
import { useSupportUrl } from '~/composables/useSupportUrl'

const href = useSupportUrl()
const external = computed(() => /^https:/i.test(href))
</script>
