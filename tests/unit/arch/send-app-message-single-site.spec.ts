/**
 * The boundary steering has ONE outbound choke point (design D6): `sendAppMessage`
 * may appear in at most one file and at one call site under `app/`. FE-02 adds
 * that site (`TavusProvider.sendBoundary`); until then there are none, so the
 * bound is "at most one" and FE-02 tightens it to exactly one.
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
  it('sendAppMessage is called from at most one file and one call site', () => {
    const sites = files.flatMap(({ f, text }) =>
      [...text.matchAll(/\.sendAppMessage\s*\(/g)].map(() => f)
    )
    expect(sites.length).toBeLessThanOrEqual(1)
    expect(new Set(sites).size).toBeLessThanOrEqual(1)
  })

  it('overwrite_llm_context appears nowhere in app/', () => {
    expect(
      files.filter(({ text }) => text.includes('overwrite_llm_context')).map((x) => x.f)
    ).toEqual([])
  })
})
