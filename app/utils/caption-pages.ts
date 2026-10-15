/**
 * Caption paging for the interviewer's overlay.
 *
 * An avatar utterance arrives whole, once, when the avatar starts saying it. The overlay
 * holds three lines, so a long one (the intro phrase can reach 3600 characters) would only
 * ever show its beginning. It is split into pages of whole sentences, each shown for the
 * time it takes to say it.
 */

/** Roughly three `text-xl` lines in the narrowest overlay; overflow still scrolls. */
export const CAPTION_PAGE_MAX_CHARS = 140

/** Spoken pace: 3600 characters take about four minutes (backoffice intro limit). */
export const CAPTION_CHARS_PER_SECOND = 15

const MIN_PAGE_MS = 1_500

/** Splits `text` into pages of whole sentences; a sentence longer than a page is split by words. */
export function captionPages(text: string): string[] {
  // A sentence ends at punctuation followed by whitespace, so "3.5 years" stays whole.
  // No regex lookbehind: Safari before 16.4 fails to parse it, taking the module down.
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([.!?…]) /g, '$1\n')
    .split('\n')
  const pages: string[] = []
  let page = ''

  const push = (piece: string) => {
    const joined = page ? `${page} ${piece}` : piece
    if (joined.length <= CAPTION_PAGE_MAX_CHARS) {
      page = joined
      return
    }
    if (page) pages.push(page)
    page = piece
  }

  for (const raw of sentences) {
    const sentence = raw.trim()
    if (!sentence) continue
    if (sentence.length <= CAPTION_PAGE_MAX_CHARS) {
      push(sentence)
      continue
    }
    for (const word of sentence.split(/\s+/)) push(word)
  }
  if (page) pages.push(page)

  return pages
}

/** How long a page stays on screen. */
export function captionPageMs(page: string): number {
  return Math.max(MIN_PAGE_MS, Math.round((page.length / CAPTION_CHARS_PER_SECOND) * 1000))
}
