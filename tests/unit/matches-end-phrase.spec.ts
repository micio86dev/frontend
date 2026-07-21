/**
 * Unit tests for matchesEndPhrase (app/utils/proctor-config.ts)
 *
 * Tests the accent/case/punctuation-insensitive containment check.
 * ~95% coverage target — all branches exercised.
 *
 * PRECONDITION (enforced by HeyGen provider, NOT this function):
 *   Both endPhrase and finalPhrase must be non-empty strings before calling.
 */

import { describe, it, expect } from 'vitest'
import {
  matchesEndPhrase,
  summarizeIntegrity,
  INTEGRITY_KINDS,
  FLUSH_INTERVAL_MS,
  SNAPSHOT_INTERVAL_MS,
  SAMPLE_FPS,
} from '~/app/utils/proctor-config'
import type { IntegrityEventInternal } from '~/app/utils/proctor-config'

const IT_END_PHRASE = 'Passiamo alla prossima domanda.'
const IT_FINAL_PHRASE = 'Grazie per il tuo tempo.'

const EN_END_PHRASE = 'Let us move on to the next question.'
const EN_FINAL_PHRASE = 'Thank you for your time.'

describe('matchesEndPhrase', () => {
  // ---- endPhrase matches ----

  it('returns true on exact endPhrase match (Italian)', () => {
    expect(
      matchesEndPhrase(IT_END_PHRASE, { endPhrase: IT_END_PHRASE, finalPhrase: IT_FINAL_PHRASE })
    ).toBe(true)
  })

  it('returns true on exact finalPhrase match (Italian)', () => {
    expect(
      matchesEndPhrase(IT_FINAL_PHRASE, { endPhrase: IT_END_PHRASE, finalPhrase: IT_FINAL_PHRASE })
    ).toBe(true)
  })

  it('returns true on case-insensitive endPhrase match', () => {
    expect(
      matchesEndPhrase('PASSIAMO ALLA PROSSIMA DOMANDA.', {
        endPhrase: IT_END_PHRASE,
        finalPhrase: IT_FINAL_PHRASE,
      })
    ).toBe(true)
  })

  it('returns true on case-insensitive finalPhrase match', () => {
    expect(
      matchesEndPhrase('GRAZIE PER IL TUO TEMPO.', {
        endPhrase: IT_END_PHRASE,
        finalPhrase: IT_FINAL_PHRASE,
      })
    ).toBe(true)
  })

  it('returns true on accent-insensitive match (NFD normalization)', () => {
    // "Pàssiamo àllà prossima domànda." — diacritics stripped
    expect(
      matchesEndPhrase('Passiamo alla prossima domanda.', {
        endPhrase: 'Pàssiamo àllà prōssimā dōmandā.',
        finalPhrase: IT_FINAL_PHRASE,
      })
    ).toBe(true)
  })

  it('returns true on punctuation-stripped match', () => {
    // Punctuation is stripped before comparison; the phrase core must match
    expect(
      matchesEndPhrase('Let us move on to the next question', {
        endPhrase: EN_END_PHRASE,
        finalPhrase: EN_FINAL_PHRASE,
      })
    ).toBe(true)
  })

  it('returns true on English endPhrase match', () => {
    expect(
      matchesEndPhrase(EN_END_PHRASE, { endPhrase: EN_END_PHRASE, finalPhrase: EN_FINAL_PHRASE })
    ).toBe(true)
  })

  it('returns true on English finalPhrase match', () => {
    expect(
      matchesEndPhrase(EN_FINAL_PHRASE, { endPhrase: EN_END_PHRASE, finalPhrase: EN_FINAL_PHRASE })
    ).toBe(true)
  })

  it('returns true when avatar transcript contains the phrase with trailing whitespace', () => {
    expect(
      matchesEndPhrase('  ' + IT_END_PHRASE + '   ', {
        endPhrase: IT_END_PHRASE,
        finalPhrase: IT_FINAL_PHRASE,
      })
    ).toBe(true)
  })

  it('returns true when avatar transcript contains the phrase mid-sentence', () => {
    // TTS variance: phrase may appear mid-transcript segment
    expect(
      matchesEndPhrase('Okay, ' + IT_END_PHRASE, {
        endPhrase: IT_END_PHRASE,
        finalPhrase: IT_FINAL_PHRASE,
      })
    ).toBe(true)
  })

  it('returns true for finalPhrase match with extra whitespace normalization', () => {
    expect(
      matchesEndPhrase('Grazie   per  il  tuo  tempo.', {
        endPhrase: IT_END_PHRASE,
        finalPhrase: IT_FINAL_PHRASE,
      })
    ).toBe(true)
  })

  // ---- non-matches ----

  it('returns false when text contains neither phrase', () => {
    expect(
      matchesEndPhrase('Buona fortuna con il colloquio.', {
        endPhrase: IT_END_PHRASE,
        finalPhrase: IT_FINAL_PHRASE,
      })
    ).toBe(false)
  })

  it('returns false when English phrase checked against Italian text', () => {
    // IT text does not contain the EN phrase
    expect(
      matchesEndPhrase(IT_END_PHRASE, { endPhrase: EN_END_PHRASE, finalPhrase: EN_FINAL_PHRASE })
    ).toBe(false)
  })

  it('returns false for empty text', () => {
    expect(matchesEndPhrase('', { endPhrase: IT_END_PHRASE, finalPhrase: IT_FINAL_PHRASE })).toBe(
      false
    )
  })

  it('returns false for unrelated transcript text', () => {
    expect(
      matchesEndPhrase('The quick brown fox jumps over the lazy dog.', {
        endPhrase: EN_END_PHRASE,
        finalPhrase: EN_FINAL_PHRASE,
      })
    ).toBe(false)
  })

  // ---- SSR safety ----

  it('does not reference browser globals at module scope (runs in node environment)', () => {
    // If this test runs without throwing, module scope is clean
    expect(matchesEndPhrase).toBeDefined()
    expect(typeof matchesEndPhrase).toBe('function')
  })
})

