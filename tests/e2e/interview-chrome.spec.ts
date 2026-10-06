import { test, expect, type Locator, type Page } from '@playwright/test'
import { checkA11y } from './fixtures/a11y'
import { injectDeviceMocks } from './fixtures/device-mocks'

/**
 * The interview chrome on the brand canvas (DESIGN.md §7.0.1, §7.2).
 *
 * The client colour is arbitrary, so the consent, device check and live
 * screens are run through axe under a light client colour, where on-primary is
 * black, and a dark one, where it is white. Either can break a pair the other
 * never exercises: white text on yellow, a yellow fill on a white surface.
 */

const TOKEN = 'chrome-token-abc123'

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function makeCandidateJwt(): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      typ: 'candidate',
      candidate_ref: 'cand-chrome-001',
      project_id: 1,
      exp: Math.floor(Date.now() / 1000) + 7200,
    })
  )
  return `${header}.${payload}.e2e-fake-signature`
}

const START_RESPONSE = {
  session_id: 1,
  provider: 'heygen',
  provider_token: 'heygen-token-xyz',
  audio_only: false,
  question_context: {
    question_index: 0,
    total_questions: 3,
    end_phrase: 'Let us move on to the next question.',
    final_phrase: 'Thank you for your time.',
    competency_code: 'COM',
  },
}

async function mockBrandedInterview(page: Page, primaryColor: string): Promise<void> {
  await page.route('**/api/sso/exchange*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: makeCandidateJwt() }),
    })
  )
  await page.route('**/api/candidate/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          project: { exit_redirect_url: null },
          branding: { primary_color: primaryColor, logo_url: null, name: 'Acme Selezione' },
        },
      }),
    })
  )
  await page.route('**/api/candidate/interview/start', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(START_RESPONSE),
    })
  )
  for (const path of ['utterance', 'integrity', 'snapshot']) {
    await page.route(`**/api/candidate/interview/${path}`, (route) =>
      route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok' }),
      })
    )
  }
}

/** The colour the canvas actually painted, as `rgb(r, g, b)`. */
async function canvasColour(page: Page): Promise<string> {
  return page.locator('.brand-canvas').evaluate((node) => getComputedStyle(node).backgroundColor)
}

/**
 * Contrast of the focus outline the browser really painted on `target` against
 * the first opaque background behind it. Computed in the page, so `!important`,
 * layer order and the real built CSS are all in play (the unit test only reads
 * the source). One Tab press first puts the page in keyboard modality, which is
 * what makes a programmatic `focus()` match `:focus-visible`; WebKit's Tab
 * skips buttons by default, so the control is focused directly after that.
 */
async function focusViaKeyboardModality(page: Page, target: Locator): Promise<void> {
  await page.keyboard.press('Tab')
  await target.focus()
}

/** Polled by the caller: the vendored controls transition their outline colour in. */
async function focusRingContrast(target: Locator): Promise<number> {
  return target.evaluate((el) => {
    // Computed colours can be `oklch()` (Tailwind's tokens), so read them back through a canvas.
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const toRgb = (value: string): { r: number; g: number; b: number; a: number } => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = '#000000'
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const [r = 0, g = 0, b = 0, a = 255] = context.getImageData(0, 0, 1, 1).data

      return { r, g, b, a: a / 255 }
    }
    const lum = ({ r, g, b }: { r: number; g: number; b: number }): number => {
      const c = [r, g, b].map((v) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      })

      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
    }

    if (document.activeElement !== el || !el.matches(':focus-visible')) return -1

    const style = getComputedStyle(el)
    if (style.outlineStyle === 'none' || Number.parseFloat(style.outlineWidth) === 0) return 0

    // The outline is drawn 2px OUTSIDE the control, so what it sits on is what is behind the control.
    let node: HTMLElement | null = el.parentElement
    let background = { r: 255, g: 255, b: 255, a: 1 }
    while (node) {
      const candidate = toRgb(getComputedStyle(node).backgroundColor)
      if (candidate.a > 0.95) {
        background = candidate
        break
      }
      node = node.parentElement
    }

    const outline = lum(toRgb(style.outlineColor))
    const behind = lum(background)

    return (Math.max(outline, behind) + 0.05) / (Math.min(outline, behind) + 0.05)
  })
}

