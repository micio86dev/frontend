/**
 * The candidate frontend and its API must be ONE origin.
 *
 * `NUXT_PUBLIC_API_BASE` is shipped to the BROWSER by definition, so whatever it
 * holds has to be reachable from there. It held `http://api:8000/api` — correct
 * for SSR, which runs inside the Docker network, and unresolvable in a browser
 * running on the developer's machine.
 *
 * `pages/interview/[token].vue` is `ssr: false`, so the browser made that call.
 * It failed on DNS, and that page routes every non-401 failure to
 * `reason=403` — so a candidate opening a freshly generated, never-used link
 * was told their session was not authorised. The link was fine. The request
 * never left the laptop.
 *
 * One value cannot serve both sides: inside the container `localhost` is the
 * container itself, and a Docker hostname means nothing outside it. So the app
 * proxies `/api` on its OWN origin (`server/routes/api/[...].ts`), exactly as
 * the backoffice already does through nginx, and the browser makes no
 * cross-origin request at all.
 *
 * The backoffice protected this same invariant with an arch test from the
 * start; this app carried it with nothing underneath. "Someone sets the API
 * base back to an absolute URL later" was a real risk there and is the same
 * risk here — the difference was only that nobody had written this file.
 *
 * These assert the MECHANISM, not one deployment's values: that the proxy
 * route exists, that it reads its target from server-only runtime config, that
 * it refuses to run without one, and that the documented variable name is the
 * one Nuxt actually reads.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = (p: string) => resolve(__dirname, '../../..', p)
const PROXY = readFileSync(root('server/routes/api/[...].ts'), 'utf-8')
const NUXT_CONFIG = readFileSync(root('nuxt.config.ts'), 'utf-8')
const ENV_EXAMPLE = readFileSync(root('.env.example'), 'utf-8')

describe('the same-origin API mechanism cannot be quietly removed', () => {
  it('the catch-all proxy route exists', () => {
    expect(PROXY).toMatch(/defineEventHandler/)
    expect(PROXY).toMatch(/proxyRequest|sendProxy/)
  })

  it('the proxy target comes from SERVER-ONLY runtime config, never from public', () => {
    // `apiOrigin` sits outside `public` on purpose: it is a Docker-internal
    // hostname, and shipping it to the browser is the exact bug this proxy
    // removes. A `public.apiOrigin` would reintroduce it while every test here
    // still passed.
    expect(PROXY).toContain('useRuntimeConfig(event).apiOrigin')
    expect(NUXT_CONFIG).not.toMatch(/public:\s*\{[^}]*apiOrigin/)
  })

  it('the proxy refuses to run with no target rather than guessing one', () => {
    // Falling back to a default would turn a misconfiguration into a silent
    // wrong destination — which is how the original bug reached a candidate.
    expect(PROXY).toMatch(/createError|throw/)
    expect(PROXY).toContain('NUXT_API_ORIGIN')
  })

  it('the documented variable name is the one Nuxt reads', () => {
    // Nuxt maps ONLY `NUXT_`-prefixed variables onto runtimeConfig. The proxy's
    // 500 message and the config comment both said `BEAI_API_ORIGIN`, so an
    // operator would set that name, see the same 500, and have nothing to go
    // on. Compose hid it because the host-side variable happened to carry the
    // other name.
    expect(ENV_EXAMPLE).toContain('NUXT_API_ORIGIN=')
    expect(PROXY).not.toContain('BEAI_API_ORIGIN')
    expect(NUXT_CONFIG).not.toMatch(/Fed by BEAI_API_ORIGIN/)
  })

  it('the public API base is relative, so the browser stays same-origin', () => {
    // The value that actually ships. An absolute URL here is the regression
    // this whole file exists to catch.
    expect(ENV_EXAMPLE).toMatch(/^NUXT_PUBLIC_API_BASE=\/api$/m)
    expect(ENV_EXAMPLE).not.toMatch(/^NUXT_PUBLIC_API_BASE=https?:\/\//m)
  })
})
