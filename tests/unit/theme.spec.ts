/**
 * theme.spec.ts (D10, task 13.1 — RED)
 *
 * This is a discriminating test, not a text grep. `frontend/app/assets/css/main.css`
 * carries a confirmed shipped bug: its `@theme` block declares `--color-primary:
 * #771aaf` (the Quint brand purple), but its `@theme inline` shadcn bridge then
 * RE-DECLARES `--color-primary: var(--primary)`, and `:root` sets `--primary:
 * oklch(0.205 0 0)` (shadcn's default near-black grey). CSS cascade rules mean the
 * LAST declaration of a custom property in the same rule wins, so `bg-primary` in
 * `frontend` today resolves to grey, not purple — a test that merely greps the
 * stylesheet for the string "#771aaf" would still pass against that broken file,
 * because the literal hex value IS present in the source, just shadowed.
 *
 * To actually discriminate, this test:
 *   1. Runs `backoffice/app/assets/css/main.css` through the REAL Tailwind v4
 *      compiler (`compile()` from `@tailwindcss/node` — the same engine
 *      `@tailwindcss/vite` uses at build time), resolving every `@import`/
 *      `@theme`/`@theme inline` directive exactly as the app would at runtime.
 *   2. Mounts the compiled CSS into a real DOM (happy-dom) and reads
 *      `getComputedStyle` on an element carrying the `bg-primary` class — i.e. the
 *      actual cascaded, resolved value a browser would paint, not the source text.
 *
 * happy-dom does not implement CSS `@layer` cascade layers (verified: `var()`
 * resolution silently fails inside a `@layer` block, producing an empty computed
 * value). Tailwind always wraps its output in `@layer theme, base, ...`. Since this
 * test only cares about a single custom-property resolution — not cross-layer
 * precedence against page-author CSS — the compiled output's `@layer` at-rules are
 * unwrapped in place (content kept, wrapper removed) before injection. This was
 * verified against `frontend`'s actual (buggy) stylesheet during RED: the same
 * pipeline resolves its `bg-primary` to `""` (unparseable `oklch()` chain), which
 * correctly does NOT equal `#771aaf` — proving this test fails on the known-bad
 * pattern and would have caught the frontend regression.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { compile } from '@tailwindcss/node'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Window } from 'happy-dom'

const MAIN_CSS_PATH = resolve(__dirname, '../../app/assets/css/main.css')
const MAIN_CSS_DIR = resolve(__dirname, '../../app/assets/css')

/**
 * Tailwind v4 always wraps compiled output in `@layer <names>;` (a bare
 * layer-order statement) and `@layer <name> { ... }` (declaration blocks).
 * happy-dom's CSS engine does not implement cascade layers. This unwraps
 * `@layer` at-rules in place — dropping bare layer-order statements, keeping the
 * body of `@layer name { ... }` blocks — without altering declaration order or
 * any other at-rule (`@media`, `@supports`, `@font-face`, ...).
 */
function stripCascadeLayers(css: string): string {
  let out = ''
  let i = 0
  while (i < css.length) {
    const layerStart = css.indexOf('@layer', i)
    if (layerStart === -1) {
      out += css.slice(i)
      break
    }
    out += css.slice(i, layerStart)
    const braceIdx = css.indexOf('{', layerStart)
    const semiIdx = css.indexOf(';', layerStart)
    if (semiIdx !== -1 && (braceIdx === -1 || semiIdx < braceIdx)) {
      // Bare `@layer theme, base, components, utilities;` — drop entirely.
      i = semiIdx + 1
      continue
    }
    let depth = 1
    let j = braceIdx + 1
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
      j++
    }
    out += css.slice(braceIdx + 1, j - 1)
    i = j
  }
  return out
}

async function compileForCandidates(candidates: string[]): Promise<string> {
  const css = readFileSync(MAIN_CSS_PATH, 'utf-8')
  const compiler = await compile(css, {
    base: MAIN_CSS_DIR,
    onDependency: () => {},
  })
  return stripCascadeLayers(compiler.build(candidates))
}

function computedBackgroundColor(compiledCss: string, className: string): string {
  const window = new Window()
  const document = window.document
  const style = document.createElement('style')
  style.textContent = compiledCss
  document.head.appendChild(style)
  const el = document.createElement('div')
  el.className = className
  document.body.appendChild(el)
  return window.getComputedStyle(el).backgroundColor
}

/** Extracts the body of the first `<selector> { ... }` block from raw CSS source. */
function extractBlock(css: string, selector: string): string {
  const start = css.indexOf(selector)
  if (start === -1) throw new Error(`Selector "${selector}" not found in source CSS`)
  const braceIdx = css.indexOf('{', start)
  let depth = 1
  let j = braceIdx + 1
  while (j < css.length && depth > 0) {
    if (css[j] === '{') depth++
    else if (css[j] === '}') depth--
    j++
  }
  return css.slice(braceIdx + 1, j - 1).trim()
}

describe('brand theme tokens (D10)', () => {
  let bgPrimaryCss: string
  let bgAccentCss: string

  beforeAll(async () => {
    bgPrimaryCss = await compileForCandidates(['bg-primary'])
    bgAccentCss = await compileForCandidates(['bg-accent'])
  })

  it('resolves the computed background of bg-primary to Quint purple #771aaf', () => {
    expect(computedBackgroundColor(bgPrimaryCss, 'bg-primary')).toBe('#771aaf')
  })

  it('resolves the computed background of bg-accent to Quint orange #e45526', () => {
    expect(computedBackgroundColor(bgAccentCss, 'bg-accent')).toBe('#e45526')
  })

  // Regression guard, not exercising main.css: reconstructs the exact confirmed
  // frontend shadowing pattern (@theme literal → @theme inline re-declaration →
  // :root oklch grey) as an inline stylesheet through the SAME computedBackgroundColor
  // helper used above, proving the helper itself discriminates the bug rather than
  // trivially matching any stylesheet that merely mentions the hex string.
  it('the test apparatus itself fails a stylesheet reproducing the confirmed frontend bridge-shadowing bug', () => {
    const buggyCss = `
      :root {
        --color-primary: #771aaf;
        --color-primary: var(--primary);
        --primary: oklch(0.205 0 0);
      }
      .bg-primary { background-color: var(--color-primary); }
    `
    expect(computedBackgroundColor(buggyCss, 'bg-primary')).not.toBe('#771aaf')
  })
})

// task 13.3 — snapshot over the full token block, as a regression guard for
// future edits. Snapshots the AUTHORED source (not Tailwind's compiled output,
// which would also include unrelated framework defaults), so a diff here means
// someone touched a brand token, a bridged/omitted key, or a semantic mapping —
// forcing an explicit, reviewed snapshot update rather than a silent drift.
describe('brand theme token source (regression guard)', () => {
  const css = readFileSync(MAIN_CSS_PATH, 'utf-8')

  it('@theme literal block matches the known-good snapshot', () => {
    expect(extractBlock(css, '@theme {')).toMatchSnapshot()
  })

  it('@theme inline bridge omits the six colliding keys (--color-primary, --color-accent, --radius-sm/md/lg/xl)', () => {
    const bridge = extractBlock(css, '@theme inline {')
    for (const collidingKey of [
      '--color-primary:',
      '--color-accent:',
      '--radius-sm:',
      '--radius-md:',
      '--radius-lg:',
      '--radius-xl:',
    ]) {
      expect(bridge).not.toContain(collidingKey)
    }
    expect(bridge).toMatchSnapshot()
  })

  it(':root semantic block matches the known-good snapshot', () => {
    expect(extractBlock(css, ':root {')).toMatchSnapshot()
  })
})
