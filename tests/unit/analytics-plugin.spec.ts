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

// happy-dom refuses (and logs) real script loads, so injected tags are captured
// instead of attached; getElementById sees them so the duplicate guard is real.
const injected: HTMLScriptElement[] = []
const scripts = () => injected.map((s) => s.id)

describe('analytics.client plugin', () => {
  beforeEach(() => {
    const add = window.addEventListener.bind(window)
    vi.spyOn(window, 'addEventListener').mockImplementation(((t: string, f: EventListener) => {
      listeners.push([t, f])
      add(t, f)
    }) as typeof window.addEventListener)
    injected.length = 0
    vi.spyOn(document.head, 'appendChild').mockImplementation(((n: HTMLScriptElement) => {
      injected.push(n)
      return n
    }) as typeof document.head.appendChild)
    vi.spyOn(document, 'getElementById').mockImplementation(
      (id: string) => injected.find((s) => s.id === id) ?? null
    )
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

    injected.length = 0
    delete window.clarity
    setup({ clarity: 'c1', path: '/interview/tok' })
    await run()
    expect(scripts()).toEqual([])
  })

  it('starts loading when consent is granted mid-visit', async () => {
    setup({ ga: 'G-1' })
    await run()
    expect(scripts()).toEqual([])

    window.dispatchEvent(new Event(ANALYTICS_CONSENT_EVENT))
    expect(scripts()).toEqual(['beai-ga4'])
  })

  it('sends only the redacted path on navigation, and nothing before gtag exists', async () => {
    const { hooks } = setup({ ga: 'G-1' })
    await run()
    hooks[0]!({ fullPath: '/interview/tok' })
    expect(window.gtag).toBeUndefined()

    window.gtag = vi.fn()
    hooks[0]!({ fullPath: '/en/interview/SECRET.jwt.sig?next=1#frag' })
    expect(window.gtag).toHaveBeenCalledWith('event', 'page_view', {
      page_path: '/en/interview/:token',
      page_location: '',
    })
  })

  it('stops a running Clarity when navigating onto an interview route, but not elsewhere', async () => {
    localStorage.setItem(ANALYTICS_CONSENT_KEY, 'granted')
    const { hooks } = setup({ clarity: 'c1' })
    await run()
    const clarity = vi.fn()
    window.clarity = clarity

    hooks[1]!({ fullPath: '/' })
    expect(clarity).not.toHaveBeenCalled()

    hooks[1]!({ fullPath: '/interview/tok' })
    expect(clarity).toHaveBeenCalledWith('stop')
  })

  it('does nothing on navigation when Clarity is not running', async () => {
    const { hooks } = setup({ clarity: 'c1' })
    await run()
    expect(() => hooks[1]!({ fullPath: '/interview/tok' })).not.toThrow()
  })
})
