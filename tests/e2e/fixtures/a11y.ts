import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

/**
 * Runs @axe-core accessibility checks on the current page at WCAG 2.1 AA level.
 * Call this after each navigation in E2E specs to enforce the D29 mandate.
 *
 * @param page The Playwright page under test.
 * @param include Optional CSS selector(s) to scope the scan to (axe-core's
 *   `AxeBuilder#include`). Use this to evaluate a specific open overlay
 *   (e.g. an open `Select` listbox) in isolation from unrelated, already-
 *   tracked violations elsewhere on the page — full-page scanning stays the
 *   default for every other call site.
 * @throws {Error} if any WCAG 2.1 AA violations are found
 */
export async function checkA11y(page: Page, include?: string | string[]): Promise<void> {
  // Let every in-flight animation settle FIRST. Axe measures the pixels on
  // screen at the instant it runs, and `toBeVisible()` resolves as soon as an
  // element enters the layout — an enter transition may still be playing. The
  // device picker's highlighted option failed exactly this way on WebKit while
  // passing on Chromium, purely because the timings differ, which made it read
  // as a browser-specific design bug rather than a measurement taken too early.
  // WCAG governs the settled interface, not the frames on the way to it.
  //
  // Infinite animations are FILTERED OUT rather than waited on: a spinner never
  // reaches `finished`, so "is every animation done" would be permanently false
  // and the wait would buy nothing while burning its timeout. With the loopers
  // excluded, reaching the timeout means a finite animation genuinely hung, so
  // it is deliberately not swallowed.
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .every((a) => a.playState === 'finished'),
    null,
    { timeout: 5_000 }
  )

  // `wcag21a` included. Without it every rule axe tags as WCAG 2.1 Level A was
  // skipped — `label-content-name-mismatch` (SC 2.5.3, Label in Name) among
  // them — while the docblock above and the error thrown below both announced
  // "WCAG 2.1 AA". AA conformance INCLUDES all Level A criteria, so the gate was
  // lying in its own failure message.
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
  if (include) {
    builder = builder.include(include)
  }
  const results = await builder.analyze()

  if (results.violations.length > 0) {
    const report = results.violations
      .map(
        (v) =>
          `[${v.impact}] ${v.id}: ${v.description}\n  Nodes: ${v.nodes.map((n) => n.html).join(', ')}`
      )
      .join('\n\n')
    throw new Error(`WCAG 2.1 AA violations found:\n\n${report}`)
  }
}
