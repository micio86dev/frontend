/**
 * Task 4.1 RED — Unit tests for app/composables/useMediaDeviceList
 *
 * Verifies (design D2, D4 — Slice 4 of device-check-preview-and-device-selection):
 * - refresh() enumerates devices → cameras/microphones with isFallbackLabel
 * - devicechange (via start()) triggers a refresh; stop() tears the listener down
 * - cookie round-trip: persist() writes beai_device_prefs; a fresh instance reads it
 * - validatePreferences() prunes a stored id absent from the enumerated list —
 *   D4 step 1, the PRIMARY fallback mechanism (so OverconstrainedError never
 *   happens on the common return visit)
 *
 * Only enumerateDevices is mocked — no getUserMedia/stream mocks are needed
 * (useMediaDeviceList never touches a stream, by design).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const COOKIE_NAME = 'beai_device_prefs'

function clearCookie(): void {
  document.cookie = `${COOKIE_NAME}=; path=/; max-age=0`
}

function readCookieRaw(): string | undefined {
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${COOKIE_NAME}=`))
  return match ? decodeURIComponent(match.slice(COOKIE_NAME.length + 1)) : undefined
}

interface FakeDeviceInfo {
  deviceId: string
  kind: 'videoinput' | 'audioinput' | 'audiooutput'
  label: string
  groupId: string
}

function makeDeviceInfo(overrides: Partial<FakeDeviceInfo> = {}): FakeDeviceInfo {
  return {
    deviceId: 'device-1',
    kind: 'videoinput',
    label: 'Integrated Camera',
    groupId: 'group-1',
    ...overrides,
  }
}

describe('useMediaDeviceList', () => {
  let enumerateDevicesSpy: ReturnType<typeof vi.fn>
  let addEventListenerSpy: ReturnType<typeof vi.fn>
  let removeEventListenerSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    clearCookie()
    enumerateDevicesSpy = vi.fn().mockResolvedValue([])
    addEventListenerSpy = vi.fn()
    removeEventListenerSpy = vi.fn()
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: enumerateDevicesSpy,
        addEventListener: addEventListenerSpy,
        removeEventListener: removeEventListenerSpy,
      },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    clearCookie()
  })

  // -------------------------------------------------------------------------
  // Task 4.1 — enumeration → cameras/microphones with isFallbackLabel
  // -------------------------------------------------------------------------

  describe('refresh()', () => {
    it('populates cameras and microphones from enumerateDevices, ignoring audiooutput', async () => {
      enumerateDevicesSpy.mockResolvedValue([
        makeDeviceInfo({ deviceId: 'cam-1', kind: 'videoinput', label: 'Front Camera' }),
        makeDeviceInfo({ deviceId: 'mic-1', kind: 'audioinput', label: 'Built-in Mic' }),
        makeDeviceInfo({ deviceId: 'spk-1', kind: 'audiooutput', label: 'Speakers' }),
      ])

      const { useMediaDeviceList } = await import('~/app/composables/useMediaDeviceList')
      const list = useMediaDeviceList()
      await list.refresh()

      expect(list.cameras.value).toEqual([
        { deviceId: 'cam-1', label: 'Front Camera', isFallbackLabel: false },
      ])
      expect(list.microphones.value).toEqual([
        { deviceId: 'mic-1', label: 'Built-in Mic', isFallbackLabel: false },
      ])
    })

    it('marks a blank pre-grant label as isFallbackLabel', async () => {
      enumerateDevicesSpy.mockResolvedValue([
        makeDeviceInfo({ deviceId: 'cam-1', kind: 'videoinput', label: '' }),
      ])

      const { useMediaDeviceList } = await import('~/app/composables/useMediaDeviceList')
      const list = useMediaDeviceList()
      await list.refresh()

      expect(list.cameras.value).toEqual([{ deviceId: 'cam-1', label: '', isFallbackLabel: true }])
    })

    it('ignores entries with no deviceId (nothing to select)', async () => {
      enumerateDevicesSpy.mockResolvedValue([
        makeDeviceInfo({ deviceId: '', kind: 'videoinput', label: '' }),
      ])

      const { useMediaDeviceList } = await import('~/app/composables/useMediaDeviceList')
      const list = useMediaDeviceList()
      await list.refresh()

      expect(list.cameras.value).toEqual([])
    })

    it('a second refresh() call replaces the lists rather than appending', async () => {
      enumerateDevicesSpy.mockResolvedValueOnce([
        makeDeviceInfo({ deviceId: 'cam-1', kind: 'videoinput', label: 'Cam 1' }),
      ])
      const { useMediaDeviceList } = await import('~/app/composables/useMediaDeviceList')
      const list = useMediaDeviceList()
      await list.refresh()
      expect(list.cameras.value).toHaveLength(1)

      enumerateDevicesSpy.mockResolvedValueOnce([
        makeDeviceInfo({ deviceId: 'cam-1', kind: 'videoinput', label: 'Cam 1' }),
        makeDeviceInfo({ deviceId: 'cam-2', kind: 'videoinput', label: 'Cam 2' }),
      ])
      await list.refresh()
      expect(list.cameras.value).toHaveLength(2)
    })
  })

  // -------------------------------------------------------------------------
  // Task 4.1 — devicechange subscription (start/stop)
  // -------------------------------------------------------------------------

  describe('start() / stop() — devicechange subscription', () => {
    it('start() subscribes to devicechange, which triggers a refresh', async () => {
      const { useMediaDeviceList } = await import('~/app/composables/useMediaDeviceList')
      const list = useMediaDeviceList()
      list.start()

      expect(addEventListenerSpy).toHaveBeenCalledWith('devicechange', expect.any(Function))

      const callsBefore = enumerateDevicesSpy.mock.calls.length
      const handler = addEventListenerSpy.mock.calls[0]?.[1] as () => void
      handler()
      await Promise.resolve()

      expect(enumerateDevicesSpy.mock.calls.length).toBeGreaterThan(callsBefore)
    })

    it('start() is idempotent — calling it twice attaches only one listener', async () => {
      const { useMediaDeviceList } = await import('~/app/composables/useMediaDeviceList')
      const list = useMediaDeviceList()
      list.start()
      list.start()

      expect(addEventListenerSpy).toHaveBeenCalledOnce()
    })

    it('stop() removes the SAME listener reference that start() attached', async () => {
      const { useMediaDeviceList } = await import('~/app/composables/useMediaDeviceList')
      const list = useMediaDeviceList()
      list.start()
      const attachedHandler = addEventListenerSpy.mock.calls[0]?.[1]

      list.stop()

      expect(removeEventListenerSpy).toHaveBeenCalledWith('devicechange', attachedHandler)
    })

    it('stop() before start() is a safe no-op', async () => {
      const { useMediaDeviceList } = await import('~/app/composables/useMediaDeviceList')
      const list = useMediaDeviceList()
      expect(() => list.stop()).not.toThrow()
      expect(removeEventListenerSpy).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Task 4.1/4.2 — cookie round-trip (beai_device_prefs, path:'/')
  // -------------------------------------------------------------------------

  describe('cookie persistence (beai_device_prefs)', () => {
    it('persist() writes both ids to the cookie and updates the preferred* refs', async () => {
      const { useMediaDeviceList } = await import('~/app/composables/useMediaDeviceList')
      const list = useMediaDeviceList()

      list.persist({ cameraId: 'cam-9', micId: 'mic-9' })

      expect(list.preferredCameraId.value).toBe('cam-9')
      expect(list.preferredMicId.value).toBe('mic-9')
      const raw = readCookieRaw()
      expect(raw).toBeDefined()
      expect(JSON.parse(raw as string)).toEqual({ c: 'cam-9', m: 'mic-9' })
    })

    it('the cookie is written with path=/ (NOT /interview — prefix_except_default puts English on /en/interview/**)', async () => {
      const { useMediaDeviceList } = await import('~/app/composables/useMediaDeviceList')
      const list = useMediaDeviceList()

      list.persist({ cameraId: 'cam-9', micId: 'mic-9' })

      const cookieString = document.cookie
      // happy-dom's document.cookie getter does not expose attributes, only
      // name=value pairs — so this asserts what the getter CAN prove: the
      // cookie is readable from the document at all (i.e. it was not scoped
      // to a narrower path that this test's origin/path can't see).
      expect(cookieString).toContain(COOKIE_NAME)
    })

    it('a fresh useMediaDeviceList() instance reads a previously persisted cookie (reload survival)', async () => {
      const { useMediaDeviceList } = await import('~/app/composables/useMediaDeviceList')
      const first = useMediaDeviceList()
      first.persist({ cameraId: 'cam-9', micId: 'mic-9' })

      vi.resetModules()
      const { useMediaDeviceList: useMediaDeviceListAgain } =
        await import('~/app/composables/useMediaDeviceList')
      const second = useMediaDeviceListAgain()

      expect(second.preferredCameraId.value).toBe('cam-9')
      expect(second.preferredMicId.value).toBe('mic-9')
    })

    it('no cookie present → preferred ids default to null', async () => {
      const { useMediaDeviceList } = await import('~/app/composables/useMediaDeviceList')
      const list = useMediaDeviceList()

      expect(list.preferredCameraId.value).toBeNull()
      expect(list.preferredMicId.value).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Task 4.1/4.4 — validatePreferences(): stale-id pruning (D4 step 1)
  // -------------------------------------------------------------------------

  describe('validatePreferences() — stale-id pruning (D4 step 1)', () => {
    it('drops a stored id absent from the enumerated list, never throws', async () => {
      const { useMediaDeviceList } = await import('~/app/composables/useMediaDeviceList')
      const list = useMediaDeviceList()
      list.persist({ cameraId: 'cam-unplugged', micId: 'mic-unplugged' })

      enumerateDevicesSpy.mockResolvedValue([
        makeDeviceInfo({ deviceId: 'cam-current', kind: 'videoinput', label: 'Current Cam' }),
        makeDeviceInfo({ deviceId: 'mic-current', kind: 'audioinput', label: 'Current Mic' }),
      ])
      await list.refresh()

      const result = list.validatePreferences()

      expect(result).toEqual({ cameraId: null, micId: null })
      expect(list.preferredCameraId.value).toBeNull()
      expect(list.preferredMicId.value).toBeNull()
    })

    it('a surviving id (still present in the enumerated list) is kept', async () => {
      const { useMediaDeviceList } = await import('~/app/composables/useMediaDeviceList')
      const list = useMediaDeviceList()
      list.persist({ cameraId: 'cam-current', micId: 'mic-gone' })

      enumerateDevicesSpy.mockResolvedValue([
        makeDeviceInfo({ deviceId: 'cam-current', kind: 'videoinput', label: 'Current Cam' }),
      ])
      await list.refresh()

      const result = list.validatePreferences()

      expect(result).toEqual({ cameraId: 'cam-current', micId: null })
    })

    it('no stored preference at all → validatePreferences() returns both null without enumerating anything special', async () => {
      const { useMediaDeviceList } = await import('~/app/composables/useMediaDeviceList')
      const list = useMediaDeviceList()

      const result = list.validatePreferences()

      expect(result).toEqual({ cameraId: null, micId: null })
    })
  })
})
