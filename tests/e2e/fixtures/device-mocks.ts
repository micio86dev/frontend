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

/**
 * Camera, microphone and audio analyser for the CALL SCREEN specs.
 *
 * `injectDeviceMocks` hands out a plain object as the stream, which is enough to
 * get past the device check but is not a `MediaStream`: the call screen's own tile
 * assigns the stream to a `<video>`'s `srcObject` and listens on it, and a real
 * browser refuses both for an object that is not one. So here the video side is a
 * REAL `MediaStream` (a canvas capture) and only the audio track is faked, and the
 * `AudioContext` is complete enough (`state`, `resume`, `close`, `disconnect`) for
 * the speaker-turn analyser to be built instead of silently skipped.
 *
 * The microphone level is a knob: `window.__fakeMicLevel` (RMS, 0-1) is what both
 * the device check and the speaker-turn analyser read. It starts above the device
 * check's threshold so the "Start the interview" gate opens; a spec lowers it with
 * `setFakeMicLevel` once it is live, and raises it again to play the candidate.
 * Avatar audio is not faked at all: the mock provider never attaches a remote
 * stream, so the interviewer's turn comes from the provider state alone.
 */
const DEFAULT_FAKE_MIC_LEVEL = 0.2

export async function injectCallMedia(page: Page): Promise<void> {
  await page.addInitScript((initialLevel: number) => {
    const win = window as unknown as Record<string, unknown>
    win['__fakeMicLevel'] = initialLevel

    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 360
    const context = canvas.getContext('2d')
    if (context) {
      context.fillStyle = '#334155'
      context.fillRect(0, 0, canvas.width, canvas.height)
    }
    const stream = canvas.captureStream(5)

    const audioTrack = {
      readyState: 'live',
      kind: 'audio',
      stop: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      getSettings: () => ({ deviceId: 'mock-mic-1' }),
    }
    stream.getAudioTracks = () => [audioTrack as unknown as MediaStreamTrack]
    stream.getTracks = () => [...stream.getVideoTracks(), audioTrack as unknown as MediaStreamTrack]

    Object.defineProperty(navigator, 'mediaDevices', {
      writable: true,
      configurable: true,
      value: {
        getUserMedia: async () => stream,
        enumerateDevices: async () => [
          { deviceId: 'mock-camera-1', kind: 'videoinput', label: 'Mock Camera', groupId: 'g1' },
          { deviceId: 'mock-mic-1', kind: 'audioinput', label: 'Mock Microphone', groupId: 'g2' },
        ],
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    })

    win['AudioContext'] = class {
      state = 'running'
      resume() {
        return Promise.resolve()
      }
      close() {
        return Promise.resolve()
      }
      createAnalyser() {
        // `frequencyBinCount` is a plain data property, not a getter reading `this`,
        // so destructuring it keeps working. The app DOES reassign `fftSize`
        // (useSpeakerTurn, useDeviceCheck, useProctor), so assigning it recomputes
        // the bin count, as a real AnalyserNode does.
        let fftSize = 256
        const analyser = {
          frequencyBinCount: fftSize / 2,
          getByteTimeDomainData(buffer: Uint8Array) {
            const level = Number(win['__fakeMicLevel'] ?? 0)
            buffer.fill(Math.min(255, Math.round(128 + level * 128)))
          },
          disconnect() {},
        }
        Object.defineProperty(analyser, 'fftSize', {
          enumerable: true,
          get: () => fftSize,
          set: (value: number) => {
            fftSize = value
            analyser.frequencyBinCount = value / 2
          },
        })
        return analyser as typeof analyser & { fftSize: number }
      }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} }
      }
    }
  }, DEFAULT_FAKE_MIC_LEVEL)
}

/** Sets the level the fake microphone reports from now on (RMS, 0-1). */
export async function setFakeMicLevel(page: Page, level: number): Promise<void> {
  await page.evaluate((value) => {
    ;(window as unknown as Record<string, unknown>)['__fakeMicLevel'] = value
  }, level)
}
