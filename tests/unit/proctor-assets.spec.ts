/**
 * The proctoring assets that must be SERVED, not merely present in the package.
 *
 * MediaPipe's FilesetResolver requests the `.js` glue loader first and the
 * `.wasm` binary through it. `scripts/proctor-assets.mjs` copied only the
 * `.wasm` files, so in production `/proctor/wasm/vision_wasm_internal.js`
 * 404'd, the SPA fallback answered with JSON, the browser refused to execute a
 * script with that MIME type, and face detection was dead for every interview.
 *
 * It failed SILENTLY: `useProctor` degrades on loader failure by design, so the
 * interview ran fine and simply collected no integrity signal. Nothing in any
 * suite noticed, because nothing asserted the files were there.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const PACKAGE_WASM = resolve(__dirname, '../../node_modules/@mediapipe/tasks-vision/wasm')
const PUBLIC_WASM = resolve(__dirname, '../../public/proctor/wasm')

describe('proctoring assets are served, not just installed', () => {
  it('every .js loader in the MediaPipe package is published', () => {
    const loaders = readdirSync(PACKAGE_WASM).filter((f) => f.endsWith('.js'))

    expect(loaders.length).toBeGreaterThan(0)
    for (const file of loaders) {
      expect(existsSync(resolve(PUBLIC_WASM, file))).toBe(true)
    }
  })

  it('every .wasm binary in the MediaPipe package is published', () => {
    const binaries = readdirSync(PACKAGE_WASM).filter((f) => f.endsWith('.wasm'))

    expect(binaries.length).toBeGreaterThan(0)
    for (const file of binaries) {
      expect(existsSync(resolve(PUBLIC_WASM, file))).toBe(true)
    }
  })

  it('each published .wasm has its .js sibling', () => {
    // The pairing is the invariant. A .wasm without its loader is unreachable,
    // and that is exactly the shape the production defect took.
    const published = readdirSync(PUBLIC_WASM)

    for (const wasm of published.filter((f) => f.endsWith('.wasm'))) {
      expect(published).toContain(wasm.replace(/\.wasm$/, '.js'))
    }
  })

  it('the face landmarker model is published', () => {
    expect(existsSync(resolve(PUBLIC_WASM, '..', 'face_landmarker.task'))).toBe(true)
  })
})
