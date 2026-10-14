/**
 * useInterviewOutline: the competency storyboard data of the live call
 * (`GET /api/candidate/interview/outline`).
 *
 * State is per call (never module-level). `refresh()` is single-flight with one trailing
 * re-run: a call made while a request is in flight marks it dirty and the request runs once
 * more when it settles, so a boundary that lands during the first fetch is never lost.
 *
 * A failed fetch never throws and never blocks the interview: the previous value (or null)
 * is kept, and the consumers fall back to their own labels when the outline is null.
 */

import { ref, readonly } from 'vue'
import { candidateFetch } from '~/app/utils/candidate-api'
import type { operations } from '~~/types/api'

export type Outline = operations['outline.show']['responses'][200]['content']['application/json']

export function useInterviewOutline() {
  const outline = ref<Outline | null>(null)
  let inFlight: Promise<void> | null = null
  let dirty = false

  async function load(): Promise<void> {
    do {
      dirty = false
      try {
        outline.value = await candidateFetch<Outline>('/candidate/interview/outline')
      } catch (err) {
        console.warn('[useInterviewOutline] outline fetch failed, keeping the previous value:', err)
      }
    } while (dirty)
  }

  function refresh(): Promise<void> {
    if (inFlight) {
      dirty = true
      return inFlight
    }
    inFlight = load().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  return { outline: readonly(outline), refresh }
}
