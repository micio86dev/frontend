/**
 * Every `~/` import in app/ must resolve to a real file under the Nuxt 4 srcDir.
 *
 * `~` is `app/` (srcDir). The repo also keeps a `~/app/x` shim (nuxt.config alias plus a
 * Vite regex) that maps to the same `app/x`, so both spellings reach one file. This guard
 * resolves them the way the build does, so a typo or a spelling that only works under the
 * test runner cannot slip in. Component imports use `~/components/...`; composables and
 * utils may keep the shimmed `~/app/...` form.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = resolve(__dirname, '../../..')
const APP = join(ROOT, 'app')
const EXTENSIONS = ['', '.ts', '.vue', '.js', '/index.ts', '/index.vue']

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(?:vue|ts)$/.test(entry.name) ? [path] : []
  })
}

function resolveImport(spec: string): string | null {
  const rel = spec.replace(/^~\/app\//, '').replace(/^~\//, '')
  const base = join(APP, rel)
  const hit = EXTENSIONS.map((ext) => base + ext).find((p) => existsSync(p) && !p.endsWith('/'))
  return hit ?? null
}

describe('~/ import aliases resolve against app/', () => {
  const files = sources(APP)
  const specs = files.flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/from '(~\/[^']+)'/g)].map((m) => ({
      file: file.replace(`${ROOT}/`, ''),
      spec: m[1] as string,
    }))
  )

  it('scans a real set of imports', () => {
    expect(files.length).toBeGreaterThan(50)
    expect(specs.length).toBeGreaterThan(100)
  })

  it('resolves every ~/ and ~/app/ import to an existing file', () => {
    const broken = specs.filter(({ spec }) => resolveImport(spec) === null)

    expect(broken).toEqual([])
  })

  it('finds the guard can fail: an unknown path does not resolve', () => {
    expect(resolveImport('~/components/organisms/NoSuchThing.vue')).toBeNull()
    expect(resolveImport('~/app/composables/useInterviewClock')).toMatch(
      /app\/composables\/useInterviewClock\.ts$/
    )
  })

  it('keeps the call components on the ~/components spelling', () => {
    const offenders = specs.filter(
      ({ file, spec }) =>
        /app\/components\/(?:molecules|organisms)\/Call/.test(file) &&
        /^~\/app\/components\//.test(spec)
    )

    expect(offenders).toEqual([])
  })
})
