/**
 * Proctoring constants and pure utility functions.
 *
 * This module is SSR-safe: NO browser globals at module scope.
 * All browser API access (AudioContext, navigator, window) must be
 * inside client-guarded functions — never at module evaluation scope.
 *
 * Ported from legacy-demo/src/lib/proctor-config.ts with the following changes:
 *   - matchesEndPhrase now accepts phrases as parameters (D4: no hardcoded literals)
 *   - Hardcoded phrase constants removed — phrases come from the /start API response
 */

/** How often (ms) to flush the pending integrity event batch to POST /integrity */
export const FLUSH_INTERVAL_MS = 10_000

/** How often (ms) to capture and send a proctoring snapshot to POST /snapshot */
export const SNAPSHOT_INTERVAL_MS = 10_000

/** Frames per second to sample from the video stream for MediaPipe face analysis */
export const SAMPLE_FPS = 3

/**
 * The 13 canonical proctoring integrity event kinds (frozen, authoritative list).
 * These are the machine-facing kind values sent to POST /integrity.
 */
export const INTEGRITY_KINDS = Object.freeze([
  'tab_hidden',
  'focus_lost',
  'second_monitor',
  'clipboard_copy',
  'clipboard_paste',
  'face_absent',
  'multiple_faces',
  'looking_away',
  'looking_down',
  'too_far',
  'second_voice',
  'window_resize',
  'devtools_open',
] as const)

/** The union type of all valid integrity event kinds */
export type IntegrityType = (typeof INTEGRITY_KINDS)[number]

/** Internal integrity event shape (collected by useProctor) */
export interface IntegrityEventInternal {
  type: IntegrityType
  ts: string
  meta?: Record<string, unknown> | null
}

/**
 * Summarizes a list of integrity events, counting occurrences per kind.
 *
 * @param events - Array of internal integrity events
 * @returns Record mapping each occurring kind to its count
 */
export function summarizeIntegrity(events: IntegrityEventInternal[]): Record<string, number> {
  const summary: Record<string, number> = {}
  for (const event of events) {
    summary[event.type] = (summary[event.type] ?? 0) + 1
  }
  return summary
}

/**
 * Normalizes a phrase for accent/case/punctuation-insensitive comparison.
 *
 * Process:
 *   1. Lowercase
 *   2. NFD normalize (splits accented chars into base + combining marks)
 *   3. Strip non-alphanumeric characters (removes combining marks + punctuation)
 *   4. Collapse multiple spaces into one, then trim
 */
function normalizePhrase(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFD')
      // Strip Unicode combining diacritical marks (U+0300–U+036F) without inserting a space.
      // Using \p{M} (Unicode "Mark" category) with the /u flag instead of a character range
      // avoids obscure-range lint errors and handles the full combining mark set correctly.
      // This must happen BEFORE the non-alphanumeric replacement so that 'ā' (a + U+0304)
      // decomposes to 'a', not 'a' + ' '.

      .replace(/\p{M}/gu, '')
      // Replace remaining non-alphanumeric characters (punctuation, symbols) with space
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/**
 * Accent/case/punctuation-insensitive containment check for completion phrases.
 *
 * Returns true if `text` contains EITHER the `endPhrase` OR the `finalPhrase`
 * after normalization. Used by HeyGen provider to detect when the avatar has
 * finished speaking the project-language completion phrase.
 *
 * PRECONDITION: Both endPhrase and finalPhrase MUST be non-empty strings.
 * If either is absent, the HeyGen provider MUST emit 'error' BEFORE calling
 * this function — the guard lives in the provider, not here.
 *
 * Phrases come from the /start API response (question_context.end_phrase and
 * question_context.final_phrase) — they are project-language strings and MUST NOT
 * be hardcoded in this module.
 *
 * @param text - Avatar transcript text to check
 * @param phrases - Object containing the two completion signals from /start
 * @param phrases.endPhrase - Project-language phrase for intermediate question completion
 * @param phrases.finalPhrase - Project-language phrase for last question completion
 * @returns true if text contains either phrase (normalized), false otherwise
 */
export function matchesEndPhrase(
  text: string,
  phrases: { endPhrase: string; finalPhrase: string }
): boolean {
  const normalizedText = normalizePhrase(text)
  return (
    normalizedText.includes(normalizePhrase(phrases.endPhrase)) ||
    normalizedText.includes(normalizePhrase(phrases.finalPhrase))
  )
}
