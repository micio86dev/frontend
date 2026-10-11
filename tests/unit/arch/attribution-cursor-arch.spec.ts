/**
 * attribution-cursor-arch.spec.ts
 *
 * Architecture guard for the attribution cursor (tavus-single-session-interview,
 * FE-03 / design D3, A2):
 *  1. ONE mutator: `advance()` has exactly one call site, in the composable's
 *     `advanceAttribution`; cursors are constructed only there.
 *  2. ONE minter: an `AdvanceTicket` is fabricated only inside the cursor module.
 *  3. `dbSessionId` is the PLAYER KEY only: no reader (`/end`, `/suspend`,
 *     `sessionId`, snapshot, integrity, timer reset, `ProctorOverlay`) may read
 *     it from a handle.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const APP_ROOT = join(__dirname, '../../../app')
const CURSOR_MODULE = 'utils/attribution-cursor.ts'
const COMPOSABLE = 'composables/useInterviewSession.ts'

function collect(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...collect(full))
    else if (/\.(?:ts|vue)$/.test(entry)) files.push(full)
  }
  return files
}

function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const SOURCES = collect(APP_ROOT).map((file) => ({
  file: relative(APP_ROOT, file),
  code: stripComments(readFileSync(file, 'utf-8')),
}))

/** Files (excluding `except`) whose code matches `pattern`. */
function offenders(pattern: RegExp, except: string[]): string[] {
  return SOURCES.filter((s) => !except.includes(s.file) && pattern.test(s.code)).map((s) => s.file)
}

describe('attribution cursor — single mutator, single minter', () => {
  it('advance() is called from exactly one place: the composable', () => {
    expect(offenders(/\.advance\(/, [COMPOSABLE, CURSOR_MODULE])).toEqual([])
    const calls = SOURCES.find((s) => s.file === COMPOSABLE)!.code.match(/\.advance\(/g) ?? []
    expect(calls).toHaveLength(1)
  })

  it('a cursor is constructed only where a handle is built', () => {
    expect(offenders(/new AttributionCursor\(/, [COMPOSABLE])).toEqual([])
  })

  it('a ticket is fabricated only inside the cursor module', () => {
    expect(offenders(/as\s+AdvanceTicket\b/, [CURSOR_MODULE])).toEqual([])
  })

  it('the Tavus boundary ticket is minted only by the composable (the mutator)', () => {
    expect(
      offenders(/\bcreateBoundaryTicket\(/, ['utils/advance-interaction.ts', COMPOSABLE])
    ).toEqual([])
  })

  it('nothing assigns the cursor value from outside the cursor module', () => {
    expect(offenders(/\.attribution\.current\s*=[^=]/, [])).toEqual([])
  })
})

describe('handle.dbSessionId is the player key only', () => {
  it('no component reads dbSessionId', () => {
    expect(
      offenders(/\bdbSessionId\b/, [
        COMPOSABLE,
        'types/interview-provider.ts',
        'providers/factory.ts',
      ])
    ).toEqual([])
  })

  it('the composable reads no handle.dbSessionId: keys and the painted match use playerKey', () => {
    const code = SOURCES.find((s) => s.file === COMPOSABLE)!.code
    const reads = [...code.matchAll(/\b(\w+)\.dbSessionId\b/g)].map((m) => m[0]).sort()
    expect(reads).toEqual([])
  })

  it('ProctorOverlay and the question-timer reset read the cursor-fed sessionId', () => {
    const code = SOURCES.find((s) => s.file === 'components/InterviewSession.vue')!.code
    expect([...code.matchAll(/:session-id="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'session.sessionId.value',
      'session.sessionId.value',
    ])
    expect(code).toContain('() => session.sessionId.value,')
  })
})
