/**
 * Every candidate page outside the live interview renders on the brand canvas
 * (DESIGN.md §3.1 "Background", §7.0.1).
 *
 * A source guard, on purpose: the per-page specs mount each page in the state
 * they care about, and none of them would notice a page quietly going back to
 * its own `min-h-screen bg-background` white page, which is exactly the
 * regression this change exists to remove. The canvas owns the page height and
 * the background, and `text-primary` is invisible on it (§3.1 rule 1).
 *
 * The page list below is deliberately wider than any one reviewed slice: this
 * guard covers EVERY candidate page, so a change to one page's markup can fail
 * here even when the page was not part of that slice. That coupling is the point.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PAGES = [
  'app/pages/index.vue',
  'app/pages/unsupported.vue',
  'app/pages/i/[token].vue',
  'app/pages/interview/[token].vue',
  'app/pages/interview/reusable.vue',
  'app/pages/interview/done.vue',
  'app/pages/interview/error.vue',
  'app/pages/interview/terminal.vue',
  'app/pages/embed/[token].vue',
] as const

function template(path: string): string {
  const source = readFileSync(resolve(__dirname, '../..', path), 'utf-8')

  // Comments may NAME a forbidden class to explain why it is absent.
  return source
    .slice(source.indexOf('<template>'), source.lastIndexOf('</template>'))
    .replace(/<!--[\s\S]*?-->/g, '')
}

describe.each(PAGES)('%s renders on the brand canvas', (path) => {
  const markup = template(path)

  it('goes through BrandCanvas, NoticeShell or CanvasLoading', () => {
    expect(markup).toMatch(/<(BrandCanvas|NoticeShell|CanvasLoading)\b/)
  })

  it('paints no white page of its own', () => {
    expect(markup).not.toMatch(/\bbg-background\b/)
    expect(markup).not.toMatch(/\bmin-h-screen\b/)
  })

  it('uses no canvas-coloured text', () => {
    // `text-primary` is the canvas colour itself; on a surface the brand as
    // text is `text-primary-ink`, which is held at 4.5:1 on white.
    expect(markup).not.toMatch(/\btext-primary(?![-\w])/)
    expect(markup).not.toMatch(/\bbg-primary\/10\b/)
  })
})

/**
 * The interview chrome (DESIGN.md §7.0.1, §7.2). These render on the canvas or
 * on a white surface inside it, never on a white page, so the canvas colour as
 * text (`text-primary`) and as a tint of itself (`bg-primary/10`) are wrong in
 * every one of them, and a bare `bg-primary` fill only reads with its ink edge.
 */
const CHROME = [
  'app/components/InterviewSession.vue',
  'app/components/ProgressBar.vue',
  'app/components/InterviewCaption.vue',
  'app/components/InterviewTimer.vue',
  'app/components/molecules/InterviewGuide.vue',
  'app/components/molecules/InterviewSteps.vue',
] as const

describe.each(CHROME)('%s is canvas-safe', (path) => {
  const markup = template(path)

  it('uses no canvas-coloured text or tint', () => {
    expect(markup).not.toMatch(/\btext-primary(?![-\w])/)
    expect(markup).not.toMatch(/\bbg-primary\/\d+/)
    expect(markup).not.toMatch(/\bhover:text-primary\//)
  })

  it('paints no white page of its own', () => {
    expect(markup).not.toMatch(/\bbg-background\b/)
  })

  it('edges every solid brand fill in primary-ink', () => {
    for (const match of markup.matchAll(/class="([^"]*\bbg-primary(?![-\w/])[^"]*)"/g)) {
      expect(match[1]).toContain('border-primary-ink')
    }
  })
})
