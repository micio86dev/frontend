import type { Page } from '@playwright/test'

/**
 * Resolves once Nuxt has finished hydrating the server-rendered document.
 *
 * Server-rendered markup is visible, focusable and clickable BEFORE hydration,
 * but nothing is listening: a `@click` handler only exists once Vue has hydrated
 * the component. A web-first `toBeVisible()` therefore proves the HTML arrived,
 * not that the page can react, and an action fired in that gap is silently lost.
 * That is a flake that depends on how slow the runner is — it never reproduces on
 * a fast machine and fails the first attempt on a busy one.
 *
 * `nuxtApp.isHydrating` is the framework's own signal for exactly this: it flips
 * to `false` when every pending suspense boundary has resolved. `useNuxtApp` is
 * exposed on `window` by Nuxt's client entry.
 */
export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const nuxt = (
      window as unknown as { useNuxtApp?: () => { isHydrating?: boolean } | undefined }
    ).useNuxtApp?.()

    return nuxt !== undefined && nuxt.isHydrating === false
  })
}
