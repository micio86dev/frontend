/**
 * Capture and strip the reusable link token (reusable-interview-links, AD-16).
 *
 * A reusable interview link is `{origin}[/en]/interview/reusable#beai_rl_<43>`.
 * The token rides in the URL FRAGMENT so that no server, proxy or access log
 * ever sees it, but a fragment is still part of the address bar, the history
 * entry, a screenshot and whatever the visitor copies next. So it is removed the
 * moment the app starts, and the page that redeems it takes it from module
 * memory exactly once.
 *
 * Two jobs, kept apart on purpose:
 *
 * - STRIP, unconditionally: any `#beai_rl_…` fragment, of any length, on any
 *   route. A truncated or padded token is a mistake worth cleaning up too, and
 *   the early plugin has no idea which route the visitor was sent to — a phone
 *   scanning a kiosk QR code is redirected to `/unsupported`, and browsers carry
 *   the fragment across that 302.
 * - HAND OVER, strictly: the token only if it has the exact 51-character shape.
 *   Anything else is reported as "a fragment was there, but it is not a link",
 *   which the page turns into the terminal `link_invalid` state without a
 *   network call.
 *
 * Module state, not storage: the token is never written to `localStorage`,
 * `sessionStorage`, a cookie, the router or the DOM.
 */

/**
 * `beai_rl_` followed by 43 base64url characters (256 bits), 51 in all. `\w` is
 * ASCII-only here (no `u` or `i` flag), so `[\w-]` is exactly `A-Za-z0-9_-`.
 */
export const REUSABLE_TOKEN_FORMAT = /^beai_rl_[\w-]{43}$/

/** Where a link fragment starts. Anchored: a marker buried in another fragment is not ours. */
const FRAGMENT_PREFIX = '#beai_rl_'

export interface ReusableLinkTake {
  /** A `#beai_rl_…` fragment was present at capture time, valid or not. */
  present: boolean
  /** The token, only when it matches `REUSABLE_TOKEN_FORMAT`. */
  token: string | null
}

/** The slice of `Window` this module touches, so a test can hand in a plain object. */
export interface FragmentWindow {
  location: Pick<Location, 'hash' | 'pathname' | 'search'>
  history: Pick<History, 'state' | 'replaceState'>
}

const NOTHING: ReusableLinkTake = { present: false, token: null }

let held: ReusableLinkTake = NOTHING

/**
 * Removes a `#beai_rl_…` fragment from the address bar and remembers it.
 *
 * `replaceState` with the CURRENT state: the router owns `history.state`, and
 * replacing the entry in place neither adds a history entry nor navigates, so
 * Back does not return to a URL that carries the credential.
 *
 * A call that finds no link fragment changes nothing — in particular it does
 * not erase a token captured earlier and not yet taken.
 */
export function captureReusableLinkFragment(win: FragmentWindow): void {
  const { hash, pathname, search } = win.location

  if (!hash.startsWith(FRAGMENT_PREFIX)) {
    return
  }

  win.history.replaceState(win.history.state, '', `${pathname}${search}`)

  const candidate = hash.slice(1)

  held = { present: true, token: REUSABLE_TOKEN_FORMAT.test(candidate) ? candidate : null }
}

/** Hands the held token over ONCE and forgets it. */
export function takeReusableLinkToken(): ReusableLinkTake {
  const taken = held

  held = NOTHING

  return taken
}

/** Forgets a held token without reading it. */
export function discardReusableLinkFragment(): void {
  held = NOTHING
}
