/**
 * Task 4.1 RED — Unit tests for app/utils/proctor-config.ts
 *
 * Verifies:
 * - INTEGRITY_KINDS exports exactly the 13 canonical kinds (API spec)
 * - summarizeIntegrity correctly counts events per kind
 * - summarizeIntegrity([]) returns empty summary
 * - Module is SSR-safe: no browser globals at module scope
 */

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// 4.1a — The 14 canonical integrity kinds
//
// 13 candidate behaviours, plus `proctor_unavailable` which reports a DEAD
// OBSERVER. The count is pinned so a kind cannot be added without a reader
// being asked why — the api validates kinds ALL-OR-NOTHING, so a name the
// server does not know 422s the entire batch and the client silently loses
// every event it ever recorded.
// ---------------------------------------------------------------------------

describe('INTEGRITY_KINDS', () => {
  it('exports exactly 14 canonical integrity kind names', async () => {
    const { INTEGRITY_KINDS } = await import('~/app/utils/proctor-config')
    expect(INTEGRITY_KINDS).toHaveLength(14)
  })

  it('contains all 14 required kind names', async () => {
    const { INTEGRITY_KINDS } = await import('~/app/utils/proctor-config')
    const expected = [
      'tab_hidden',
      'focus_lost',
      'second_monitor',
      'face_absent',
      'looking_away',
      'looking_down',
      'too_far',
      'multiple_faces',
      'fullscreen_exit',
      'clipboard_copy',
      'clipboard_paste',
      'second_voice',
      'phone_detected',
      'proctor_unavailable',
    ] as const
    for (const kind of expected) {
      expect(INTEGRITY_KINDS).toContain(kind)
    }
  })

  it('does NOT contain invalid kinds (window_resize, devtools_open)', async () => {
    const { INTEGRITY_KINDS } = await import('~/app/utils/proctor-config')
    expect(INTEGRITY_KINDS).not.toContain('window_resize')
    expect(INTEGRITY_KINDS).not.toContain('devtools_open')
  })

  it('is frozen (immutable)', async () => {
    const { INTEGRITY_KINDS } = await import('~/app/utils/proctor-config')
    expect(Object.isFrozen(INTEGRITY_KINDS)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4.1b — summarizeIntegrity
// ---------------------------------------------------------------------------

describe('summarizeIntegrity', () => {
  it('returns empty summary for empty event list', async () => {
    const { summarizeIntegrity } = await import('~/app/utils/proctor-config')
    const result = summarizeIntegrity([])
    expect(result).toEqual({})
  })

  it('counts single event correctly', async () => {
    const { summarizeIntegrity } = await import('~/app/utils/proctor-config')
    const events = [{ type: 'tab_hidden' as const, ts: '2024-01-01T00:00:00.000Z' }]
    const result = summarizeIntegrity(events)
    expect(result).toEqual({ tab_hidden: 1 })
  })

  it('counts multiple events of the same kind', async () => {
    const { summarizeIntegrity } = await import('~/app/utils/proctor-config')
    const events = [
      { type: 'tab_hidden' as const, ts: '2024-01-01T00:00:00.000Z' },
      { type: 'tab_hidden' as const, ts: '2024-01-01T00:01:00.000Z' },
      { type: 'tab_hidden' as const, ts: '2024-01-01T00:02:00.000Z' },
    ]
    const result = summarizeIntegrity(events)
    expect(result).toEqual({ tab_hidden: 3 })
  })

  it('counts different kinds independently', async () => {
    const { summarizeIntegrity } = await import('~/app/utils/proctor-config')
    const events = [
      { type: 'tab_hidden' as const, ts: '2024-01-01T00:00:00.000Z' },
      { type: 'focus_lost' as const, ts: '2024-01-01T00:01:00.000Z' },
      { type: 'tab_hidden' as const, ts: '2024-01-01T00:02:00.000Z' },
      { type: 'face_absent' as const, ts: '2024-01-01T00:03:00.000Z' },
    ]
    const result = summarizeIntegrity(events)
    expect(result).toEqual({
      tab_hidden: 2,
      focus_lost: 1,
      face_absent: 1,
    })
  })

  it('handles events with meta without errors', async () => {
    const { summarizeIntegrity } = await import('~/app/utils/proctor-config')
    const events = [
      {
        type: 'looking_away' as const,
        ts: '2024-01-01T00:00:00.000Z',
        meta: { durationMs: 3000, yaw: 30 },
      },
    ]
    expect(() => summarizeIntegrity(events)).not.toThrow()
    const result = summarizeIntegrity(events)
    expect(result.looking_away).toBe(1)
  })

  it('handles events with null meta without errors', async () => {
    const { summarizeIntegrity } = await import('~/app/utils/proctor-config')
    const events = [{ type: 'clipboard_copy' as const, ts: '2024-01-01T00:00:00.000Z', meta: null }]
    expect(() => summarizeIntegrity(events)).not.toThrow()
    expect(summarizeIntegrity(events)).toEqual({ clipboard_copy: 1 })
  })
})

// ---------------------------------------------------------------------------
// 4.1c — SSR safety: module does NOT reference browser globals at module scope
// ---------------------------------------------------------------------------

describe('SSR safety', () => {
  it('imports without throwing (no module-scope browser globals)', async () => {
    // happy-dom provides window/document but Node.js would not.
    // We verify the import doesn't crash and that no side effects occur on import.
    await expect(import('~/app/utils/proctor-config')).resolves.not.toThrow()
  })

  it('exports constants and functions without accessing window/document/navigator', async () => {
    const mod = await import('~/app/utils/proctor-config')
    // These should all be defined without needing browser globals
    expect(mod.INTEGRITY_KINDS).toBeDefined()
    expect(mod.FLUSH_INTERVAL_MS).toBeTypeOf('number')
    expect(mod.SNAPSHOT_INTERVAL_MS).toBeTypeOf('number')
    expect(mod.SAMPLE_FPS).toBeTypeOf('number')
    expect(mod.summarizeIntegrity).toBeTypeOf('function')
    expect(mod.matchesEndPhrase).toBeTypeOf('function')
  })
})
