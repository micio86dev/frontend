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
import { matchesEndPhrase } from '~/app/utils/proctor-config'

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
