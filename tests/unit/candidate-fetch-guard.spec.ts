/**
 * candidate-fetch-guard — source scan (Task 1.5 RED / candidate-session-auth D-B)
 *
 * Precedent: `tests/unit/token-parity.spec.ts` reads source with `readFileSync`
 * and asserts against the raw text instead of executing it.
 *
 * `candidateFetch` (and its sibling `flushIntegrityKeepalive`) in
 * `app/utils/candidate-api.ts` are the ONLY sanctioned way to reach a
 * `/candidate/` endpoint. This guard fails the build if either invariant is
 * broken:
 *
 *  1. No file other than `candidate-api.ts` calls `apiUrl()` with a
 *     `/candidate` path directly — that would build the URL outside the
 *     wrapper, bypassing the auth header and the 401 handling.
 *  2. No file other than `candidate-api.ts` issues a raw `fetch()`,
 *     `$fetch()`, `useFetch()`, `useLazyFetch()`, or `navigator.sendBeacon()`
 *     call that also references a `/candidate/` endpoint — that is exactly
 *     how `useProctor.ts:518`'s raw `fetch()` escaped the wrapper before
 *     this change. (Verification warning: the original version of this
 *     guard's negative lookbehind excluded `$fetch(` — and therefore
 *     `useFetch(`/`useLazyFetch(` too, both prefixed with a word character —
 *     alongside the intentional `candidateFetch(` exclusion. Widened below.)
 *
 * Documented ceiling — what this guard does NOT catch:
 *  - A raw fetch/`$fetch`/`useFetch` call built from a DYNAMIC or
 *    string-concatenated path (`apiUrl('/candid' + 'ate/...')`,
 *    a template literal spanning a variable) — the guard is a textual scan,
 *    not a type-aware AST analysis, and only matches literal `/candidate/`
 *    substrings.
 *  - A call routed through a THIRD wrapper this guard does not know about
 *    (e.g. a future `app/utils/legacy-fetch.ts` re-exporting `fetch`).
 *  - Non-network reads of a candidate JWT that bypass `useCandidateSession`
 *    entirely (e.g. reading `localStorage.getItem('beai_candidate_session')`
 *    directly) — a different invariant, not this guard's job.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const APP_DIR = resolve(__dirname, '../../app')
const CANDIDATE_API_FILE = resolve(APP_DIR, 'utils/candidate-api.ts')
// api-url.ts is the generic URL builder the wrapper is built on (unchanged by
// this design) — its own JSDoc documents an `apiUrl('/candidate/...')` usage
// example, which is text, not a call site, and would otherwise false-positive.
const EXEMPT_FILES = new Set([CANDIDATE_API_FILE, resolve(APP_DIR, 'utils/api-url.ts')])

/**
 * Strip `//` line comments and `/* *\/` block comments before scanning, so a
 * docblock that documents `fetch(...)` or `apiUrl('/candidate/...')` as
 * prose (as this very guard's own source does) does not false-positive as a
 * call site.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

/**
 * True if `source` contains a raw network-call site that could reach a
 * `/candidate/` URL outside `candidateFetch`/`flushIntegrityKeepalive`:
 * global `fetch(`, ofetch's `$fetch(`, or Nuxt's `useFetch(`/`useLazyFetch(`
 * — all four, including generic-typed call syntax (`$fetch<T>(...)`).
 * Deliberately does NOT match `candidateFetch(` (word-prefixed `Fetch`,
 * capital F, never matches the lowercase-`fetch` patterns below) or
 * `flushIntegrityKeepalive(` (no `fetch` substring at all).
 */
function hasRawFetchCallSite(source: string): boolean {
  const rawGlobalFetch = /(?<![$.\w])fetch\(/.test(source)
  const dollarFetch = /\$fetch(?:<[^>]*>)?\(/.test(source)
  const useFetch = /\buseFetch(?:<[^>]*>)?\(/.test(source)
  const useLazyFetch = /\buseLazyFetch(?:<[^>]*>)?\(/.test(source)
  return rawGlobalFetch || dollarFetch || useFetch || useLazyFetch
}

describe('hasRawFetchCallSite() — pattern-matching unit coverage (Verification warning fix)', () => {
  it('matches global fetch(', () => {
    expect(hasRawFetchCallSite("fetch('/x')")).toBe(true)
  })

  it('matches $fetch( — the gap the original guard missed', () => {
    expect(hasRawFetchCallSite("$fetch('/x')")).toBe(true)
  })

  it('matches generic-typed $fetch<T>( — e.g. $fetch<{ access_token: string }>(...)', () => {
    expect(hasRawFetchCallSite("$fetch<{ access_token: string }>('/x')")).toBe(true)
  })

  it('matches useFetch( — the gap the original guard missed', () => {
    expect(hasRawFetchCallSite("useFetch('/x')")).toBe(true)
  })

  it('matches useLazyFetch( — the gap the original guard missed', () => {
    expect(hasRawFetchCallSite("useLazyFetch('/x')")).toBe(true)
  })

  it('does NOT match candidateFetch( — the sanctioned wrapper', () => {
    expect(hasRawFetchCallSite("candidateFetch('/x')")).toBe(false)
  })

  it('does NOT match flushIntegrityKeepalive( — the sanctioned keepalive transport', () => {
    expect(hasRawFetchCallSite('flushIntegrityKeepalive(payload)')).toBe(false)
  })
})

function walk(dir: string): string[] {
  let files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      files = files.concat(walk(full))
    } else if (/\.(?:ts|vue)$/.test(entry)) {
      files.push(full)
    }
  }
  return files
}

describe('candidate-fetch-guard — no /candidate/ request outside candidate-api.ts (D-B)', () => {
  const files = walk(APP_DIR).filter((f) => !EXEMPT_FILES.has(f))

  it('no file calls apiUrl() with a /candidate path directly', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf-8'))
      if (/apiUrl\(\s*['"`]\/candidate/.test(source)) {
        offenders.push(file.replace(APP_DIR, 'app'))
      }
    }
    expect(offenders).toEqual([])
  })

  it('no file issues a raw fetch()/$fetch()/useFetch()/useLazyFetch()/sendBeacon() call referencing a /candidate/ endpoint', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf-8'))
      const hasSendBeacon = /navigator\.sendBeacon\(/.test(source)
      const referencesCandidate = /\/candidate\//.test(source)
      if ((hasRawFetchCallSite(source) || hasSendBeacon) && referencesCandidate) {
        offenders.push(file.replace(APP_DIR, 'app'))
      }
    }
    expect(offenders).toEqual([])
  })
})
