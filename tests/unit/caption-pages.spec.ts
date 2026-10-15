/**
 * captionPages — splits a long avatar utterance into caption pages that fit the
 * three-line overlay, and times each page to the speech.
 *
 * A long intro phrase (up to 3600 characters) arrives as ONE utterance; shown whole,
 * the overlay only ever displayed its first three lines.
 */
import { describe, it, expect } from 'vitest'
import {
  captionPages,
  captionPageMs,
  CAPTION_PAGE_MAX_CHARS,
  CAPTION_CHARS_PER_SECOND,
} from '~/app/utils/caption-pages'

describe('captionPages', () => {
  it('keeps a short utterance as one page', () => {
    expect(captionPages('Tell me about a time you led a change.')).toEqual([
      'Tell me about a time you led a change.',
    ])
  })

  it('returns no page for empty or blank text', () => {
    expect(captionPages('')).toEqual([])
    expect(captionPages('   ')).toEqual([])
  })

  it('groups whole sentences into pages no longer than the limit', () => {
    const sentence = 'This sentence is about sixty characters long, more or less. '
    const pages = captionPages(sentence.repeat(10))

    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(CAPTION_PAGE_MAX_CHARS)
      expect(page.endsWith('.')).toBe(true)
    }
  })

  it('splits a sentence longer than a page at word boundaries', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    const pages = captionPages(words)

    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(CAPTION_PAGE_MAX_CHARS)
    expect(pages.join(' ')).toBe(words)
  })

  it('loses no word of the original text', () => {
    const text =
      'Benvenuto! Oggi parleremo della tua esperienza. ' +
      'Ti farò alcune domande su situazioni reali che hai vissuto, e ti chiederò di raccontarmi cosa hai fatto, ' +
      'perché lo hai fatto e quale è stato il risultato. Non ci sono risposte giuste o sbagliate? Prenditi il tempo che ti serve.'

    expect(captionPages(text).join(' ').split(/\s+/)).toEqual(text.split(/\s+/))
  })
})

describe('captionPageMs', () => {
  it('times a page at the speech rate', () => {
    const page = 'x'.repeat(CAPTION_CHARS_PER_SECOND * 10)

    expect(captionPageMs(page)).toBe(10_000)
  })

  it('never shows a page for less than the floor', () => {
    expect(captionPageMs('Hi.')).toBe(1_500)
  })
})
