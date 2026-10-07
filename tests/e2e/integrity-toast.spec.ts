import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { checkA11y } from './fixtures/a11y'
import { injectDeviceMocks } from './fixtures/device-mocks'
import { mockBrandedInterview } from './fixtures/branded-interview'

/**
 * The integrity toast reaches the candidate (DESIGN.md §7.0.1, §9.1, §9.3).
 *
 * A real integrity event — a `copy` on the live screen, which the proctor
 * records as `clipboard_copy` — must surface as a localized instruction in the
 * one Toaster the interview mounts: the candidate's language, never the raw
 * kind, announced politely, not focused, and legible on whatever colour the
 * client picked, because the toast sits on its own white surface.
 *
 * `TOAST_SHOTS_DIR` (optional) saves one screenshot per colour for a human look.
 */

const TOKEN = 'toast-token-abc123'
const SHOTS_DIR = process.env['TOAST_SHOTS_DIR']

/** The real locale files: the assertions follow the copy, never a duplicate of it. */
function messagesOf(locale: 'it' | 'en') {
  const path = new URL(`../../i18n/locales/${locale}.json`, import.meta.url)
  return JSON.parse(readFileSync(path, 'utf8')) as {
    interview: {
      consent: { accept: string }
      device_check: { continue: string }
      live: { pause: string }
      integrity_toast: Record<string, { title: string; description: string }> & {
        region_label: string
        close: string
      }
    }
  }
}

type Messages = ReturnType<typeof messagesOf>
const en = messagesOf('en')
const it = messagesOf('it')

async function reachLiveScreen(page: Page, path: string, messages: Messages): Promise<void> {
  await page.goto(path)
  await page
    .getByRole('button', { name: messages.interview.consent.accept })
    .click({ timeout: 15000 })
  const start = page.getByRole('button', { name: messages.interview.device_check.continue })
  await expect(start).toBeEnabled({ timeout: 8000 })
  await start.click()
  await expect(page.getByRole('button', { name: messages.interview.live.pause })).toBeVisible({
    timeout: 15000,
  })
}

/**
 * The colours the browser resolved on the real toast, as `rgb(r, g, b)`. Tailwind's
 * tokens compute to `oklch()`, so each is read back through a 1px canvas.
 */
async function toastColours(page: Page) {
  return page.locator('[data-sonner-toast]').evaluate((toast) => {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const rgb = (value: string): string => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = '#000000'
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data
      return `rgb(${r}, ${g}, ${b})`
    }
    const style = (el: Element | null) => getComputedStyle(el!)
    return {
      background: rgb(style(toast).backgroundColor),
      title: rgb(style(toast.querySelector('[data-title]')).color),
      description: rgb(style(toast.querySelector('[data-description]')).color),
      accent: rgb(style(toast).borderInlineStartColor),
    }
  })
}

for (const [label, colour] of [
  ['yellow', '#ffd400'],
  ['violet', '#771aaf'],
  ['blue', '#2f6fed'],
  ['none', null],
] as const) {
  test.describe(`integrity toast on the brand canvas — ${label}`, () => {
    test.beforeEach(async ({ page }) => {
      await mockBrandedInterview(page, colour)
      await injectDeviceMocks(page)
    })

    test('a copy on the live screen shows the localized instruction, announced and not focused', async ({
      page,
    }) => {
      await reachLiveScreen(page, `/en/interview/${TOKEN}`, en)
      const focusedBefore = await page.evaluate(() => document.activeElement?.tagName ?? null)

      await page.evaluate(() => document.dispatchEvent(new Event('copy')))

      const toast = page.locator('[data-sonner-toast]')
      const copy = en.interview.integrity_toast['clipboard_copy']!
      await expect(toast).toHaveCount(1)
      await expect(toast.locator('[data-title]')).toHaveText(copy.title)
      await expect(toast.locator('[data-description]')).toHaveText(copy.description)
      await expect(toast).not.toContainText('clipboard')

      // Inside a polite live region named in the candidate's language.
      const region = page.locator('section[aria-live]', { has: toast })
      await expect(region).toHaveAttribute('aria-live', 'polite')
      await expect(region).toHaveAttribute(
        'aria-label',
        new RegExp(en.interview.integrity_toast.region_label)
      )
      expect(await page.evaluate(() => document.activeElement?.tagName ?? null)).toBe(focusedBefore)

      // On its own white card with the text-safe tokens, whatever the canvas.
      await expect
        .poll(async () => (await toastColours(page)).background)
        .toBe('rgb(255, 255, 255)')
      const colours = await toastColours(page)
      expect(colours.title).toBe(colours.description)
      // `--card-foreground`, oklch(0.145 0 0).
      expect(colours.title).toBe('rgb(10, 10, 10)')
      expect(colours.accent).toBe('rgb(185, 28, 28)')

      // Clear of the header's status pill and of the live dock's Pause control.
      const toastBox = (await toast.boundingBox())!
      const pillBox = (await page.getByTestId('interview-status').boundingBox())!
      const pauseBox = (await page
        .getByRole('button', { name: en.interview.live.pause })
        .boundingBox())!
      expect(toastBox.y).toBeGreaterThanOrEqual(pillBox.y + pillBox.height)
      expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(pauseBox.y)

      // Painted on top: nothing in the interview (the avatar panel) covers it.
      for (const part of ['[data-title]', '[data-description]']) {
        const covered = await toast.locator(part).evaluate((el) => {
          const box = el.getBoundingClientRect()
          const hit = document.elementFromPoint(box.left + 4, box.top + box.height / 2)
          return !el.closest('[data-sonner-toast]')!.contains(hit)
        })
        expect(covered, `${part} is covered`).toBe(false)
      }

      await checkA11y(page)

      if (SHOTS_DIR) {
        mkdirSync(SHOTS_DIR, { recursive: true })
        await page.screenshot({
          path: join(SHOTS_DIR, `toast-${label}-${test.info().project.name}.png`),
        })
      }

      // Dismissible: the close control removes it.
      await toast.getByRole('button', { name: en.interview.integrity_toast.close }).click()
      await expect(toast).toHaveCount(0)
    })
  })
}

test.describe('integrity toast in Italian', () => {
  test('the default locale shows the Italian instruction', async ({ page }) => {
    await mockBrandedInterview(page, '#ffd400')
    await injectDeviceMocks(page)
    await reachLiveScreen(page, `/interview/${TOKEN}`, it)

    await page.evaluate(() => document.dispatchEvent(new Event('paste')))

    const toast = page.locator('[data-sonner-toast]')
    const copy = it.interview.integrity_toast['clipboard_paste']!
    await expect(toast.locator('[data-title]')).toHaveText(copy.title)
    await expect(toast.locator('[data-description]')).toHaveText(copy.description)
    await expect(toast).not.toContainText('clipboard')
    await checkA11y(page)
  })
})
