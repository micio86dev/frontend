import { vi } from 'vitest'
import { ref, computed, reactive, watch, watchEffect, nextTick, toRef, toRefs } from 'vue'

// Expose Vue reactivity APIs as globals — Nuxt auto-imports them but Vitest doesn't
vi.stubGlobal('ref', ref)
vi.stubGlobal('computed', computed)
vi.stubGlobal('reactive', reactive)
vi.stubGlobal('watch', watch)
vi.stubGlobal('watchEffect', watchEffect)
vi.stubGlobal('nextTick', nextTick)
vi.stubGlobal('toRef', toRef)
vi.stubGlobal('toRefs', toRefs)

// Nuxt auto-import. Stubbed here rather than per-spec because it is a global
// in the running app: any component may call it, and a spec that mounts one
// should not have to know whether it does. A page adding useI18n() for a
// localized document title should not break nine unrelated specs.
vi.stubGlobal(
  'useI18n',
  vi.fn(() => ({ t: (key: string) => key, locale: ref('it') }))
)

// Nuxt auto-import, stubbed globally for the same reason as useI18n above:
// app.vue reads the route to tell the consent banner where it is, and a spec
// that mounts the app shell should not have to know that.
vi.stubGlobal(
  'useRoute',
  vi.fn(() => ({ fullPath: '/', path: '/', params: {}, query: {} }))
)

// Stub Nuxt compiler macros that are unavailable in Vitest context
vi.stubGlobal('definePageMeta', vi.fn())
vi.stubGlobal('useHead', vi.fn())
vi.stubGlobal(
  'useRuntimeConfig',
  vi.fn(() => ({ public: { apiBase: '', appEnv: 'local' } }))
)
vi.stubGlobal(
  'useNuxtApp',
  vi.fn(() => ({}))
)

// Stub Nitro server utilities (used in server/routes/)
// defineEventHandler wraps the handler fn — in tests we call it directly
vi.stubGlobal(
  'defineEventHandler',
  // Pass-through: returns the handler function itself so tests can invoke it
  (handler: (..._args: unknown[]) => unknown) => handler
)

// Nuxt auto-import. This app is ssr:false on /interview/**, so the real
// useCookie only ever runs client-side — this stub mirrors that: it reads/
// writes document.cookie directly (happy-dom supports it) through a reactive
// ref, JSON-encoding non-string values the same way Nuxt's default codec
// does. `path`/`maxAge` are honored (observable via document.cookie); Nuxt
// itself is the one that turns `secure`/`sameSite`/`httpOnly` into real
// Set-Cookie semantics in a browser — a stub cannot demonstrate a browser
// security attribute, so those options are accepted but not re-verified here.
vi.stubGlobal(
  'useCookie',
  vi.fn(<T>(name: string, opts: { default?: () => T; path?: string; maxAge?: number } = {}) => {
    function readRaw(): string | undefined {
      const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))
      return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined
    }
    function parse(raw: string | undefined): T {
      if (raw === undefined) return opts.default ? opts.default() : (undefined as T)
      try {
        return JSON.parse(raw) as T
      } catch {
        return raw as unknown as T
      }
    }
    const cookieRef = ref(parse(readRaw())) as { value: T }
    watch(
      cookieRef,
      (value) => {
        if (value === undefined || value === null) {
          document.cookie = `${name}=; path=${opts.path ?? '/'}; max-age=0`
          return
        }
        const serialized = typeof value === 'string' ? value : JSON.stringify(value)
        let str = `${name}=${encodeURIComponent(serialized)}; path=${opts.path ?? '/'}`
        if (opts.maxAge) str += `; max-age=${opts.maxAge}`
        document.cookie = str
      },
      // sync flush: the real client-side useCookie write is effectively
      // synchronous from the caller's perspective (document.cookie is set
      // before the next microtask); tests assert on document.cookie
      // immediately after a `.value =` write, so this stub must match.
      { deep: true, flush: 'sync' }
    )
    return cookieRef
  })
)
