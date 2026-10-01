import {
  captureReusableLinkFragment,
  discardReusableLinkFragment,
} from '~/app/utils/reusable-link-fragment'

/**
 * Strips a reusable link token from the address bar before anything else runs
 * (reusable-interview-links, AD-16).
 *
 * The file name starts with `00.` so Nuxt loads it ahead of `analytics.client`
 * and before any page code can read `location`. It runs on EVERY route, not only
 * the entry route: a phone that scans a kiosk QR code is redirected by the
 * browser gate to `/unsupported`, a 302 that browsers carry the fragment across,
 * and the token must not sit in the address bar there either. On that route
 * nothing ever asks for the token, so it is simply never used.
 *
 * `.client` because there is no `window` on the server, and the server never
 * receives a fragment anyway.
 */
export default defineNuxtPlugin(() => {
  captureReusableLinkFragment(window)

  // A hash-only change is a same-document navigation: the visitor pastes a link
  // into the address bar of the tab already showing the entry route and nothing
  // reloads, so the start hook above does not run again. Strip it and drop the
  // token, so it cannot linger in the address bar or in history. Redeeming is
  // the entry page's job, once per mount, and it never happens from here.
  window.addEventListener('hashchange', () => {
    captureReusableLinkFragment(window)
    discardReusableLinkFragment()
  })
})
