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
import { readdirSync, existsSync, readFileSync } from 'node:fs'
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

/**
 * PRESENCE IS NOT VALIDITY.
 *
 * Every assertion above is satisfied by a Git LFS pointer — 130-odd bytes of
 * ASCII beginning `version https://git-lfs.github.com`. That is precisely what
 * production served on 2026-08-25: the files were all there, all the existence
 * checks passed, and the browser got text where a WebAssembly module belonged.
 *
 * These assert what the bytes ARE, not that a path resolves.
 */
describe('published proctoring assets are real binaries', () => {
  const LFS_POINTER = 'version https://git-lfs.github.com'

  // Hex string, not a byte array: the signature reads as the thing it is, and
  // a failure message shows the magic a reader can look up.
  const magicAt = (path: string, offset: number, length: number): string =>
    readFileSync(path)
      .subarray(offset, offset + length)
      .toString('hex')

  const isLfsPointer = (path: string): boolean =>
    readFileSync(path).subarray(0, LFS_POINTER.length).toString('utf8') === LFS_POINTER

  it('no published asset is a Git LFS pointer', () => {
    const proctor = resolve(PUBLIC_WASM, '..')
    const assets = [
      ...readdirSync(PUBLIC_WASM).map((f) => resolve(PUBLIC_WASM, f)),
      ...readdirSync(proctor)
        .filter((f) => f.endsWith('.task') || f.endsWith('.tflite'))
        .map((f) => resolve(proctor, f)),
    ]

    expect(assets.length).toBeGreaterThan(0)
    for (const path of assets) {
      expect(isLfsPointer(path), `${path} is an LFS pointer, not a binary`).toBe(false)
    }
  })

  it('every .wasm starts with the WebAssembly magic number', () => {
    // \0asm. This is the exact check the browser makes, and the exact one that
    // failed: "expected magic word 00 61 73 6d, found 76 65 72 73" — 'vers'.
    const binaries = readdirSync(PUBLIC_WASM).filter((f) => f.endsWith('.wasm'))

    expect(binaries.length).toBeGreaterThan(0)
    for (const file of binaries) {
      expect(magicAt(resolve(PUBLIC_WASM, file), 0, 4)).toBe('0061736d')
    }
  })

  it('face_landmarker.task is a ZIP bundle', () => {
    // A .task is a zip of model + metadata; PK\x03\x04 sits at offset 2.
    const path = resolve(PUBLIC_WASM, '..', 'face_landmarker.task')

    expect(magicAt(path, 2, 4)).toBe('504b0304')
  })

  it('efficientdet_lite0.tflite is published and is a TFLite flatbuffer', () => {
    // Referenced by useProctor for phone detection and NEVER COMMITTED, so
    // phone_detected had never fired in any environment.
    const path = resolve(PUBLIC_WASM, '..', 'efficientdet_lite0.tflite')

    expect(existsSync(path)).toBe(true)
    expect(magicAt(path, 4, 4)).toBe('54464c33') // 'TFL3'
  })
})
