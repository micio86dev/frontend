<template>
  <div>
    <NuxtRouteAnnouncer />
    <NuxtPage />
    <ConsentBanner :path="route.fullPath" :enabled="analyticsConfigured" />
  </div>
</template>

<script setup lang="ts">
const runtimeConfig = useRuntimeConfig()
const route = useRoute()
const appEnv = runtimeConfig.public.appEnv as string

// Inject noindex on local and staging environments
if (appEnv !== 'production') {
  useHead({
    meta: [{ name: 'robots', content: 'noindex, nofollow' }],
  })
}

/**
 * Whether this deployment has anything to ask permission FOR.
 *
 * With no measurement or project ID configured, nothing would load whatever the
 * visitor answered — so the banner would be asking about a decision that has no
 * effect, which is worse than not asking.
 *
 * Computed here rather than inside the banner: the runtime config belongs to
 * the app shell, and a component that reaches for it is a component that cannot
 * be mounted in a test without one.
 */
const analyticsConfigured = computed(
  () =>
    String(runtimeConfig.public.gaMeasurementId ?? '') !== '' ||
    String(runtimeConfig.public.clarityProjectId ?? '') !== ''
)
</script>
