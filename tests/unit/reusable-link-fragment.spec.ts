import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  REUSABLE_TOKEN_FORMAT,
  captureReusableLinkFragment,
  discardReusableLinkFragment,
  takeReusableLinkToken,
  type FragmentWindow,
} from '~/app/utils/reusable-link-fragment'
import { REUSABLE_LINK_TOKEN } from './fixtures/reusable-link-scrub-cases'

/**
 * The reusable link token travels in the URL FRAGMENT, so it is never sent to a
 * server, a proxy or an access log. It still sits in the address bar, in the
 * history entry and in whatever the visitor shares next, so the candidate app
 * removes it the moment it can: the early client plugin calls
 * `captureReusableLinkFragment` on EVERY route, and the entry page later takes
 * the token out of module memory exactly once.
 *
 * Two jobs, two functions: strip at once (even for a malformed or truncated
 * token, even on the wrong route), hand the token over once (only if it has the
 * exact 51-character shape).
 */

const REUSABLE_PATH = '/interview/reusable'

function visit(url: string, state: unknown = null): void {
  window.history.replaceState(state, '', url)
}

beforeEach(() => {
  // A previous test must not leak a held token into the next one.
  discardReusableLinkFragment()
  visit('/')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('captureReusableLinkFragment', () => {
  it('removes a #beai_rl_ fragment from the address bar at once', () => {
    visit(`${REUSABLE_PATH}#${REUSABLE_LINK_TOKEN}`)

    captureReusableLinkFragment(window)

    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain('beai_rl_')
  })

  it('keeps the path and the query string', () => {
    visit(`/en/interview/reusable?utm=kiosk#${REUSABLE_LINK_TOKEN}`)

    captureReusableLinkFragment(window)

    expect(window.location.pathname).toBe('/en/interview/reusable')
    expect(window.location.search).toBe('?utm=kiosk')
  })

  it('replaces the history entry: it never adds one and never navigates', () => {
    visit(`${REUSABLE_PATH}#${REUSABLE_LINK_TOKEN}`)
    const lengthBefore = window.history.length
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')

    captureReusableLinkFragment(window)

    expect(replaceState).toHaveBeenCalledTimes(1)
    expect(pushState).not.toHaveBeenCalled()
    expect(window.history.length).toBe(lengthBefore)
  })

  it('preserves the history state, which belongs to the router', () => {
    const routerState = { back: null, current: REUSABLE_PATH, position: 1 }
    visit(`${REUSABLE_PATH}#${REUSABLE_LINK_TOKEN}`, routerState)

    captureReusableLinkFragment(window)

    expect(window.history.state).toEqual(routerState)
  })

  it('strips a fragment of ANY length, so a truncated or padded token is not left behind', () => {
    for (const body of ['', 'short', 'x'.repeat(43), 'y'.repeat(300)]) {
      visit(`${REUSABLE_PATH}#beai_rl_${body}`)

      captureReusableLinkFragment(window)

      expect(window.location.hash).toBe('')
      discardReusableLinkFragment()
    }
  })

  it('strips the fragment on ANY route, not only the entry route', () => {
    for (const path of ['/', '/unsupported', '/en/unsupported', '/interview/abc', '/i/abc']) {
      visit(`${path}#${REUSABLE_LINK_TOKEN}`)

      captureReusableLinkFragment(window)

      expect(window.location.href).not.toContain('beai_rl_')
      expect(window.location.pathname).toBe(path)
      discardReusableLinkFragment()
    }
  })

  it('leaves every other fragment alone and does not touch history', () => {
    visit('/interview/done#section-2')
    const replaceState = vi.spyOn(window.history, 'replaceState')

    captureReusableLinkFragment(window)

    expect(window.location.hash).toBe('#section-2')
    expect(replaceState).not.toHaveBeenCalled()
    expect(takeReusableLinkToken()).toEqual({ present: false, token: null })
  })

  it('does not treat a fragment that merely CONTAINS the marker as a link token', () => {
    visit(`/page#anchor-beai_rl_${'a'.repeat(43)}`)

    captureReusableLinkFragment(window)

    expect(window.location.hash).toBe(`#anchor-beai_rl_${'a'.repeat(43)}`)
    expect(takeReusableLinkToken()).toEqual({ present: false, token: null })
  })

  it('does nothing when there is no fragment at all', () => {
    visit(REUSABLE_PATH)
    const replaceState = vi.spyOn(window.history, 'replaceState')

    captureReusableLinkFragment(window)

    expect(replaceState).not.toHaveBeenCalled()
    expect(takeReusableLinkToken()).toEqual({ present: false, token: null })
  })

  it('a second capture with no fragment does not erase a token already held', () => {
    // The plugin runs once at start and the page takes the token later; any
    // further capture in between must be harmless.
    visit(`${REUSABLE_PATH}#${REUSABLE_LINK_TOKEN}`)
    captureReusableLinkFragment(window)

    captureReusableLinkFragment(window)

    expect(takeReusableLinkToken()).toEqual({ present: true, token: REUSABLE_LINK_TOKEN })
  })
})

describe('takeReusableLinkToken', () => {
  it('returns the token once, then nothing', () => {
    visit(`${REUSABLE_PATH}#${REUSABLE_LINK_TOKEN}`)
    captureReusableLinkFragment(window)

    expect(takeReusableLinkToken()).toEqual({ present: true, token: REUSABLE_LINK_TOKEN })
    expect(takeReusableLinkToken()).toEqual({ present: false, token: null })
  })

  it('reports no fragment before anything was captured', () => {
    expect(takeReusableLinkToken()).toEqual({ present: false, token: null })
  })

  it('reports a fragment that was present but is not a valid token as present with no token', () => {
    visit(`${REUSABLE_PATH}#beai_rl_short`)
    captureReusableLinkFragment(window)

    expect(takeReusableLinkToken()).toEqual({ present: true, token: null })
    expect(takeReusableLinkToken()).toEqual({ present: false, token: null })
  })

  it.each([
    ['one character short', `beai_rl_${'a'.repeat(42)}`],
    ['one character long', `beai_rl_${'a'.repeat(44)}`],
    ['a `+` in the body', `beai_rl_${'a'.repeat(42)}+`],
    ['a `/` in the body', `beai_rl_${'a'.repeat(42)}/`],
    ['padding', `beai_rl_${'a'.repeat(42)}=`],
    ['the wrong marker', `beai_rk_${'a'.repeat(43)}`],
  ])('never hands over a token that is %s', (_name, candidate) => {
    visit(`${REUSABLE_PATH}#${candidate}`)
    captureReusableLinkFragment(window)

    const taken = takeReusableLinkToken()

    // The wrong marker is not a link fragment at all; every other near miss is.
    expect(taken.token).toBeNull()
    expect(taken.present).toBe(candidate.startsWith('beai_rl_'))
  })

  it('accepts the base64url alphabet, `-` and `_` included', () => {
    const token = `beai_rl_${'A-_z09'.repeat(7)}a`

    expect(token).toHaveLength(51)

    visit(`${REUSABLE_PATH}#${token}`)
    captureReusableLinkFragment(window)

    expect(takeReusableLinkToken()).toEqual({ present: true, token })
  })
})

describe('REUSABLE_TOKEN_FORMAT', () => {
  it('is the exact 51-character shape and is anchored at both ends', () => {
    expect(REUSABLE_TOKEN_FORMAT.test(REUSABLE_LINK_TOKEN)).toBe(true)
    expect(REUSABLE_TOKEN_FORMAT.test(`${REUSABLE_LINK_TOKEN}\n`)).toBe(false)
    expect(REUSABLE_TOKEN_FORMAT.test(` ${REUSABLE_LINK_TOKEN}`)).toBe(false)
  })
})

describe('discardReusableLinkFragment', () => {
  it('forgets a held token', () => {
    visit(`${REUSABLE_PATH}#${REUSABLE_LINK_TOKEN}`)
    captureReusableLinkFragment(window)

    discardReusableLinkFragment()

    expect(takeReusableLinkToken()).toEqual({ present: false, token: null })
  })
})

describe('the early client plugin', () => {
  // Each load registers a `hashchange` listener on the shared window. Without
  // removing it, an earlier test's listener answers a later test's navigation.
  const registered: Array<[string, EventListenerOrEventListenerObject]> = []

  async function loadPlugin(): Promise<() => void> {
    // The object syntax, because that is the only form Nuxt reads static
    // metadata (`order`) from. The real `defineNuxtPlugin` returns the plugin;
    // here the setup function is all the test needs.
    vi.stubGlobal('defineNuxtPlugin', (plugin: { setup: () => void }) => plugin.setup)
    const original = window.addEventListener.bind(window)

    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      registered.push([type, listener as EventListenerOrEventListenerObject])
      original(type, listener, options)
    })
    vi.resetModules()

    const module = (await import('~/app/plugins/00.reusable-link-fragment.client')) as {
      default: () => void
    }

    return module.default
  }

  afterEach(() => {
    for (const [type, listener] of registered.splice(0)) {
      window.removeEventListener(type, listener)
    }

    vi.unstubAllGlobals()
  })

  it('strips the fragment when the app starts, whatever the route', async () => {
    visit(`/unsupported#${REUSABLE_LINK_TOKEN}`)
    const plugin = await loadPlugin()

    plugin()

    expect(window.location.href).not.toContain('beai_rl_')
    expect(window.location.pathname).toBe('/unsupported')
  })

  it('hands the captured token to the page that asks for it', async () => {
    visit(`${REUSABLE_PATH}#${REUSABLE_LINK_TOKEN}`)
    const plugin = await loadPlugin()

    plugin()

    const { takeReusableLinkToken: take } = await import('~/app/utils/reusable-link-fragment')

    expect(take()).toEqual({ present: true, token: REUSABLE_LINK_TOKEN })
  })

  it('strips a link pasted into the address bar later, so it never lingers', async () => {
    // A hash-only change is a same-document navigation: no reload, so the start
    // hook does not run again.
    visit(REUSABLE_PATH)
    const plugin = await loadPlugin()
    plugin()

    visit(`${REUSABLE_PATH}#${REUSABLE_LINK_TOKEN}`)
    window.dispatchEvent(new Event('hashchange'))

    expect(window.location.href).not.toContain('beai_rl_')
  })
})

