/**
 * useCaptionsPreference: whether the live call shows the question as captions.
 *
 * live-interview-call-chrome, design D17 and tasks M7. A UI preference kept in the
 * browser: on by default, it survives a reload, and storage that cannot be read or
 * written must neither break the page nor stop the toggle from working in memory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'

import { useCaptionsPreference } from '~/app/composables/useCaptionsPreference'

const KEY = 'beai:interview:captions'

describe('useCaptionsPreference', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is on by default', () => {
    expect(useCaptionsPreference().value).toBe(true)
  })

  it('survives a re-instantiation once switched off', async () => {
    const first = useCaptionsPreference()
    first.value = false
    await nextTick()

    expect(localStorage.getItem(KEY)).toBe('false')
    expect(useCaptionsPreference().value).toBe(false)
  })

  it('turns back on and persists that too', async () => {
    const first = useCaptionsPreference()
    first.value = false
    await nextTick()
    first.value = true
    await nextTick()

    expect(useCaptionsPreference().value).toBe(true)
  })

  it('starts on and still toggles in memory when storage throws on read and write', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked')
    })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked')
    })

    const captions = useCaptionsPreference()
    expect(captions.value).toBe(true)

    captions.value = false
    await nextTick()
    expect(captions.value).toBe(false)

    captions.value = true
    await nextTick()
    expect(captions.value).toBe(true)

    // The write is flushed in a watcher; give it a macrotask so a swallowed error would have surfaced.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reported).not.toHaveBeenCalled()
  })

  it('never reaches the network', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('$fetch', fetchSpy)
    vi.stubGlobal('fetch', fetchSpy)

    const captions = useCaptionsPreference()
    captions.value = false
    await nextTick()

    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
