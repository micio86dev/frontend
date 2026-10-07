/**
 * Which integrity kinds the candidate is told about, and where their copy lives.
 *
 * Every kind maps to an i18n block `interview.integrity_toast.<kind>` holding a
 * short title and one line telling the candidate what to do. The machine kind
 * itself never reaches the UI: a kind this build does not know (a newer server
 * or proctor) falls back to the generic block, never to the raw string.
 *
 * `proctor_unavailable` is deliberately silent. It reports a detector of ours
 * that failed to load, not anything the candidate did, and there is nothing they
 * could do about it; telling them would only alarm them mid-answer.
 */
import { INTEGRITY_KINDS, type IntegrityType } from './proctor-config'

const SILENT_KINDS: ReadonlySet<string> = new Set<IntegrityType>(['proctor_unavailable'])

/** The kinds that produce a toast, each with its own copy block. */
export const CANDIDATE_FACING_KINDS: readonly IntegrityType[] = Object.freeze(
  INTEGRITY_KINDS.filter((kind) => !SILENT_KINDS.has(kind))
)

const KEY_PREFIX = 'interview.integrity_toast'
const KNOWN: ReadonlySet<string> = new Set(CANDIDATE_FACING_KINDS)

/**
 * The i18n block for a kind, or `null` when the kind is not shown at all.
 *
 * @param kind - the machine kind recorded by the proctor (any string)
 */
export function integrityToastKey(kind: string): string | null {
  if (SILENT_KINDS.has(kind)) return null
  return `${KEY_PREFIX}.${KNOWN.has(kind) ? kind : 'generic'}`
}
