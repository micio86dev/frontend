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

// ── Timing constants ────────────────────────────────────────────────────────

/** How often (ms) to flush the pending integrity event batch to POST /integrity */
export const FLUSH_INTERVAL_MS = 10_000

/** How often (ms) to capture and send a proctoring snapshot to POST /snapshot */
export const SNAPSHOT_INTERVAL_MS = 10_000

/** Frames per second to sample from the video stream for MediaPipe face analysis */
export const SAMPLE_FPS = 3

// ── Browser episode thresholds ──────────────────────────────────────────────

/** Ignore tab/focus flickers shorter than this (ms) */
export const MIN_BROWSER_EPISODE_MS = 500

// ── Face detection thresholds ───────────────────────────────────────────────

/** No face in frame for this long (ms) → face_absent event */
export const FACE_ABSENT_MS = 4_000

/** ≥2 faces in frame for this long (ms) → multiple_faces event */
export const MULTI_FACE_MS = 1_500

/** Head off-axis for this long (ms) → looking_away event */
export const LOOK_AWAY_MS = 2_500

/** |yaw| beyond this (degrees) = candidate is looking away */
export const LOOK_AWAY_YAW_DEG = 25

/** |pitch| beyond this (degrees) = candidate is looking away */
export const LOOK_AWAY_PITCH_DEG = 22

/** Negative pitch below this (degrees, downward tilt) = looking_down */
export const LOOK_DOWN_PITCH_DEG = 20

/**
 * Face bounding-box width (0–1 normalized) below this threshold = candidate is too far.
 * Derived from the normalized landmark x-spread across the face.
 */
export const FACE_MIN_WIDTH_RATIO = 0.2

/** Face too small in frame for this long (ms) → too_far event */
export const TOO_FAR_MS = 3_000

// ── Phone detection thresholds ──────────────────────────────────────────────

/** Run object detection every this many ms (CPU-light cadence) */
export const PHONE_SAMPLE_MS = 2_000

/** Phone visible in frame for this long (ms) → phone_detected event */
export const PHONE_DETECTED_MS = 3_000

/** Minimum EfficientDet-Lite0 score to count a detection as "cell phone" */
export const PHONE_SCORE_THRESHOLD = 0.5

// ── Audio thresholds ────────────────────────────────────────────────────────

/** Mic RMS (0–1) above this level = voice activity detected */
export const VOICE_RMS_THRESHOLD = 0.04

/** Sustained audio above threshold for this long (ms) while avatar speaks → second_voice */
export const SECOND_VOICE_MS = 2_000

/**
 * The 13 canonical proctoring integrity event kinds (frozen, authoritative list).
 * These are the machine-facing kind values sent to POST /integrity.
 */
export const INTEGRITY_KINDS = Object.freeze([
  'tab_hidden',
  'focus_lost',
  'second_monitor',
  'face_absent',
  'looking_away',
  'looking_down',
  'too_far',
  'multiple_faces',
  'fullscreen_exit',
  'clipboard_copy',
  'clipboard_paste',
  'second_voice',
  'phone_detected',
  // A DEAD OBSERVER, not a candidate behaviour (proctoring-honest-coverage AD-1).
  //
  // Reported when a detection layer fails to initialise, so the server can tell
  // "measured, nothing found" from "not measured at all". Without it a session
  // in which the detectors never loaded is indistinguishable from an
  // irreproachable candidate, and the review surface says "Rischio basso" about
  // observations nobody made.
  //
  // It carries no weight in the risk score: it is a statement about us, and
  // scoring it would penalise a person for a failure of ours.
  'proctor_unavailable',
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
