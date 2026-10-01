/**
 * Every locale message must COMPILE with the vue-i18n message compiler.
 *
 * `i18n/locales/*.json` look like plain strings, but at BUILD time
 * `unplugin-vue-i18n` compiles each one with vue-i18n's message format, in which
 * `@` (linked messages), `{`, `}`, `|` and `$` are syntax. A message that merely
 * contains an email example such as `name@example.com` therefore fails the whole
 * production build ("error code: 10", the `@` read as the start of a linked
 * message), while every unit test that reads the raw JSON stays green. This spec
 * runs the same compiler over every message in every locale, so that class of
 * failure shows up here and not in a Docker build or an end-to-end run.
 *
 * A literal `@` is written `{'@'}` in the JSON.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { baseCompile } from '@intlify/message-compiler'

type Messages = Record<string, unknown>

function loadLocale(locale: string): Messages {
  const raw = readFileSync(resolve(__dirname, `../../i18n/locales/${locale}.json`), 'utf-8')

  return JSON.parse(raw) as Messages
}

function flatten(messages: Messages, prefix = ''): Array<[string, string]> {
  return Object.entries(messages).flatMap(([key, value]) =>
    value !== null && typeof value === 'object'
      ? flatten(value as Messages, `${prefix}${key}.`)
      : [[`${prefix}${key}`, String(value)] as [string, string]]
  )
}

/** The compile errors vue-i18n would report for one message, as "code: message". */
function compileErrors(source: string): string[] {
  const errors: string[] = []

  baseCompile(source, {
    onError: (error) => {
      errors.push(`${error.code}: ${error.message}`)
    },
  })

  return errors
}

describe('every locale message compiles with the vue-i18n message compiler', () => {
  for (const locale of ['en', 'it']) {
    it(`${locale}.json has no message the build would refuse`, () => {
      const broken = flatten(loadLocale(locale))
        .map(([path, source]) => ({ path, source, errors: compileErrors(source) }))
        .filter((entry) => entry.errors.length > 0)
        .map((entry) => `${entry.path} -> ${entry.errors.join('; ')}  [${entry.source}]`)

      expect(broken).toEqual([])
    })
  }

  it('does catch the bare-@ email example that broke the production build', () => {
    // The compiler's own verdict on the string that shipped, so a green run above
    // means something: this is the shape of message it must refuse.
    expect(compileErrors('Enter a valid email address, like name@example.com.')).not.toEqual([])
  })

  it("accepts the same sentence with the @ written as {'@'}", () => {
    expect(compileErrors("Enter a valid email address, like name{'@'}example.com.")).toEqual([])
  })
})
