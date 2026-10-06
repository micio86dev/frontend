import { test, expect, type Page } from '@playwright/test'
import { checkA11y } from './fixtures/a11y'

/**
 * WCAG 2.4.2 (Page Titled, axe `document-title`) on the candidate states that
 * are loaded directly and used to render an empty <title>: the entry loading
 * screen and the terminal page reached with `?reason=link_used`.
 */

function sessionToken(): string {
  const b64 = (v: unknown) =>
    Buffer.from(JSON.stringify(v))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'interview-title-1', exp: Math.floor(Date.now() / 1000) + 7200 })}.sig`
}

async function expectTitled(page: Page, pattern: RegExp): Promise<void> {
  await expect.poll(() => page.title()).toMatch(pattern)
  await checkA11y(page)
}

test.describe('document titles on directly loaded candidate states', () => {
  // The exact string, per locale: a non-empty check would pass for a raw i18n key
  // or for the wrong language.
  for (const [locale, prefix, title] of [
    ['en', '/en', 'BEAI Interview'],
    ['it', '', 'Colloquio BEAI'],
  ] as const) {
    test(`the entry loading state is titled "${title}" (${locale}) and passes axe`, async ({
      page,
    }) => {
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => (release = resolve))
      await page.route('**/api/embed/exchange*', async (route) => {
        await held
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
      })

      await page.goto(`${prefix}/i/${sessionToken()}`)
      await expectTitled(page, new RegExp(`^${title}$`))
      release()
    })
  }

  test('terminal link_used loaded directly has a title in en and it', async ({ page }) => {
    await page.goto('/en/interview/terminal?reason=link_used')
    await expectTitled(page, /This Link Has Already Been Used/)

    // Italian is the default locale: no prefix.
    await page.goto('/interview/terminal?reason=link_used')
    await expectTitled(page, /Questo link è già stato utilizzato/)
  })
})
