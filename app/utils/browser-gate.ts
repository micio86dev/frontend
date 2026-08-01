/**
 * browser-gate.ts — Pure browser-support gate function (D5, SA-11)
 *
 * Purpose: Determine whether the current browser/viewport combination is supported.
 * This is a PURE function: no browser globals at module scope, no side effects.
 * Callers supply the UA string and viewport width; all browser API reads happen
 * in the middleware wrapper (`app/middleware/browser-gate.global.ts`).
 *
 * Detection strategy:
 *   Firefox-denylist: /Firefox\//i — Firefox is explicitly rejected; all other
 *   desktop UA strings (Chrome/Edge/Opera/Safari) pass. IE11/legacy UAs pass
 *   by design — WebRTC/MediaPipe requirements block them at the functionality layer.
 *
 *   Mobile UA: /Mobi|Android|iPhone|iPad/i — catches mobile Chrome, Firefox for
 *   Android, Safari on iPhone/iPad. NOTE: iPadOS 13+ sends a Mac-like UA string
 *   by default, so the client-side width check (< 1024 px) is the authoritative
 *   tablet gate for modern iPads.
 *
 *   Viewport: width < 1024 px — per DESIGN.md §6: 768–1023 px = tablet = unsupported;
 *   < 768 px = mobile = unsupported. The supported floor is ≥ 1024 px.
 *   Server-side callers MUST pass Infinity as width (viewport is not available in
 *   HTTP headers); this bypasses the width check and applies only the UA predicates.
 *
 * @param ua     The User-Agent string (from navigator.userAgent or request header).
 * @param width  The viewport width in pixels. Pass Infinity on the server side.
 * @returns      true when the browser/viewport combination is supported.
 */
export function isSupportedBrowser(ua: string, width: number): boolean {
  // Reject Firefox (denylist — explicit rejection, not an allowed-list)
  if (/Firefox\//i.test(ua)) {
    return false
  }

  // Reject known mobile/tablet UA strings
  // (iPadOS 13+ may not contain 'iPad' — caught by the viewport check below)
  if (/Mobi|Android|iPhone|iPad/i.test(ua)) {
    return false
  }

  // Reject tablet/mobile viewports (width < 1024 px per DESIGN.md §6)
  // Callers passing Infinity (server-side) skip this check automatically.
  if (width < 1024) {
    return false
  }

  return true
}
