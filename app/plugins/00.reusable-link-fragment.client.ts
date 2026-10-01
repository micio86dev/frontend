import {
  captureReusableLinkFragment,
  discardReusableLinkFragment,
} from '~/app/utils/reusable-link-fragment'

/**
 * Strips a reusable link token from the address bar before anything else runs
 * (reusable-interview-links, AD-16).
 *
 * It runs on EVERY route, not only the entry route: a phone that scans a kiosk
 * QR code is redirected by the browser gate to `/unsupported`, a 302 that
 * browsers carry the fragment across, and the token must not sit in the address
 * bar there either. On that route nothing ever asks for the token, so it is
 * simply never used.
 *
 * ORDER IS THE WHOLE POINT, and it is declared, not inferred from the file name.
 * Nuxt's router plugin (`nuxt:router`, order -20) reads `window.location` —
 * fragment included — while it sets up, and `app:created` then replays that
 * location through `router.replace`, which WRITES IT BACK to the address bar and
 * into `history.state.current`. A plugin at the default order strips the
 * fragment after that read, so the router undid it: found in the real app, where
 * `/unsupported#beai_rl_…` stayed in the address bar and the token sat in the
 * history state. `order: -50` puts this plugin first, so the router never sees
 * the fragment. Nuxt reads `order` statically from the file text, and only from
 * the object syntax: a function-form plugin carries no metadata, which is why
 * this is not written like the sibling analytics plugin. For the same reason
 * NO comment in this file may spell out a call to the define function followed
 * by a word character or a parenthesis: Nuxt scans the raw text, comments
 * included, takes that for a function-form plugin and silently drops the order.
 * `reusable-link-fragment.spec.ts` pins both halves.
 *
 * `.client` because there is no `window` on the server, and the server never
 * receives a fragment anyway.
 */
export default defineNuxtPlugin({
  name: 'reusable-link-fragment',
  order: -50,
  setup() {
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
  },
})
