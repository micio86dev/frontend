#!/usr/bin/env node
/**
 * proctor-assets.mjs — Fetch and copy MediaPipe binary assets to public/proctor/
 *
 * Run via: bun run proctor:assets
 *
 * Copies WASM runtime files from node_modules/@mediapipe/tasks-vision/wasm/
 * and downloads the face_landmarker.task model from storage.googleapis.com.
 *
 * These files are tracked by Git LFS (.gitattributes) — run this script when
 * setting up a new dev environment or updating the MediaPipe version.
 */

import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { get } from 'node:https'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const WASM_SRC = join(ROOT, 'node_modules/@mediapipe/tasks-vision/wasm')
const WASM_DEST = join(ROOT, 'public/proctor/wasm')
const PROCTOR_DEST = join(ROOT, 'public/proctor')

const FACE_LANDMARKER_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task'
const FACE_LANDMARKER_DEST = join(PROCTOR_DEST, 'face_landmarker.task')

const WASM_FILES = [
  'vision_wasm_internal.wasm',
  'vision_wasm_module_internal.wasm',
  'vision_wasm_nosimd_internal.wasm',
]

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
  // Ensure destination directories exist
  await mkdir(WASM_DEST, { recursive: true })

  // Copy WASM runtime files
  console.log('Copying MediaPipe WASM runtime files...')
  for (const file of WASM_FILES) {
    const src = join(WASM_SRC, file)
    const dest = join(WASM_DEST, file)
    if (!existsSync(src)) {
      console.error(`  MISSING: ${src} — run 'bun install' first`)
      process.exit(1)
    }
    await copyFile(src, dest)
    console.log(`  Copied: public/proctor/wasm/${file}`)
  }

  // Download face_landmarker.task model
  if (existsSync(FACE_LANDMARKER_DEST)) {
    console.log('face_landmarker.task already exists — skipping download.')
  } else {
    console.log('Downloading face_landmarker.task...')
    try {
      await download(FACE_LANDMARKER_URL, FACE_LANDMARKER_DEST)
      console.log('  Downloaded: public/proctor/face_landmarker.task')
    } catch (err) {
      console.error(`  FAILED: ${err.message}`)
      console.error(
        '  Please download manually from:',
        FACE_LANDMARKER_URL,
        '\n  and place it at public/proctor/face_landmarker.task'
      )
      process.exit(1)
    }
  }

  console.log('\nproctor:assets complete.')
}

main().catch((err) => {
  console.error('proctor:assets failed:', err)
  process.exit(1)
})
