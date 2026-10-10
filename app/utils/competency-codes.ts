/**
 * A competency code is operator-authored, so no closed set exists and none is
 * shipped here (the competency list stays server-side). The brand only proves
 * the value matched the pattern, which cannot hold prose.
 */
export type CompetencyCode = string & { readonly __competency: unique symbol }

const PATTERN = /^[A-Z0-9_]{1,16}$/

export function asCompetencyCode(raw: string): CompetencyCode | null {
  return PATTERN.test(raw) ? (raw as CompetencyCode) : null
}
