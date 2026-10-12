/**
 * Reads the interview's total time limit from a start response.
 *
 * The server sets it from the active avatar template (`maxCallDurationSec` for
 * Tavus) and the candidate countdown must follow it. Only a positive whole
 * number counts: anything else is `null`, and the caller decides the fallback.
 */
export function interviewMaxSecondsFrom(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}
