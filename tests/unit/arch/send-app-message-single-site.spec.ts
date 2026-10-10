/**
 * The boundary steering has ONE outbound choke point (design D6): `sendAppMessage`
 * appears in exactly one file and at one call site under `app/`:
 * `TavusProvider.sendBoundary`.
 * `overwrite_llm_context` is the discarded steering mode and appears nowhere.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const APP = resolve(__dirname, '../../../app')

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : /\.(?:ts|vue|js)$/.test(e.name)
        ? [join(dir, e.name)]
        : []
  )

const files = sources(APP).map((f) => ({ f, text: readFileSync(f, 'utf-8') }))

describe('boundary choke point', () => {
  it('sendAppMessage is called from exactly one file and one call site', () => {
    const sites = files.flatMap(({ f, text }) =>
      [...text.matchAll(/\.sendAppMessage\s*\(/g)].map(() => f)
    )
    expect(sites.length).toBe(1)
    expect(new Set(sites).size).toBe(1)
  })

  it('overwrite_llm_context appears nowhere in app/', () => {
    expect(
      files.filter(({ text }) => text.includes('overwrite_llm_context')).map((x) => x.f)
    ).toEqual([])
  })
})
