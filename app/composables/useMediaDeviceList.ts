/**
 * useMediaDeviceList — camera/microphone inventory + preference persistence
 *
 * Owns `enumerateDevices()`, the `devicechange` subscription, and the
 * `beai_device_prefs` cookie. NEVER calls getUserMedia and NEVER touches a
 * MediaStream — useDeviceCheck is the only module that does either (Technical
 * Approach, design.md). This composable supplies the two building blocks of
 * the D4 fallback algorithm that do NOT require a stream:
 *   - step 1 (primary mechanism): validatePreferences() drops a stored
 *     deviceId absent from the current enumeration, so the rarer
 *     OverconstrainedError race (device unplugged between enumeration and
 *     acquisition) is the exception, not the common path.
 *   - steps 4/5: persist() rewrites the cookie to whatever was ACTUALLY
 *     obtained, read back via useDeviceCheck's activeSelection.
 * The OverconstrainedError → unconstrained retry itself (D4 steps 2-3) lives
 * in useDeviceCheck.acquireWithFallback — it requires a stream, which this
 * composable never touches.
 *
 * SSR invariant: navigator.mediaDevices is read only inside function bodies
 * (refresh/start/stop), never at module scope. `useCookie` is Nuxt's
 * auto-imported client/server-safe cookie composable — the interview route
 * this component belongs to is `ssr:false`, so in practice this always runs
 * client-side, but useCookie itself is safe either way (zero new dependency,
 * proposal A4).
 *
 * Design refs: D2 (composable interfaces), D4 (cookie persistence + fallback
 * algorithm), DA2 (cookie `path: '/'`, not `/interview`), DA3 (30-day maxAge).
 */

import { ref, type Ref } from 'vue'
import type { DeviceSelection } from './useDeviceCheck'

// ── Tunables ────────────────────────────────────────────────────────────────

/** Single cookie, JSON `{ c, m }` — atomic write; two cookies can desynchronize (D4). */
const COOKIE_NAME = 'beai_device_prefs'

/** `path: '/'`, NOT `/interview` (DA2) — i18n `strategy: 'prefix_except_default'` with
 * default `it` puts English candidates on `/en/interview/session`, which a cookie
 * scoped to `/interview` would not cover, silently breaking persistence for one of
 * the two shipping locales. */
const COOKIE_PATH = '/'

/** 30 days (DA3) — spans a realistic re-invite cycle; a longer window only buys
 * more stale ids, which validatePreferences() already absorbs. */
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

// ── Public interface ────────────────────────────────────────────────────────

export interface MediaDeviceOption {
  deviceId: string
  label: string
  /** true when the platform returned a blank label (no grant yet). The view
   * renders a numbered fallback name ("Camera 1") only when this is true —
   * the composable itself holds no i18n copy. */
  isFallbackLabel: boolean
}

export interface UseMediaDeviceListReturn {
  cameras: Ref<MediaDeviceOption[]>
  microphones: Ref<MediaDeviceOption[]>
  /** cookie-backed preference; null = system default */
  preferredCameraId: Ref<string | null>
  preferredMicId: Ref<string | null>
  /** Enumerate + rebuild both lists. Call once pre-acquisition (ids only, labels
   * may be blank) and once post-grant (labels populated) — same function. */
  refresh(): Promise<void>
  /** Drops stored ids no longer present in the current cameras/microphones
   * lists (call refresh() first); returns the survivors. Mutates
   * preferredCameraId/preferredMicId in place when it prunes. */
  validatePreferences(): DeviceSelection
  /** Writes `sel` to both the cookie and preferredCameraId/preferredMicId. */
  persist(sel: DeviceSelection): void
  /** Attach the `devicechange` listener (idempotent). */
  start(): void
  /** Detach the `devicechange` listener (safe to call unstarted). */
  stop(): void
}

interface DevicePrefsCookie {
  /** camera deviceId */
  c: string | null
  /** microphone deviceId */
  m: string | null
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function useMediaDeviceList(): UseMediaDeviceListReturn {
  const cameras = ref<MediaDeviceOption[]>([])
  const microphones = ref<MediaDeviceOption[]>([])

  const cookie = useCookie<DevicePrefsCookie | null>(COOKIE_NAME, {
    default: () => null,
    path: COOKIE_PATH,
    maxAge: COOKIE_MAX_AGE_SECONDS,
    sameSite: 'strict',
    secure: true,
    httpOnly: false,
  })

  const preferredCameraId = ref<string | null>(cookie.value?.c ?? null)
  const preferredMicId = ref<string | null>(cookie.value?.m ?? null)

  let deviceChangeHandler: (() => void) | null = null

  function toOption(device: MediaDeviceInfo): MediaDeviceOption | null {
    if (!device.deviceId) return null
    return { deviceId: device.deviceId, label: device.label, isFallbackLabel: device.label === '' }
  }

  async function refresh(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return
    const devices = await navigator.mediaDevices.enumerateDevices()

    cameras.value = devices
      .filter((d) => d.kind === 'videoinput')
      .map(toOption)
      .filter((d): d is MediaDeviceOption => d !== null)

    microphones.value = devices
      .filter((d) => d.kind === 'audioinput')
      .map(toOption)
      .filter((d): d is MediaDeviceOption => d !== null)
  }

  function validatePreferences(): DeviceSelection {
    const cameraIds = new Set(cameras.value.map((c) => c.deviceId))
    const micIds = new Set(microphones.value.map((m) => m.deviceId))

    const survivingCamera =
      preferredCameraId.value !== null && cameraIds.has(preferredCameraId.value)
        ? preferredCameraId.value
        : null
    const survivingMic =
      preferredMicId.value !== null && micIds.has(preferredMicId.value)
        ? preferredMicId.value
        : null

    preferredCameraId.value = survivingCamera
    preferredMicId.value = survivingMic

    return { cameraId: survivingCamera, micId: survivingMic }
  }

  function persist(sel: DeviceSelection): void {
    preferredCameraId.value = sel.cameraId ?? null
    preferredMicId.value = sel.micId ?? null
    cookie.value = { c: preferredCameraId.value, m: preferredMicId.value }
  }

  function start(): void {
    if (deviceChangeHandler || !navigator.mediaDevices?.addEventListener) return
    deviceChangeHandler = () => {
      void refresh()
    }
    navigator.mediaDevices.addEventListener('devicechange', deviceChangeHandler)
  }

  function stop(): void {
    if (deviceChangeHandler && navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', deviceChangeHandler)
    }
    deviceChangeHandler = null
  }

  return {
    cameras,
    microphones,
    preferredCameraId,
    preferredMicId,
    refresh,
    validatePreferences,
    persist,
    start,
    stop,
  }
}
