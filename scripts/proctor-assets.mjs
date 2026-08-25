#!/usr/bin/env node
/**
 * proctor-assets.mjs — provision and VERIFY the MediaPipe binary assets.
 *
 * Run via: bun run proctor:assets
 *
 * These files are BUILD ARTIFACTS, not source. They are no longer tracked by
 * git at all (see .gitignore) and no longer by Git LFS. That is the whole point
 * of this rewrite: on 2026-08-25 production was found serving the raw LFS
 * POINTER TEXT in place of every `.wasm` and `.task`, because Railway's Docker
 * build does `COPY . .` from a checkout that never hydrates LFS. The browser
 * received `version https://git-lfs.github.com/spec/v1` where a WebAssembly
 * module should have been, face detection was dead for every interview, and
 * nothing said so.
 *
 * Two rules follow from that, and both matter more than they look:
 *
 * 1. PRESENCE IS NOT VALIDITY. The previous version skipped the model download
 *    when the destination file existed. In a Docker build the LFS pointer
 *    exists, so the check passed, the download was skipped, and the pointer
 *    survived. Merely adding this script to the Dockerfile would have fixed
 *    nothing while looking like a fix. Every asset is now verified by CONTENT.
 *
 * 2. A BUILD THAT PRODUCES A BROKEN ASSET MUST FAIL. This is the second
 *    incident of this class — the first is recorded below — and both times the
 *    runtime degraded silently and the build never looked. Silent degradation
 *    at runtime is correct (a candidate must not lose an interview over it);
 *    silent degradation at BUILD time is how it stays broken for weeks.
 *
 * The earlier incident, kept as the reason the WASM list is discovered rather
 * than curated: a hardcoded list named only the three `.wasm` binaries and
 * omitted their `.js` glue loaders, which is what the runtime requests first.
 * `/proctor/wasm/vision_wasm_internal.js` 404'd, the SPA fallback answered with
 * JSON, the browser refused to execute it, and face detection was dead for
 * every interview — silently, because useProctor degrades on failure by design.
 */

import { copyFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { existsSync, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { get } from 'node:https'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const WASM_SRC = join(ROOT, 'node_modules/@mediapipe/tasks-vision/wasm')
const WASM_DEST = join(ROOT, 'public/proctor/wasm')
const PROCTOR_DEST = join(ROOT, 'public/proctor')

/**
 * Models, PINNED and CHECKSUMMED.
 *
 * The URLs previously pointed at `.../float16/latest/...`. `latest` means two
 * builds months apart can ship different models with nothing recording that
 * they differ — a proctoring result would change under a deploy that touched no
 * proctoring code. Version `1` was verified on 2026-08-25 to be byte-identical
 * to what `latest` was then serving, so pinning changed nothing about WHICH
 * model ships; it only made the answer stable.
 *
 * `magic` is the file-format signature, checked before the hash so a wrong file
 * reports what it actually is instead of an opaque digest mismatch. A `.task`
 * bundle is a ZIP; a `.tflite` is a flatbuffer whose identifier sits at offset 4.
 */
const MODELS = [
  {
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
    magic: { offset: 2, hex: '504b0304', label: 'ZIP (.task bundle)' },
  },
  {
    // Referenced by useProctor.ts for phone detection and NEVER COMMITTED, so
    // `phone_detected` has never fired in any environment, ever.
    file: 'efficientdet_lite0.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite',
    sha256: '40338edf5ec70d43e318b0a716a84d4564cd1802759a7a07170c7e43796dbf58',
    magic: { offset: 4, hex: '54464c33', label: 'TFL3 (TensorFlow Lite)' },
  },
]

/** WebAssembly's magic number: `\0asm`. */
const WASM_MAGIC = { offset: 0, hex: '0061736d', label: 'WebAssembly' }

const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com'

/**
 * Every file MediaPipe's FilesetResolver may load, discovered from the package
 * rather than listed by hand. A future MediaPipe release that adds or renames a
 * file cannot leave a gap here; a curated list is a second place to remember.
 */
async function wasmFilesToCopy() {
  const entries = await readdir(WASM_SRC)

  return entries.filter((f) => f.endsWith('.wasm') || f.endsWith('.js'))
}

/**
 * Read a file and report WHY it is not the binary it claims to be.
 *
 * Returns null when the file is valid, or a human-readable reason when it is
 * not. An LFS pointer is named explicitly because it is the failure that
 * actually happened and the one a reader will meet again.
 */
async function inspect(path, magic, expectedSha256 = null) {
  if (!existsSync(path)) return 'missing'

  const buf = await readFile(path)

  if (buf.subarray(0, LFS_POINTER_PREFIX.length).toString('utf8') === LFS_POINTER_PREFIX) {
    return `a Git LFS pointer, not a binary (${buf.length} bytes of text). LFS was not hydrated.`
  }

  // Compared as hex STRINGS rather than byte arrays: the signature reads as the
  // thing it is, and there is no lint/formatter argument to have about the
  // casing of a numeric literal.
  const got = buf.subarray(magic.offset, magic.offset + magic.hex.length / 2).toString('hex')
  if (got !== magic.hex) {
    return `not ${magic.label}: expected magic ${magic.hex} at offset ${magic.offset}, found ${got}`
  }

  if (expectedSha256 !== null) {
    const actual = createHash('sha256').update(buf).digest('hex')
    if (actual !== expectedSha256) {
      return `checksum mismatch: expected ${expectedSha256}, got ${actual}`
    }
  }

  return null
}

async function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      pipeline(res, file).then(resolve).catch(reject)
    }).on('error', reject)
  })
}

