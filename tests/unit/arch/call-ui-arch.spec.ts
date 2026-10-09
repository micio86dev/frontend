/**
 * call-ui-arch.spec.ts
 *
 * Architecture guard for the candidate call screen (change
 * `candidate-interview-call-ui`, UI-09). Three rules that a unit test of one
 * component cannot hold, because each is about what the components are NOT
 * allowed to contain:
 *
 *  1. Embedded, the stage is width-driven. The host page sizes the iframe from the
 *     height the embed page reports, so a layout that depends on the iframe's own
 *     height (`vh`, `dvh`, `svh`) never settles. The only viewport-height rule is
 *     the hosted cap in `CallStage`, and the embedded branch must not be able to
 *     reach it.
 *  2. The side panel is handed progress NUMBERS. It imports no session and reads no
 *     competency field, and the page gives it none: a candidate must not learn
 *     which competency is being assessed.
 *  3. No literal user-visible string: every word on the call screen is an i18n key,
 *     so `it` and `en` can never drift from what is drawn.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from '@vue/compiler-sfc'

const APP_ROOT = join(__dirname, '../../../app')

function collect(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...collect(full))
    else if (/\.vue$/.test(entry)) files.push(full)
  }
  return files
}

/** The call screen's own components: every `Call*.vue` under `app/components`. */
const CALL_COMPONENTS = collect(join(APP_ROOT, 'components')).filter((file) =>
  /\/Call[A-Z][A-Za-z]*(?:\.client)?\.vue$/.test(file)
)
const name = (file: string) => relative(APP_ROOT, file)
const read = (file: string) => readFileSync(file, 'utf-8')

/** Comments explain why a rule exists and may well name the thing it forbids. */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('the call screen: the components under guard', () => {
  it('finds every call component, so no rule below passes by checking nothing', () => {
    expect(CALL_COMPONENTS.map(name).sort()).toEqual(
      [
        'components/molecules/CallExitDialog.vue',
        'components/molecules/CallHelpLink.vue',
        'components/molecules/CallQuestion.vue',
        'components/molecules/CallSelfView.client.vue',
        'components/molecules/CallTile.vue',
        'components/organisms/CallPanel.vue',
        'components/organisms/CallStage.vue',
      ].sort()
    )
  })
})

describe('call screen: no viewport-height unit in the embedded branch', () => {
  /** `100dvh`, `50vh`, `h-screen`, `min-h-dvh`: anything whose size follows the viewport's height. */
  const VIEWPORT_HEIGHT =
    /\d(?:vh|dvh|svh|lvh)(?![a-z])|\b(?:min-|max-)?h-(?:screen|dvh|svh|lvh)\b/i

  /** The one place a viewport-height unit may appear: the hosted cap in CallStage. */
  const HOSTED_CAP = /const HOSTED_HEIGHT_CAP = \[[\s\S]*?\n\]/

  it.each(CALL_COMPONENTS.map((file) => [name(file), file]))(
    '%s has no viewport-height unit outside the hosted cap',
    (_name, file) => {
      const code = stripComments(read(file)).replace(HOSTED_CAP, '')

      expect(code).not.toMatch(VIEWPORT_HEIGHT)
    }
  )

  it('CallStage reaches the hosted cap only when it is not embedded', () => {
    const source = stripComments(read(join(APP_ROOT, 'components/organisms/CallStage.vue')))

    expect(source).toMatch(HOSTED_CAP)
    expect(source).toMatch(/props\.embedded \? \[\] : HOSTED_HEIGHT_CAP/)
    // Its declaration and exactly one use: a second reference would be a second way to reach it.
    expect(source.match(/HOSTED_HEIGHT_CAP/g)).toHaveLength(2)
  })
})

describe('call screen: the side panel never receives or reads a competency', () => {
  const panelSource = stripComments(read(join(APP_ROOT, 'components/organisms/CallPanel.vue')))

  it('CallPanel names no competency field and imports no session', () => {
    expect(panelSource).not.toMatch(/competency/i)
    expect(panelSource).not.toMatch(/useInterviewSession|useCandidateSession|session\./)
  })

  it('CallPanel only imports presentational pieces and the clock formatter', () => {
    const imports = [...panelSource.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])

    expect(imports.sort()).toEqual(
      [
        'vue',
        '~/app/components/InterviewTimer.vue',
        '~/app/components/ProgressBar.vue',
        '~/app/composables/useInterviewClock',
      ].sort()
    )
  })

  it('the page binds the panel to numbers and the counter only', () => {
    const page = stripComments(read(join(APP_ROOT, 'components/InterviewSession.vue')))
    const tag = page.match(/<CallPanel\b[^>]*?(?:\/>|>)(?=[\s\S]*<\/CallPanel>)/)

    expect(tag).not.toBeNull()
    // `endedCompetencies` / `totalCompetencies` are COUNTS; a competency's code or name is not.
    expect(tag![0]).not.toMatch(/competency/i)
    const bound = [...tag![0].matchAll(/(?::|@)([a-z-]+)=/g)].map((m) => m[1]).sort()
    expect(bound).toEqual(
      [
        'elapsed-seconds',
        'ended',
        'expired',
        'question-seconds',
        'tick',
        'timer-key',
        'total',
      ].sort()
    )
  })
})

describe('call screen: no literal user-visible string', () => {
  /** Attributes a screen reader or a tooltip turns into words. */
  const SPOKEN_ATTRIBUTES = new Set([
    'aria-label',
    'aria-description',
    'title',
    'alt',
    'placeholder',
  ])

  /** Text nodes and static spoken attributes of a component's template. */
  function literals(file: string): string[] {
    const { descriptor } = parse(read(file))
    const found: string[] = []
    const visit = (node: unknown): void => {
      const n = node as {
        type: number
        content?: string
        props?: Array<{ type: number; name: string; value?: { content: string } }>
        children?: unknown[]
      }
      // 2 = TEXT. Interpolations (5) are expressions, not literals.
      if (n.type === 2 && n.content?.trim()) found.push(n.content.trim())
      // 6 = ATTRIBUTE (a static one: `:aria-label` is a DIRECTIVE, type 7).
      for (const prop of n.props ?? []) {
        if (prop.type === 6 && SPOKEN_ATTRIBUTES.has(prop.name) && prop.value?.content.trim()) {
          found.push(`${prop.name}="${prop.value.content}"`)
        }
      }
      for (const child of n.children ?? []) visit(child)
    }
    if (descriptor.template?.ast) visit(descriptor.template.ast)
    return found
  }

  it.each(CALL_COMPONENTS.map((file) => [name(file), file]))(
    '%s renders only i18n keys, never a literal word',
    (_name, file) => {
      expect(literals(file)).toEqual([])
    }
  )

  it('the check can fail: it sees a literal text node and a static aria-label', () => {
    // Guards the guard: a walker that visited nothing would pass every component.
    const { descriptor } = parse('<template><p aria-label="Hello">World</p></template>')
    const ast = descriptor.template!.ast as unknown as {
      children: Array<{ props: unknown[]; children: unknown[] }>
    }

    expect(ast.children[0]!.props).toHaveLength(1)
    expect(ast.children[0]!.children).toHaveLength(1)
  })
})
