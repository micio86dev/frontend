/**
 * Judges the candidate's connection from a few round trips to the API, before the interview.
 * The median is used so one slow or failed probe does not decide the verdict on its own.
 */

/** A median round trip above this means the avatar call will likely stutter. */
export const SLOW_ROUND_TRIP_MS = 800

export type ConnectionQuality = 'good' | 'slow' | 'unreachable'

/** `null` marks a probe that got no answer. */
export function evaluateConnection(roundTripsMs: ReadonlyArray<number | null>): ConnectionQuality {
  const answered = roundTripsMs.filter((ms): ms is number => ms !== null).sort((a, b) => a - b)
  if (answered.length === 0) return 'unreachable'

  const median = answered[Math.floor(answered.length / 2)]!

  return median > SLOW_ROUND_TRIP_MS ? 'slow' : 'good'
}

/**
 * Times a few requests to the health route. A request that fails or does not answer is `null`.
 * `fetcher` is injected so the timing is testable without a network.
 */
export async function probeConnection(
  fetcher: (url: string) => Promise<unknown>,
  samples = 3,
  url = '/api/health'
): Promise<Array<number | null>> {
  const results: Array<number | null> = []
  for (let i = 0; i < samples; i++) {
    const started = performance.now()
    try {
      await fetcher(url)
      results.push(performance.now() - started)
    } catch {
      results.push(null)
    }
  }

  return results
}
