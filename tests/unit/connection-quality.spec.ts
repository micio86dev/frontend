/**
 * Before the interview, the candidate's connection is measured with a few round trips and
 * judged, so a weak link is named before the call rather than discovered during it.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  evaluateConnection,
  probeConnection,
  SLOW_ROUND_TRIP_MS,
  PROBE_TIMEOUT_MS,
} from '~/app/utils/connection-quality'

describe('evaluateConnection', () => {
  it('is good when the typical round trip is quick', () => {
    expect(evaluateConnection([120, 140, 130])).toBe('good')
  })

  it('is slow when the typical round trip exceeds the threshold', () => {
    expect(evaluateConnection([SLOW_ROUND_TRIP_MS + 200, SLOW_ROUND_TRIP_MS + 400, 300])).toBe(
      'slow'
    )
  })

  it('is unreachable when no probe answered', () => {
    expect(evaluateConnection([null, null, null])).toBe('unreachable')
  })

  it('ignores a single failed probe when the others answered quickly', () => {
    expect(evaluateConnection([null, 130, 120])).toBe('good')
  })

  it('is unreachable with no samples at all', () => {
    expect(evaluateConnection([])).toBe('unreachable')
  })
})

describe('probeConnection', () => {
  it('returns one timing per sample, and null for a probe that failed', async () => {
    let calls = 0
    const results = await probeConnection(async () => {
      calls += 1
      if (calls === 2) throw new Error('offline')
    }, 3)

    expect(results).toHaveLength(3)
    expect(results[1]).toBeNull()
    expect(results[0]).toBeTypeOf('number')
  })

  it('asks the health route by default', async () => {
    const seen: string[] = []
    await probeConnection(async (url) => {
      seen.push(url)
    }, 1)

    expect(seen).toEqual(['/api/health'])
  })
})

describe('probeConnection timeout', () => {
  it('a probe that never answers counts as unanswered, not as a hang', async () => {
    vi.useFakeTimers()
    try {
      const pending = probeConnection(() => new Promise<void>(() => {}), 1)
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS)
      expect(await pending).toEqual([null])
    } finally {
      vi.useRealTimers()
    }
  })
})
