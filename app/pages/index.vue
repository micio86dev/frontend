<template>
  <div data-testid="root-landing" role="main" aria-labelledby="root-title">
    <h1 id="root-title">{{ $t('root.title') }}</h1>
    <p>{{ $t('root.message') }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * Root landing — an informational dead end, NOT a home page.
 *
 * A candidate never types this address. They arrive on /interview/{token} from
 * a magic link minted by the calling system, and they leave via the project's
 * exit_redirect_url back to that same system. Every entry is a token URL and
 * every exit is a redirect outward.
 *
 * People still land here: they open the link on a phone, see /unsupported, and
 * trim the URL; or their token expired; or they bookmarked the site. A bare 404
 * tells them the service is broken when the truth is that they simply need
 * their link.
 *
 * What this page deliberately does NOT have, and why:
 *
 *   - No login or sign-up. A candidate has no BEAI account by design; enrolment
 *     belongs to the calling system.
 *   - No support contact. BEAI holds no candidate contact data and has no
 *     relationship with this person. The party that invited them is the only one
 *     who can identify them or re-issue a link — pointing anywhere else sends a
 *     confused person to an organization that would have to ask "who are you?".
 *   - No API call, no state. If this ever needs data, it has become a different
 *     page and should be reasoned about again.
 *
 * All three prohibitions are covered by tests/unit/root-page.spec.ts, because a
 * comment saying "do not add a login here" survives only until somebody
 * disagrees with it in a hurry.
 *
 * The global browser gate (browser-gate.global.ts) skips only paths ending in
 * /unsupported, so this route inherits it: a Firefox or sub-1024px visitor is
 * redirected before this renders. That ordering is correct — somebody on a
 * phone has two problems and only the device one is fixable right now.
 */
definePageMeta({
  name: 'root',
})

useHead({
  // WCAG 2.4.2 (Page Titled): non-empty <title> required.
  title: 'BEAI',
  meta: [{ name: 'robots', content: 'noindex, nofollow' }],
})
</script>