describe('the early client plugin runs BEFORE the router plugin', () => {
  // The finding behind this block, from the real app: Nuxt's router plugin
  // (`nuxt:router`, order -20) captures `window.location`, hash included, while
  // it sets up, and `app:created` then replays that location with
  // `router.replace`. A default-order plugin strips the fragment AFTER that
  // capture, so the router wrote it straight back: `/unsupported#beai_rl_…`
  // stayed in the address bar, and `history.state.current` held the token.
  // The plugin therefore has to run first, and Nuxt reads that from a STATIC
  // `order` in the object-syntax plugin, which is what this pins.
  // Comments stripped: the plugin's own docblock quotes `order: -50`, and a
  // pin that reads its own explanation instead of the code cannot fail.
  const rawSource = readFileSync(
    resolve(__dirname, '../../app/plugins/00.reusable-link-fragment.client.ts'),
    'utf-8'
  )
  const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const ROUTER_PLUGIN_ORDER = -20

  it('uses the object syntax, the only form Nuxt extracts static metadata from', () => {
    expect(source).toMatch(/defineNuxtPlugin\(\s*\{/)
  })

  it('has no text, comments included, that makes Nuxt skip its metadata', () => {
    // Nuxt's `extractMetadata` runs `/defineNuxtPlugin\s*\([\w(]/` over the RAW
    // file, comments included, and returns NO metadata on a hit: it takes the
    // text for a function-syntax plugin. This plugin's own docblock once
    // contained exactly that text, and `order: -50` was silently ignored — the
    // router still ran first and wrote the fragment back.
    expect(rawSource).not.toMatch(/defineNuxtPlugin\s*\([\w(]/)
  })

  it('declares an order strictly lower than the router plugin', () => {
    const match = /order:\s*(-\d+)/.exec(source)

    expect(match, 'the plugin must declare a numeric `order`').not.toBeNull()
    expect(Number(match?.[1])).toBeLessThan(ROUTER_PLUGIN_ORDER)
  })
})

describe('captureReusableLinkFragment — the router state written back by a hash change', () => {
  // A hash-only change fires `popstate` BEFORE `hashchange`. With no state on
  // that entry, vue-router answers `replace(to)`, where `to` is built from a
  // `location` that still carries the fragment, and so writes
  // `{ current: '<path>#beai_rl_…', replaced: true, … }` into `history.state`.
  // By the time the plugin's `hashchange` listener runs, the state it is about to
  // hand back to `replaceState` already holds the token, so the strip has to
  // clean `current` as well as the address bar. A plain object stands in for the
  // window so each case can read exactly what was passed to `replaceState`.
  const PATH = '/en/interview/reusable'

  function windowWith(
    state: unknown,
    options: { hash?: string; search?: string } = {}
  ): { win: FragmentWindow; replaceState: ReturnType<typeof vi.fn> } {
    const replaceState = vi.fn()
    const win = {
      location: {
        hash: options.hash ?? `#${REUSABLE_LINK_TOKEN}`,
        pathname: PATH,
        search: options.search ?? '',
      },
      history: { state, replaceState },
    } as unknown as FragmentWindow

    return { win, replaceState }
  }

  it('rewrites a router-shaped `current` that carries the fragment to pathname plus search', () => {
    const routerState = {
      back: null,
      current: `${PATH}#${REUSABLE_LINK_TOKEN}`,
      forward: null,
      replaced: true,
      position: 1,
      scroll: null,
    }
    const { win, replaceState } = windowWith(routerState)

    captureReusableLinkFragment(win)

    expect(replaceState).toHaveBeenCalledTimes(1)
    expect(replaceState).toHaveBeenCalledWith({ ...routerState, current: PATH }, '', PATH)
    // The router's own object is not mutated.
    expect(routerState.current).toContain('beai_rl_')
  })

  it('keeps the query string of `current`', () => {
    const { win, replaceState } = windowWith(
      { current: `${PATH}?utm=kiosk#${REUSABLE_LINK_TOKEN}`, position: 2 },
      { search: '?utm=kiosk' }
    )

    captureReusableLinkFragment(win)

    expect(replaceState).toHaveBeenCalledWith(
      { current: `${PATH}?utm=kiosk`, position: 2 },
      '',
      `${PATH}?utm=kiosk`
    )
  })

  it('cleans a fragment of ANY length, like the address bar strip does', () => {
    for (const body of ['', 'short', 'x'.repeat(16), 'y'.repeat(300)]) {
      const { win, replaceState } = windowWith(
        { current: `${PATH}#beai_rl_${body}` },
        { hash: `#beai_rl_${body}` }
      )

      captureReusableLinkFragment(win)

      expect(replaceState).toHaveBeenCalledWith({ current: PATH }, '', PATH)
      discardReusableLinkFragment()
    }
  })

  it.each([
    ['a state without the marker', { back: null, current: PATH, position: 1 }],
    ['a state with no `current`', { position: 1 }],
    ['a null state', null],
    ['a string state', `${PATH}#${REUSABLE_LINK_TOKEN}`],
    ['a number state', 7],
    ['an array state', [`${PATH}#${REUSABLE_LINK_TOKEN}`]],
    ['a non-string `current`', { current: 42 }],
    ['an object `current`', { current: { href: `${PATH}#${REUSABLE_LINK_TOKEN}` } }],
    [
      'a `current` that mentions the marker in its query string',
      { current: `${PATH}?next=${REUSABLE_LINK_TOKEN}` },
    ],
    [
      'a `current` that mentions the marker in its path',
      { current: `/page/${REUSABLE_LINK_TOKEN}` },
    ],
    [
      'a `current` whose fragment only CONTAINS the marker',
      { current: `/page#anchor-${REUSABLE_LINK_TOKEN}` },
    ],
    ['a `current` with another fragment', { current: `${PATH}#section-2` }],
  ])('passes %s through unchanged', (_name, state) => {
    const { win, replaceState } = windowWith(state)

    captureReusableLinkFragment(win)

    expect(replaceState).toHaveBeenCalledTimes(1)
    expect(replaceState.mock.calls[0]?.[0]).toBe(state)
    expect(replaceState.mock.calls[0]?.[2]).toBe(PATH)
  })

  it('does not call replaceState at all when there is no link fragment, whatever the state', () => {
    const { win, replaceState } = windowWith(
      { current: `${PATH}#${REUSABLE_LINK_TOKEN}` },
      { hash: '#section-2' }
    )

    captureReusableLinkFragment(win)

    expect(replaceState).not.toHaveBeenCalled()
  })
})