async function main() {
  await mkdir(WASM_DEST, { recursive: true })

  // ── WASM runtime: copied from the lockfile-pinned package ─────────────────
  // Not downloaded and not vendored: `bun install --frozen-lockfile` has already
  // placed these, so the binaries are version-locked to the very MediaPipe
  // package the code imports. The two can no longer disagree.
  console.log('Copying MediaPipe WASM runtime from node_modules...')
  for (const file of await wasmFilesToCopy()) {
    const src = join(WASM_SRC, file)
    if (!existsSync(src)) {
      console.error(`  MISSING: ${src} — run 'bun install' first`)
      process.exit(1)
    }
    await copyFile(src, join(WASM_DEST, file))
  }
  console.log(`  Copied ${(await wasmFilesToCopy()).length} files.`)

  // ── Models: pinned, downloaded, checksummed ───────────────────────────────
  for (const model of MODELS) {
    const dest = join(PROCTOR_DEST, model.file)
    const problem = await inspect(dest, model.magic, model.sha256)

    if (problem === null) {
      console.log(`${model.file}: already valid — skipping download.`)
      continue
    }

    // PRESENCE IS NOT VALIDITY. An LFS pointer sitting at this path is exactly
    // what made the previous "already exists" check useless, so anything that
    // fails inspection is removed before the download rather than trusted.
    console.log(`${model.file}: ${problem}`)
    if (existsSync(dest)) await unlink(dest)

    console.log(`  Downloading ${model.url}`)
    try {
      await download(model.url, dest)
    } catch (err) {
      console.error(`  FAILED: ${err.message}`)
      process.exit(1)
    }

    const stillWrong = await inspect(dest, model.magic, model.sha256)
    if (stillWrong !== null) {
      console.error(`  REFUSING the downloaded file: ${stillWrong}`)
      process.exit(1)
    }
    console.log('  Downloaded and verified.')
  }

  // ── The gate: nothing leaves this script unverified ───────────────────────
  const failures = []

  for (const file of await readdir(WASM_DEST)) {
    if (!file.endsWith('.wasm')) continue
    const problem = await inspect(join(WASM_DEST, file), WASM_MAGIC)
    if (problem !== null) failures.push(`public/proctor/wasm/${file}: ${problem}`)
  }

  for (const model of MODELS) {
    const problem = await inspect(join(PROCTOR_DEST, model.file), model.magic, model.sha256)
    if (problem !== null) failures.push(`public/proctor/${model.file}: ${problem}`)
  }

  if (failures.length > 0) {
    console.error('\nproctor:assets FAILED — refusing to produce a build with dead proctoring:')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }

  console.log('\nproctor:assets complete — every asset verified.')
}

main().catch((err) => {
  console.error('proctor:assets failed:', err)
  process.exit(1)
})
