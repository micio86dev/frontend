import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANALYTICS_CONSENT_EVENT, ANALYTICS_CONSENT_KEY } from '~/app/utils/analytics-consent'

type Hook = (to: { fullPath: string }) => void

/**
 * The plugin holds no policy (analyticsPlan does); what is asserted here is the
 * wiring: nothing loads without consent, a late grant loads it, the redacted
 * path is what reaches gtag, and Clarity is stopped on an interview route.
 */
function setup(opts: { ga?: string; clarity?: string; path?: string } = {}) {
  const hooks: Hook[] = []
  const router = {
    currentRoute: { value: { fullPath: opts.path ?? '/' } },
    afterEach: (h: Hook) => hooks.push(h),
  }
  vi.stubGlobal('defineNuxtPlugin', (fn: () => void) => fn)
  vi.stubGlobal('useRouter', () => router)
  vi.stubGlobal('useRuntimeConfig', () => ({
    public: { gaMeasurementId: opts.ga ?? '', clarityProjectId: opts.clarity ?? '' },
  }))
  return { hooks, router }
}

async function run(): Promise<void> {
  vi.resetModules()
  const mod = (await import('~/app/plugins/analytics.client')) as { default: () => void }
  mod.default()
}

const listeners: [string, EventListener][] = []

// What the plugin put in <head>, observed from the DOM itself (any insertion
// path: appendChild, append, insertBefore...). happy-dom is told not to fetch
// them, so nothing is loaded or logged but the nodes are really attached.
const scripts = () => Array.from(document.head.querySelectorAll('script[id]')).map((s) => s.id)

// The router calls every registered afterEach hook; the plugin's hooks are
// exercised by behaviour, never by their registration order.
const navigate = (hooks: Hook[], fullPath: string) => hooks.forEach((h) => h({ fullPath }))

const dataLayerCalls = () =>
  (window.dataLayer ?? []).map((a) => Array.from(a as ArrayLike<unknown>))

describe('analytics.client plugin', () => {
  let fileLoading: boolean
  let asSuccess: boolean
  beforeEach(() => {
    const add = window.addEventListener.bind(window)
    vi.spyOn(window, 'addEventListener').mockImplementation(((t: string, f: EventListener) => {
      listeners.push([t, f])
      add(t, f)
    }) as typeof window.addEventListener)
    fileLoading = window.happyDOM.settings.disableJavaScriptFileLoading
    asSuccess = window.happyDOM.settings.handleDisabledFileLoadingAsSuccess
    window.happyDOM.settings.disableJavaScriptFileLoading = true
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    document.head.querySelectorAll('script[id]').forEach((n) => n.remove())
    localStorage.clear()
    delete window.gtag
    delete window.clarity
    delete window.dataLayer
  })
  afterEach(() => {
    // Each run() registers a window listener bound to that run's config; drop
    // them so a later test's consent event does not wake an earlier plugin.
    for (const [type, fn] of listeners) window.removeEventListener(type, fn)
    listeners.length = 0
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    window.happyDOM.settings.disableJavaScriptFileLoading = fileLoading
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = asSuccess
    document.head.querySelectorAll('script[id]').forEach((n) => n.remove())
  })

  it('loads nothing without consent', async () => {
    setup({ ga: 'G-1', clarity: 'c1' })
    await run()
    expect(scripts()).toEqual([])
    expect(window.gtag).toBeUndefined()
  })

  it('loads GA4 with advertising signals denied when consent is already stored', async () => {
    localStorage.setItem(ANALYTICS_CONSENT_KEY, 'granted')
    setup({ ga: 'G-1', path: '/interview/eyJ.abc.def?x=1' })
    await run()

    expect(scripts()).toEqual(['beai-ga4'])
    const calls = (window.dataLayer ?? []).map((a) => Array.from(a as ArrayLike<unknown>))
    expect(calls).toContainEqual([
      'consent',
      'default',
      expect.objectContaining({ ad_storage: 'denied', analytics_storage: 'granted' }),
    ])
    expect(calls).toContainEqual([
      'config',
      'G-1',
      expect.objectContaining({ page_path: '/interview/:token', page_location: '' }),
    ])
  })

  it('does not inject the same script twice when consent fires after a load', async () => {
    localStorage.setItem(ANALYTICS_CONSENT_KEY, 'granted')
    setup({ ga: 'G-1' })
    await run()
    window.dispatchEvent(new Event(ANALYTICS_CONSENT_EVENT))
    expect(scripts()).toEqual(['beai-ga4'])
  })

  it('starts Clarity (stub first) on a safe route and never on an interview route', async () => {
    localStorage.setItem(ANALYTICS_CONSENT_KEY, 'granted')
    setup({ clarity: 'c1', path: '/' })
    await run()
    expect(scripts()).toEqual(['beai-clarity'])
    expect(typeof window.clarity).toBe('function')

    document.head.querySelectorAll('script[id]').forEach((n) => n.remove())
    delete window.clarity
    setup({ clarity: 'c1', path: '/interview/tok' })
    await run()
    expect(scripts()).toEqual([])
    expect(window.clarity).toBeUndefined()
  })

  it('starts loading when consent is granted mid-visit', async () => {
    setup({ ga: 'G-1' })
    await run()
    expect(scripts()).toEqual([])

    window.dispatchEvent(new Event(ANALYTICS_CONSENT_EVENT))
    expect(scripts()).toEqual(['beai-ga4'])
  })

  it('sends no page view before gtag exists (no consent, nothing loaded)', async () => {
    const { hooks } = setup({ ga: 'G-1' })
    await run()
    navigate(hooks, '/interview/tok')
    expect(window.gtag).toBeUndefined()
    expect(window.dataLayer).toBeUndefined()
  })

  it('sends only the redacted path as a page view on navigation once consent is granted', async () => {
    localStorage.setItem(ANALYTICS_CONSENT_KEY, 'granted')
    const { hooks } = setup({ ga: 'G-1' })
    await run()
    expect(typeof window.gtag).toBe('function')
    const before = dataLayerCalls().length

    navigate(hooks, '/en/interview/SECRET.jwt.sig?next=1#frag')

    const sent = dataLayerCalls().slice(before)
    expect(sent).toEqual([
      ['event', 'page_view', { page_path: '/en/interview/:token', page_location: '' }],
    ])
    expect(JSON.stringify(window.dataLayer)).not.toContain('SECRET')
  })

  it('stops a running Clarity when navigating onto an interview route, but not elsewhere', async () => {
    localStorage.setItem(ANALYTICS_CONSENT_KEY, 'granted')
    const { hooks } = setup({ clarity: 'c1' })
    await run()
    const queued = () =>
      ((window.clarity as unknown as { q: ArrayLike<unknown>[] }).q ?? []).map((a) => Array.from(a))

    navigate(hooks, '/')
    expect(queued()).not.toContainEqual(['stop'])

    navigate(hooks, '/interview/tok')
    expect(queued()).toContainEqual(['stop'])
  })

  it('does nothing on navigation when Clarity is not running', async () => {
    const { hooks } = setup({ clarity: 'c1' })
    await run()
    expect(window.clarity).toBeUndefined()
    expect(() => navigate(hooks, '/interview/tok')).not.toThrow()
    expect(window.clarity).toBeUndefined()
  })
})