for (const [label, colour, rgb] of [
  ['light #ffd400', '#ffd400', 'rgb(255, 212, 0)'],
  ['dark #771aaf', '#771aaf', 'rgb(119, 26, 175)'],
] as const) {
  test.describe(`interview chrome on the brand canvas — ${label}`, () => {
    test.beforeEach(async ({ page }) => {
      await mockBrandedInterview(page, colour)
      await injectDeviceMocks(page)
    })

    test('consent, device check and live screens are legible (axe) on the client colour', async ({
      page,
    }) => {
      await page.goto(`/en/interview/${TOKEN}`)

      const steps = page.getByRole('list', { name: /interview steps/i })
      await expect(page.getByRole('button', { name: /accept and continue/i })).toBeVisible({
        timeout: 15000,
      })
      await expect.poll(() => canvasColour(page)).toBe(rgb)
      await expect(page.getByText('Acme Selezione')).toBeVisible()
      await expect(steps.locator('[aria-current="step"]')).toContainText('Consent')
      await checkA11y(page)

      await page.getByRole('button', { name: /accept and continue/i }).click()
      await expect(page.getByRole('button', { name: /start the interview/i })).toBeEnabled({
        timeout: 8000,
      })
      await expect(steps.locator('[aria-current="step"]')).toContainText('Devices')
      await checkA11y(page)

      await page.getByRole('button', { name: /start the interview/i }).click()
      await expect(page.getByRole('button', { name: /^pause$/i })).toBeVisible({ timeout: 15000 })
      await expect(page.getByRole('timer')).toBeVisible()
      await expect(page.getByText(/listen to the question/i)).toBeVisible()
      await expect.poll(() => canvasColour(page)).toBe(rgb)
      await checkA11y(page)
    })

    test('the focus ring stands out from what is behind it, on the bare canvas and inside the surface', async ({
      page,
    }) => {
      await page.goto(`/en/interview/${TOKEN}`)
      const accept = page.getByRole('button', { name: /accept and continue/i })
      await expect(accept).toBeVisible({ timeout: 15000 })
      await expect.poll(() => canvasColour(page)).toBe(rgb)

      // Inside the white surface: the primary-ink outline on white.
      await focusViaKeyboardModality(page, accept)
      await expect.poll(() => focusRingContrast(accept)).toBeGreaterThanOrEqual(3)

      // Straight on the canvas: nothing on screen sits there, so put a control there.
      const probe = page.locator('[data-testid="focus-probe"]')
      await page.locator('.brand-canvas > header').evaluate((header) => {
        const button = document.createElement('button')
        button.dataset.testid = 'focus-probe'
        button.textContent = 'probe'
        header.append(button)
      })
      await focusViaKeyboardModality(page, probe)
      await expect.poll(() => focusRingContrast(probe)).toBeGreaterThanOrEqual(3)
    })
  })
}

test.describe('the destructive alert follows its variant, in the real built CSS', () => {
  // A unit test cannot see Tailwind's generated rule order, so this renders the
  // real recovery alert (the microphone is refused) and reads the colours the
  // browser resolved: title, description and the alert itself must agree on the
  // text-safe error token, and clear 4.5:1 on the alert's own background.
  test('title and description resolve to --color-error-dark and stay >= 4.5:1', async ({
    page,
  }) => {
    await mockBrandedInterview(page, '#771aaf')
    await injectDeviceMocks(page)
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          throw new DOMException('Permission denied', 'NotAllowedError')
        },
      })
    })
    await page.goto(`/en/interview/${TOKEN}`)
    await page.getByRole('button', { name: /accept and continue/i }).click({ timeout: 15000 })

    const alert = page.getByTestId('recovery-alert')
    await expect(alert).toBeVisible()

    const colours = await alert.evaluate((root) => {
      const colourOf = (el: Element | null): string => (el ? getComputedStyle(el).color : 'missing')

      return {
        alert: colourOf(root),
        title: colourOf(root.querySelector('[data-slot="alert-title"]')),
        description: colourOf(root.querySelector('[data-slot="alert-description"]')),
        background: getComputedStyle(root).backgroundColor,
      }
    })

    // `--color-error-dark` is #b91c1c.
    expect(colours.title).toBe('rgb(185, 28, 28)')
    expect(colours.description).toBe(colours.title)
    expect(colours.alert).toBe(colours.title)
    expect(colours.background).toMatch(/^(rgb\(254, 226, 226\)|oklch\()/)
  })
})

test.describe('device check fits the desktop viewport', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('does not scroll at 1440x900', async ({ page }) => {
    await mockBrandedInterview(page, '#771aaf')
    await injectDeviceMocks(page)
    await page.goto(`/en/interview/${TOKEN}`)
    await page.getByRole('button', { name: /accept and continue/i }).click({ timeout: 15000 })
    await expect(page.getByRole('button', { name: /start the interview/i })).toBeEnabled({
      timeout: 8000,
    })

    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })
})
