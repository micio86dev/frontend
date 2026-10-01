import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * The one place the E2E specs lean on Nuxt internals to observe the router.
 *
 * There is no public signal for "a router navigation is in flight right now". Nuxt
 * marks it itself: its router plugin sets `nuxtApp._processingMiddleware` when a
 * navigation starts and deletes it in `afterEach`, and `navigateTo` consults that
 * flag (it is why a `navigateTo` issued mid-navigation is silently a no-op). The
 * specs that need to hold a navigation in flight, or wait for one to finish, read
 * that flag through `window.useNuxtApp()` and start navigations through the app's
 * `$router`.
 *
 * Those are private details, and the failure mode of an upgrade that renames them
 * is the worst kind: waiting for "the flag is gone" is vacuously true when the flag
 * no longer exists, so a helper written naively would stop waiting and the race it
 * guards against would come back as a flake. Everything here therefore fails LOUDLY
 * and names the assumption, in two ways:
 *
 *   - `assertNuxtRouterInternals()` reads the INSTALLED Nuxt's own source and
 *     checks it still sets and deletes `_processingMiddleware` and still exposes
 *     `useNuxtApp` on `window`. It runs before any wait, so an upgrade that changes
 *     them fails with a message that says which version was assumed.
 *   - the in-page helpers check the objects exist before using them.
 */

/** The Nuxt major.minor this file was written against (the pinned `nuxt` is ^4.4). */
const ASSUMED_NUXT = '4.4.x'

/**
 * The installed Nuxt's directory, found by module resolution from THIS file, so the
 * current working directory and a non-hoisted layout (a workspace, pnpm-style links)
 * do not matter. Resolution failing is itself a named error.
 */
function resolveNuxtRoot(): string {
  try {
    return dirname(createRequire(import.meta.url).resolve('nuxt/package.json'))
  } catch (error) {
    throw new Error(
      `E2E router helpers cannot resolve the installed Nuxt (assumed ${ASSUMED_NUXT}): ${String(error)}. ` +
        'Install dependencies, or revisit tests/e2e/fixtures/nuxt-router-state.ts.',
      { cause: error }
    )
  }
}

let checked = false

function readNuxtFile(relative: string): string {
  // Resolved before the try: a failure to find Nuxt at all is already a named error.
  const root = resolveNuxtRoot()

  try {
    return readFileSync(resolve(root, relative), 'utf-8')
  } catch (error) {
    throw new Error(
      `E2E router helpers cannot read ${relative} from the installed Nuxt (assumed ${ASSUMED_NUXT}): ${String(error)}. ` +
        'Nuxt was moved or restructured; revisit tests/e2e/fixtures/nuxt-router-state.ts.',
      { cause: error }
    )
  }
}

/**
 * Fails with a clear message when the installed Nuxt no longer works the way these
 * helpers assume. Cheap, synchronous and cached after the first call.
 */
export function assertNuxtRouterInternals(): void {
  if (checked) return

  const version = (JSON.parse(readNuxtFile('package.json')) as { version?: string }).version
  const router = readNuxtFile('dist/pages/runtime/plugins/router.js')
  const entry = readNuxtFile('dist/app/nuxt.js')
  const problems: string[] = []

  if (!/nuxtApp\._processingMiddleware\s*=/.test(router)) {
    problems.push('the router plugin no longer SETS nuxtApp._processingMiddleware')
  }
  if (!/delete nuxtApp\._processingMiddleware/.test(router)) {
    problems.push('the router plugin no longer DELETES nuxtApp._processingMiddleware')
  }
  if (!/window\.useNuxtApp\s*(?:\|\|)?=/.test(entry)) {
    problems.push('Nuxt no longer exposes useNuxtApp on window')
  }

  if (problems.length > 0) {
    throw new Error(
      `The E2E router helpers assume Nuxt ${ASSUMED_NUXT}; the installed Nuxt is ${version ?? 'unknown'} and ` +
        `${problems.join('; ')}. A wait for "the router is idle" would now pass vacuously and bring the ` +
        'navigateTo-during-navigation race back as a flake. Update tests/e2e/fixtures/nuxt-router-state.ts ' +
        '(find a new signal for "a navigation is in flight") before trusting these specs.'
    )
  }

  checked = true
}

/** `window.useNuxtApp`, checked in the page, so a missing hook is a named failure and not `undefined is not a function`. */
async function assertNuxtAppReachable(page: Page): Promise<void> {
  const reachable = await page.evaluate(() => {
    const hook = (window as unknown as { useNuxtApp?: () => unknown }).useNuxtApp

    return typeof hook === 'function' && hook() !== undefined
  })

  if (!reachable) {
    throw new Error(
      `window.useNuxtApp() is not available in the page (assumed Nuxt ${ASSUMED_NUXT}); ` +
        'the E2E router helpers cannot observe the router. See tests/e2e/fixtures/nuxt-router-state.ts.'
    )
  }
}

/** Resolves once no router navigation is in flight (Nuxt has deleted its processing flag). */
export async function waitForRouterIdle(page: Page): Promise<void> {
  assertNuxtRouterInternals()
  await assertNuxtAppReachable(page)

  await page.waitForFunction(() => {
    const nuxt = (
      window as unknown as { useNuxtApp?: () => { _processingMiddleware?: unknown } | undefined }
    ).useNuxtApp?.()

    return nuxt?._processingMiddleware === undefined
  })
}

/**
 * Resolves once a router navigation IS in flight. Throws, naming the assumption, when
 * the flag never appears: with a navigation held open that can only mean Nuxt stopped
 * using it.
 */
export async function waitForRouterBusy(page: Page, timeout = 5_000): Promise<void> {
  assertNuxtRouterInternals()
  await assertNuxtAppReachable(page)

  try {
    await page.waitForFunction(
      () => {
        const nuxt = (
          window as unknown as {
            useNuxtApp?: () => { _processingMiddleware?: unknown } | undefined
          }
        ).useNuxtApp?.()

        return nuxt?._processingMiddleware !== undefined
      },
      null,
      { timeout }
    )
  } catch (error) {
    throw new Error(
      'A router navigation was held in flight but nuxtApp._processingMiddleware never appeared ' +
        `(assumed Nuxt ${ASSUMED_NUXT}, the flag navigateTo consults). Either the navigation did not start ` +
        'or Nuxt renamed the flag; see tests/e2e/fixtures/nuxt-router-state.ts. ' +
        `Original error: ${String(error)}`,
      { cause: error }
    )
  }
}

/**
 * Starts a client-side navigation through the app's router and does NOT wait for it,
 * so the caller can hold it in flight. Throws a named error when the app's router is
 * not reachable through `#__nuxt.__vue_app__` (a private handle).
 */
export async function startRouterPush(page: Page, path: string): Promise<void> {
  const started = await page.evaluate((target) => {
    const root = document.querySelector('#__nuxt') as unknown as {
      __vue_app__?: {
        config?: { globalProperties?: { $router?: { push?: (to: string) => unknown } } }
      }
    } | null
    const router = root?.__vue_app__?.config?.globalProperties?.$router

    if (typeof router?.push !== 'function') return false

    void router.push(target)

    return true
  }, path)

  if (!started) {
    throw new Error(
      `Could not reach the app router through #__nuxt.__vue_app__.config.globalProperties.$router ` +
        `(assumed Vue 3 + Nuxt ${ASSUMED_NUXT}); see tests/e2e/fixtures/nuxt-router-state.ts.`
    )
  }
}
