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
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
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
