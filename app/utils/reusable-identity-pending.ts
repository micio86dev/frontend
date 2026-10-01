/**
 * The non-secret "the identity form is on screen" flag of the reusable entry route
 * (reusable-link-visitor-identity VD-15, spec "Reusable Reload During The Form
 * Shows A Reopen State").
 *
 * WHY IT EXISTS. The link token lives only in page memory and the stored session
 * was cleared when it was read, so a reload while the identity form is shown loses
 * the token. That is the safe behaviour (the token is never kept in storage, the
 * URL or history), but without more information the reload would land on
 * `link_invalid`, which would be untrue: the link is fine, the page just forgot it.
 * This flag lets the page say "open the link again" instead.
 *
 * WHAT IT MAY HOLD. Exactly the single character `1`, under one key, in
 * `sessionStorage` (per tab, survives a reload, dies with the tab): no token, no
 * name, no email, no URL, no timestamp. The value is a constant so nothing else can
 * be written through this module, and `consumeIdentityPending` accepts only that
 * exact value.
 *
 * Every access is wrapped: a storage that is unavailable or throws (a blocked-storage
 * policy, a private mode) degrades to "no flag", so the visitor sees the existing
 * `link_invalid` copy rather than a crashed page.
 */

export const IDENTITY_PENDING_KEY = 'beai_reusable_identity_pending'

const PENDING_VALUE = '1'

/** The tab's sessionStorage, or null when even reaching it throws. */
function defaultStorage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function markIdentityPending(storage: Storage | null = defaultStorage()): void {
  try {
    storage?.setItem(IDENTITY_PENDING_KEY, PENDING_VALUE)
  } catch {
    // Unavailable storage: the reload falls back to the `link_invalid` copy.
  }
}

/**
 * True when the flag is set, and removes it either way: a flag is read once, so a
 * second reload of the terminal page cannot re-trigger it, and an odd value does not
 * linger.
 */
export function consumeIdentityPending(storage: Storage | null = defaultStorage()): boolean {
  try {
    const present = storage?.getItem(IDENTITY_PENDING_KEY) === PENDING_VALUE

    storage?.removeItem(IDENTITY_PENDING_KEY)

    return present
  } catch {
    return false
  }
}

export function clearIdentityPending(storage: Storage | null = defaultStorage()): void {
  try {
    storage?.removeItem(IDENTITY_PENDING_KEY)
  } catch {
    // Nothing to clear when storage is unreachable.
  }
}
