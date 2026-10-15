/**
 * useInterviewOutline: the live call's competency storyboard data.
 *
 * `refresh()` is single-flight with one trailing re-run, per composable instance, and a
 * failed fetch never throws: it keeps the previous value (or null) so the interview is
 * never blocked by the outline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { operations } from '~~/types/api'

import { useInterviewOutline } from '~/app/composables/useInterviewOutline'

const { mockCandidateFetch } = vi.hoisted(() => ({ mockCandidateFetch: vi.fn() }))

vi.mock('~/app/utils/candidate-api', () => ({
  candidateFetch: mockCandidateFetch,
}))

type Outline = operations['outline.show']['responses'][200]['content']['application/json']

const outlineOf = (candidateName: string): Outline => ({
  assessment_type: 'standard',
  role_name: 'Team Lead',
  avatar_name: 'Giulia',
  candidate_name: candidateName,
  primary_total_all: 6,
  competencies: [
    { name: 'Problem solving', ordinal: 1, status: 'current', primary_total: 3 },
    { name: null, ordinal: 2, status: 'upcoming', primary_total: 3 },
  ],
})

/** A fetch the test settles by hand, so "in flight" is observable. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useInterviewOutline', () => {
  beforeEach(() => {
    mockCandidateFetch.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts empty and loads the outline from the candidate outline endpoint', async () => {
    mockCandidateFetch.mockResolvedValue(outlineOf('Ada'))
    const { outline, refresh } = useInterviewOutline()

    expect(outline.value).toBeNull()
    await refresh()

    expect(mockCandidateFetch).toHaveBeenCalledTimes(1)
    expect(mockCandidateFetch).toHaveBeenCalledWith('/candidate/interview/outline')
    expect(outline.value).toEqual(outlineOf('Ada'))
  })

  it('issues no second request while one is in flight, then re-runs once', async () => {
    const first = deferred<Outline>()
    mockCandidateFetch.mockReturnValueOnce(first.promise).mockResolvedValueOnce(outlineOf('Second'))
    const { outline, refresh } = useInterviewOutline()

    const a = refresh()
    const b = refresh()
    const c = refresh()
    expect(mockCandidateFetch).toHaveBeenCalledTimes(1)

    first.resolve(outlineOf('First'))
    await Promise.all([a, b, c])

    // Three calls during one flight collapse into exactly one trailing run.
    expect(mockCandidateFetch).toHaveBeenCalledTimes(2)
    expect(outline.value?.candidate_name).toBe('Second')
  })

  it('does not re-run when nothing marked it dirty', async () => {
    mockCandidateFetch.mockResolvedValue(outlineOf('Ada'))
    const { refresh } = useInterviewOutline()

    await refresh()
    await refresh()

    // Two sequential calls, each its own flight: two requests, no phantom third.
    expect(mockCandidateFetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the previous value when a later fetch fails, and never throws', async () => {
    mockCandidateFetch
      .mockResolvedValueOnce(outlineOf('Ada'))
      .mockRejectedValueOnce(new Error('network down'))
    const { outline, refresh } = useInterviewOutline()

    await refresh()
    await expect(refresh()).resolves.toBeUndefined()

    expect(outline.value).toEqual(outlineOf('Ada'))
  })

  it('leaves the outline null when the first fetch fails, and recovers on the next refresh', async () => {
    mockCandidateFetch
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce(outlineOf('Ada'))
    const { outline, refresh } = useInterviewOutline()

    await expect(refresh()).resolves.toBeUndefined()
    expect(outline.value).toBeNull()

    await refresh()
    expect(outline.value).toEqual(outlineOf('Ada'))
  })

  it('still runs the trailing fetch after the first one failed', async () => {
    const first = deferred<Outline>()
    mockCandidateFetch.mockReturnValueOnce(first.promise).mockResolvedValueOnce(outlineOf('Ada'))
    const { outline, refresh } = useInterviewOutline()

    const a = refresh()
    const b = refresh()
    first.reject(new Error('boom'))
    await Promise.all([a, b])

    expect(mockCandidateFetch).toHaveBeenCalledTimes(2)
    expect(outline.value).toEqual(outlineOf('Ada'))
  })

  it('keeps per-instance state: two instances share neither value nor flight', async () => {
    const first = deferred<Outline>()
    mockCandidateFetch.mockReturnValueOnce(first.promise).mockResolvedValueOnce(outlineOf('Other'))
    const one = useInterviewOutline()
    const two = useInterviewOutline()

    const pending = one.refresh()
    await two.refresh()

    // The second instance was not blocked by the first one's flight.
    expect(mockCandidateFetch).toHaveBeenCalledTimes(2)
    expect(two.outline.value?.candidate_name).toBe('Other')
    expect(one.outline.value).toBeNull()

    first.resolve(outlineOf('One'))
    await pending
    expect(one.outline.value?.candidate_name).toBe('One')
    expect(two.outline.value?.candidate_name).toBe('Other')
  })

  it('re-runs a refresh issued after the final dirty check but before the flight settles', async () => {
    const first = deferred<Outline>()
    mockCandidateFetch.mockReturnValueOnce(first.promise).mockResolvedValueOnce(outlineOf('Second'))
    const { outline, refresh } = useInterviewOutline()

    const flight = refresh()
    // Queued before the fetch continuation runs, so it lands right after the last dirty
    // check and before the flight's own settle handlers.
    first.resolve(outlineOf('First'))
    queueMicrotask(() => void refresh())
    await flight
    await vi.waitFor(() => expect(mockCandidateFetch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(outline.value?.candidate_name).toBe('Second'))
  })
})
