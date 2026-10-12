/**
 * Judges the candidate's connection from a few round trips to the API, before the interview.
 * The median is used so one slow or failed probe does not decide the verdict on its own.
 */

/** A median round trip above this means the avatar call will likely stutter. */
export const SLOW_ROUND_TRIP_MS = 800

/** A probe that has not answered by now counts as unanswered. */
export const PROBE_TIMEOUT_MS = 2_000

export type ConnectionQuality = 'good' | 'slow' | 'unreachable'

/** `null` marks a probe that got no answer. */
export function evaluateConnection(roundTripsMs: ReadonlyArray<number | null>): ConnectionQuality {
  const answered = roundTripsMs.filter((ms): ms is number => ms !== null).sort((a, b) => a - b)
  // Most probes unanswered means the link is effectively down, whatever the one that answered said.
  if (answered.length === 0 || answered.length * 2 <= roundTripsMs.length) return 'unreachable'

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
      await withTimeout(fetcher(url), PROBE_TIMEOUT_MS)
      results.push(performance.now() - started)
    } catch {
      results.push(null)
    }
  }

  return results
}

/** Rejects if `work` has not settled within `ms`, so a request that hangs cannot stall the verdict. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('probe timed out')), ms)
  })

  return Promise.race([work, expired]).finally(() => clearTimeout(timer))
}
