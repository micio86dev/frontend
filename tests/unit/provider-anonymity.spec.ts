import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HeyGenProvider } from '~/app/providers/heygen'
import { TavusProvider } from '~/app/providers/tavus'

/**
 * Nothing a candidate can READ names the provider (C14 PR6).
 *
 * An honest scope, because the alternative is a promise that cannot be kept:
 * the SDK executes in the candidate's own browser, so anyone who opens devtools
 * can see a `daily.co` host, a `window._daily` global, or a LiveKit signalling
 * connection. Proxying every media and signalling host is a different product.
 *
 * What IS achievable, and what these tests hold to: nothing in the PRODUCT —
 * no rendered text, no error message, no i18n string, no attribute the page
 * itself sets — names the vendor. A candidate who is simply taking an interview
 * never learns it, and nobody learns it by accident.
 */

const VENDORS = /heygen|liveavatar|tavus|daily\.?co|livekit/i

function repoFile(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8')
}

describe("provider errors carry a code, not the vendor's words", () => {
  it('Tavus reports a stable code when the SDK fails', async () => {
    const errors: Array<{ code: string; message?: string }> = []
    const provider = new TavusProvider(
      vi.fn().mockRejectedValue(new Error('Daily.co: failed to join room at tavus.daily.co'))
    )
    provider.on('error', (e) => errors.push(e as { code: string; message?: string }))

    const mount = document.createElement('div')
    mount.appendChild(document.createElement('video'))
    await provider.start(mount, {
      dbSessionId: 1,
      conversationUrl: 'https://tavus.daily.co/x',
      endPhrase: 'a',
      finalPhrase: 'b',
    })

    // An earlier version carried String(err) here while a comment above it
    // claimed otherwise. Nothing renders `message` today — but a message that
    // exists is a message something eventually renders.
    expect(errors[0]?.code).toBe('sdk_error')
    expect(JSON.stringify(errors[0])).not.toMatch(VENDORS)
  })

  it('HeyGen reports a stable code when the SDK fails', async () => {
    const errors: unknown[] = []
    const provider = new HeyGenProvider(
      vi.fn().mockRejectedValue(new Error('LiveAvatar rejected the token request'))
    )
    provider.on('error', (e) => errors.push(e))

    await provider.start(document.createElement('div'), {
      dbSessionId: 1,
      sessionToken: 'tok',
      endPhrase: 'a',
      finalPhrase: 'b',
    })

    expect(JSON.stringify(errors)).not.toMatch(VENDORS)
  })
})

describe('no user-facing string names a provider', () => {
  it('the Italian locale is clean', () => {
    // The i18n files ARE the product's words. A vendor name reaching one is the
    // single most direct way the candidate finds out, and it survives every
    // amount of care taken in the components.
    expect(repoFile('i18n/locales/it.json')).not.toMatch(VENDORS)
  })

  it('the English locale is clean', () => {
    expect(repoFile('i18n/locales/en.json')).not.toMatch(VENDORS)
  })

  it('the interview page renders no vendor name', () => {
    // The template, not the rendered DOM: a runtime assertion only covers the
    // states a test happens to drive through, while the source covers all of
    // them. Comments count — they end up in nothing shipped, but a developer
    // copying a nearby line does.
    const page = repoFile('app', 'pages', 'interview', '[token].vue')

    expect(page).not.toMatch(VENDORS)
  })

  it('the avatar player renders no vendor name', () => {
    expect(repoFile('app', 'components', 'AvatarPlayer.client.vue')).not.toMatch(VENDORS)
  })
})

describe('the SDKs stay in their own lazy chunks', () => {
  it('neither provider imports an SDK at module scope', () => {
    // Verified in the built bundle too: each SDK lands in its own async chunk
    // (256K daily, 512K heygen) reached only by a dynamic import, so a
    // candidate on HeyGen never downloads a byte of Daily.
    //
    // Asserted at source because a bundle assertion needs a build, and this is
    // the property that keeps the bundle honest — a static import at the top of
    // either file collapses both SDKs into one chunk and every candidate
    // downloads both.
    for (const file of ['heygen.ts', 'tavus.ts']) {
      const source = repoFile('app', 'providers', file)
      const importLines = source
        .split('\n')
        .filter((line) => /^import\s/.test(line))
        .join('\n')

      expect(importLines).not.toMatch(/@daily-co|@heygen/)
    }
  })
})
