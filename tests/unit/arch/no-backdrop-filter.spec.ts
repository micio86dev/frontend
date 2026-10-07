/**
 * no-backdrop-filter.spec.ts
 *
 * Architecture guard: no component in this app may use a backdrop filter
 * (`backdrop-blur-*`, `backdrop-filter`, `-webkit-backdrop-filter`).
 *
 * The vendored shadcn-vue overlays (Sheet, Dialog, AlertDialog) shipped with
 * `supports-backdrop-filter:backdrop-blur-xs`: a 4px blur of everything behind
 * the scrim. The same vendored overlay exists in the candidate app. Where the browser composites on the GPU that is cheap. Where it
 * renders in software it is not: measured in WebKit inside the pinned CI image
 * (`mcr.microsoft.com/playwright:v1.61.1-jammy`, 2 CPUs), opening the project
 * drawer dropped `requestAnimationFrame` from ~85 frames in 2 s to 1 frame in
 * 3.4 s, and removing only the backdrop filter restored ~84. At one frame every
 * few seconds the whole drawer is unusable, and Playwright's "stable" check
 * (two consecutive frames with the same box) never succeeds: 33 of 40 runs of
 * the backoffice project-create E2E failed with the blur, 0 of 40 without it.
 *
 * Software rendering is not only a CI condition: virtual desktops, remote
 * sessions and machines with GPU acceleration disabled take the same path, and
 * an admin on one of them would see the same frozen drawer. DESIGN.md never
 * asked for the blur; the scrim colour alone separates the layers.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const APP_ROOT = join(__dirname, '../../../app')

/** Recursively collects every `.vue`, `.ts` and `.css` file under `dir`. */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = []

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)

    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full))
    } else if (/\.(?:vue|ts|css)$/.test(entry)) {
      files.push(full)
    }
  }

  return files
}

/**
 * Strips `<!-- ... -->` and block comments, so a comment that explains why the
 * filter is gone does not trip the guard. `//` is left alone because it appears
 * inside ordinary attribute values (any `https://` URL).
 */
function stripCommentBlocks(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const BACKDROP_FILTER =
  /backdrop-(?:blur|brightness|contrast|grayscale|hue-rotate|invert|opacity|saturate|sepia|filter)\b/

describe('no backdrop filter (software-rendered frame rate)', () => {
  it('no app source uses a backdrop filter', () => {
    const offenders = collectSourceFiles(APP_ROOT)
      .filter((file) => BACKDROP_FILTER.test(stripCommentBlocks(readFileSync(file, 'utf8'))))
      .map((file) => relative(APP_ROOT, file))

    expect(offenders).toEqual([])
  })
})