describe('proctor-config constants', () => {
  it('exports INTEGRITY_KINDS frozen array with 13 kinds', () => {
    expect(INTEGRITY_KINDS).toHaveLength(13)
    expect(Object.isFrozen(INTEGRITY_KINDS)).toBe(true)
    expect(INTEGRITY_KINDS).toContain('tab_hidden')
    expect(INTEGRITY_KINDS).toContain('face_absent')
    expect(INTEGRITY_KINDS).toContain('phone_detected')
  })

  it('exports FLUSH_INTERVAL_MS as 10000', () => {
    expect(FLUSH_INTERVAL_MS).toBe(10_000)
  })

  it('exports SNAPSHOT_INTERVAL_MS as 10000', () => {
    expect(SNAPSHOT_INTERVAL_MS).toBe(10_000)
  })

  it('exports SAMPLE_FPS as 3', () => {
    expect(SAMPLE_FPS).toBe(3)
  })
})

describe('summarizeIntegrity', () => {
  it('returns empty object for empty events array', () => {
    expect(summarizeIntegrity([])).toEqual({})
  })

  it('counts single event kind correctly', () => {
    const events: IntegrityEventInternal[] = [{ type: 'tab_hidden', ts: '2025-01-01T00:00:00Z' }]
    expect(summarizeIntegrity(events)).toEqual({ tab_hidden: 1 })
  })

  it('counts multiple events of the same kind', () => {
    const events: IntegrityEventInternal[] = [
      { type: 'focus_lost', ts: '2025-01-01T00:00:00Z' },
      { type: 'focus_lost', ts: '2025-01-01T00:00:01Z' },
      { type: 'focus_lost', ts: '2025-01-01T00:00:02Z' },
    ]
    expect(summarizeIntegrity(events)).toEqual({ focus_lost: 3 })
  })

  it('counts mixed event kinds correctly', () => {
    const events: IntegrityEventInternal[] = [
      { type: 'tab_hidden', ts: '2025-01-01T00:00:00Z' },
      { type: 'face_absent', ts: '2025-01-01T00:00:01Z' },
      { type: 'tab_hidden', ts: '2025-01-01T00:00:02Z' },
      { type: 'looking_away', ts: '2025-01-01T00:00:03Z' },
    ]
    expect(summarizeIntegrity(events)).toEqual({
      tab_hidden: 2,
      face_absent: 1,
      looking_away: 1,
    })
  })
})
