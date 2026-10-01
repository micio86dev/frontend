import type { Page } from '@playwright/test'

/**
 * Fake camera, microphone and audio analyser for specs that must get past the
 * device check. A copy of the helper `interview-exit-redirect.spec.ts` and
 * `interview-flow.spec.ts` each carry inline; new specs import this one.
 */

// Device mocks — getUserMedia + AudioContext, mirrors interview-flow.spec.ts precedent.
// getSettings()/enumerateDevices()/add|removeEventListener are fixture FIDELITY
// (device-check-preview-and-device-selection D9) matching the real platform surface,
// not new assertions.
export async function injectDeviceMocks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const videoTrack = {
      readyState: 'live',
      kind: 'video',
      stop: () => {},
      getSettings: () => ({ deviceId: 'mock-camera-1', width: 1280, height: 720 }),
    }
    const audioTrack = {
      readyState: 'live',
      kind: 'audio',
      stop: () => {},
      getSettings: () => ({ deviceId: 'mock-mic-1' }),
    }
    const fakeStream = {
      getTracks: () => [videoTrack, audioTrack],
      getVideoTracks: () => [videoTrack],
      getAudioTracks: () => [audioTrack],
    }

    const deviceChangeListeners: Array<() => void> = []

    Object.defineProperty(navigator, 'mediaDevices', {
      writable: true,
      configurable: true,
      value: {
        getUserMedia: async () => fakeStream,
        enumerateDevices: async () => [
          { deviceId: 'mock-camera-1', kind: 'videoinput', label: 'Mock Camera', groupId: 'g1' },
          {
            deviceId: 'mock-mic-1',
            kind: 'audioinput',
            label: 'Mock Microphone',
            groupId: 'g2',
          },
        ],
        addEventListener: (type: string, cb: () => void) => {
          if (type === 'devicechange') deviceChangeListeners.push(cb)
        },
        removeEventListener: (type: string, cb: () => void) => {
          if (type !== 'devicechange') return
          const idx = deviceChangeListeners.indexOf(cb)
          if (idx !== -1) deviceChangeListeners.splice(idx, 1)
        },
      },
    })

    const fakeBuffer = new Uint8Array(128).fill(148)
    const fakeAnalyser = {
      fftSize: 256,
      frequencyBinCount: 128,
      getByteTimeDomainData: (buf: Uint8Array) => {
        for (let i = 0; i < buf.length; i++) buf[i] = fakeBuffer[i] ?? 148
      },
    }
    ;(window as Record<string, unknown>).AudioContext = class {
      createAnalyser() {
        return fakeAnalyser
      }
      createMediaStreamSource() {
        return { connect: () => {} }
      }
    }
  })
}
