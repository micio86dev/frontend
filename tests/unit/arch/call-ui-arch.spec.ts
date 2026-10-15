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
 *  2. (live-interview-call-chrome) The side panel names competencies - the "Percorso"
 *     storyboard shows the outline's NAMES - but never carries a competency CODE. It
 *     imports no session and reads no code field. (Reversed from "names no competency".)
 *  3. No literal user-visible string: every word on the call screen is an i18n key,
 *     so `it` and `en` can never drift from what is drawn.
 *  4. (live-interview-call-chrome) The live header is handed exactly the bindings it
 *     documents, Exit no longer reaches the panel, and the page has ONE timer role:
 *     the interview-time-remaining countdown. The header clock is a plain <time>.
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
        'components/molecules/CallAnswerTimer.vue',
        'components/molecules/CallExitDialog.vue',
        'components/molecules/CallHelpLink.vue',
        'components/molecules/CallQuestion.vue',
        'components/molecules/CallSelfView.client.vue',
        'components/molecules/CallStoryboard.vue',
        'components/molecules/CallTile.vue',
        'components/organisms/CallHeader.vue',
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

describe('call screen: the side panel names competencies but never carries a code', () => {
  const panelSource = stripComments(read(join(APP_ROOT, 'components/organisms/CallPanel.vue')))
  const storyboardSource = stripComments(
    read(join(APP_ROOT, 'components/molecules/CallStoryboard.vue'))
  )

  it.each([
    ['CallPanel', panelSource],
    ['CallStoryboard', storyboardSource],
  ])('%s has no code field and imports no session', (_name, source) => {
    expect(source).not.toMatch(/\bcode\b|competency_?code/i)
    expect(source).not.toMatch(/useInterviewSession|useCandidateSession|session\./)
  })

  it('the guard can fail: it recognises a code field in a source', () => {
    expect('const x = item.competency_code').toMatch(/\bcode\b|competency_?code/i)
    expect('<p>{{ row.code }}</p>').toMatch(/\bcode\b|competency_?code/i)
  })

  it('CallPanel only imports presentational pieces and the clock formatter', () => {
    // `[\s\S]*?` so a Prettier-wrapped, multi-line import is still seen: a guard that read only
    // one-line imports would let a wrapped one through.
    const imports = [...panelSource.matchAll(/^import [\s\S]*?from '([^']+)'/gm)].map((m) => m[1])

    expect(imports.sort()).toEqual(
      [
        'vue',
        '~/components/InterviewTimer.vue',
        '~/components/ProgressBar.vue',
        '~/components/molecules/CallAnswerTimer.vue',
        '~/components/molecules/CallStoryboard.vue',
        '~/app/composables/useInterviewClock',
      ].sort()
    )
  })

  it('the page gives the panel no exit slot: Exit moved to the call header', () => {
    const page = stripComments(read(join(APP_ROOT, 'components/InterviewSession.vue')))
    const block = page.match(/<CallPanel\b[\s\S]*?<\/CallPanel>/)

    expect(block).not.toBeNull()
    expect(block![0]).not.toMatch(/#exit|v-slot:exit|CallExitDialog/)
    expect(panelSource).not.toMatch(/<slot name="exit"/)
  })

  it('the page binds the panel to exactly its documented props and events, none a competency', () => {
    const page = stripComments(read(join(APP_ROOT, 'components/InterviewSession.vue')))
    const tag = page.match(/<CallPanel\b[^>]*?(?:\/>|>)(?=[\s\S]*<\/CallPanel>)/)

    expect(tag).not.toBeNull()
    // `endedCompetencies` / `totalCompetencies` are COUNTS; a competency's code is not.
    expect(tag![0]).not.toMatch(/competency|\bcode\b/i)
    const bound = [...tag![0].matchAll(/(?::|@)([a-z-]+)=/g)].map((m) => m[1]).sort()
    expect(bound).toEqual(
      [
        'elapsed-seconds',
        'answer-phase',
        'answer-seconds',
        'budget',
        'ended',
        'expired',
        'max-seconds',
        'mic-muted',
        'primary-index',
        'question-seconds',
        'storyboard',
        'tick',
        'timer-key',
        'total',
      ].sort()
    )
  })

  /**
   * The one sanctioned reader: the exit dialog states the resume deadline, and
   * `useCandidateSession().read()` is the only place that value may come from. It reads
   * nothing about a competency. No other call component may import it.
   */
  const CANDIDATE_SESSION_READER = 'components/molecules/CallExitDialog.vue'

  it.each(CALL_COMPONENTS.map((file) => [name(file), file]))(
    '%s imports no interview session or outline composable',
    (_name, file) => {
      expect(stripComments(read(file))).not.toMatch(/useInterviewSession|useInterviewOutline/)
    }
  )

  it.each(CALL_COMPONENTS.map((file) => [name(file), file]))(
    '%s imports the candidate session only if it is the exit dialog',
    (fileName, file) => {
      const imports = /useCandidateSession/.test(stripComments(read(file)))

      expect(imports).toBe(fileName === CANDIDATE_SESSION_READER)
    }
  )
})

describe('call screen: the live header', () => {
  const page = stripComments(read(join(APP_ROOT, 'components/InterviewSession.vue')))

  it('the page binds <CallHeader> to exactly its documented props and events', () => {
    const tag = page.match(/<CallHeader\b[^>]*>/)

    expect(tag).not.toBeNull()
    const bound = [...tag![0].matchAll(/(?::|@)([a-z-]+)=/g)].map((m) => m[1]).sort()
    expect(bound).toEqual(
      [
        'captions-enabled',
        'elapsed-seconds',
        'mic-disabled',
        'mic-muted',
        'title',
        'toggle-captions',
        'toggle-mic',
      ].sort()
    )
  })

  it('hands the header the VISUAL microphone state and disables it for any forced mute', () => {
    const tag = page.match(/<CallHeader\b[^>]*>/)![0]

    expect(tag).toMatch(
      /:mic-muted="session\.micMuted\.value \|\| session\.handoverInFlight\.value"/
    )
    expect(tag).toMatch(/:mic-disabled="session\.handoverInFlight\.value"/)
  })

  it('has exactly one role="timer" under app/components, in InterviewTimer', () => {
    const withRole = collect(join(APP_ROOT, 'components')).filter((file) =>
      /\brole=["']timer["']/.test(stripComments(read(file)))
    )

    expect(withRole.map(name)).toEqual(['components/InterviewTimer.vue'])
    expect(
      stripComments(read(join(APP_ROOT, 'components/InterviewTimer.vue'))).match(/role="timer"/g)
    ).toHaveLength(1)
  })

  it('draws the clock with a plain <time>, never a timer role or a live region', () => {
    const header = stripComments(read(join(APP_ROOT, 'components/organisms/CallHeader.vue')))

    expect(header).toMatch(/<time>/)
    expect(header).not.toMatch(/role=|aria-live/)
  })
})

describe('call screen: the answer timer', () => {
  const page = stripComments(read(join(APP_ROOT, 'components/InterviewSession.vue')))
  const answerTimer = stripComments(
    read(join(APP_ROOT, 'components/molecules/CallAnswerTimer.vue'))
  )

  it('draws its figure with a plain <time>, never a timer role, status role or live region', () => {
    expect(answerTimer).toMatch(/<time\b/)
    expect(answerTimer).not.toMatch(/role="(?:timer|status|alert|log)"|aria-live/)
  })

  it('the page hands the panel the candidate INTENT, not the visual state, for the muted hint', () => {
    const tag = page.match(/<CallPanel\b[^>]*?(?:\/>|>)(?=[\s\S]*<\/CallPanel>)/)![0]

    expect(tag).toMatch(/:mic-muted="session\.micMuted\.value"/)
    expect(tag).not.toMatch(/handoverInFlight/)
  })

  it('the page, not a call component, owns the timer: none of them calls useAnswerTimer or answerBudget', () => {
    expect(page).toMatch(/useAnswerTimer\(/)
    for (const file of CALL_COMPONENTS) {
      expect(stripComments(read(file))).not.toMatch(/\b(?:useAnswerTimer|answerBudget)\(/)
    }
  })

  it('the answer timer and the budget never reach /end: the page wires them to the panel only', () => {
    const timerBlock = page.match(/const answerTimer = useAnswerTimer\([\s\S]*?\n\}\)/)![0]
    const budgetBlock = page.match(/const budget = computed\([\s\S]*?\n\)/)![0]

    expect(timerBlock + budgetBlock).not.toMatch(/endInterview|\/end|onTimerExpired|timeout/)
  })
})

describe('call screen: the captions overlay lives inside the avatar layer', () => {
  /** A minimal view of a template AST node: elements have `tag`, `props` and `children`. */
  type Node = {
    type: number
    tag?: string
    props?: Array<{ type: number; name: string; value?: { content: string } }>
    children?: Node[]
  }

  const walk = (
    node: Node,
    visit: (n: Node, ancestors: Node[]) => void,
    ancestors: Node[] = []
  ) => {
    visit(node, ancestors)
    for (const child of node.children ?? []) walk(child, visit, [...ancestors, node])
  }

  const root = () => {
    const { descriptor } = parse(read(join(APP_ROOT, 'components/InterviewSession.vue')))
    return descriptor.template!.ast as unknown as Node
  }

  const isAvatarLayer = (n: Node) =>
    n.tag === 'div' &&
    (n.props ?? []).some(
      (p) => p.type === 6 && p.name === 'data-slot' && p.value?.content === 'avatar-layer'
    )

  it('renders <CallQuestion> exactly once, inside the avatar-layer element, and nowhere else', () => {
    const found: Node[][] = []
    walk(root(), (n, ancestors) => {
      if (n.tag === 'CallQuestion') found.push(ancestors)
    })

    expect(found).toHaveLength(1)
    expect(found[0]!.some(isAvatarLayer)).toBe(true)
  })

  it('has the layer itself inside the CallStage layer slot, so the captions cannot leave the video', () => {
    let layerAncestors: Node[] = []
    walk(root(), (n, ancestors) => {
      if (isAvatarLayer(n)) layerAncestors = ancestors
    })

    expect(layerAncestors.some((n) => n.tag === 'CallStage')).toBe(true)
  })

  it('has the own tile inside the avatar layer, so it can only ever overlay the video', () => {
    const found: Node[][] = []
    walk(root(), (n, ancestors) => {
      if (n.tag === 'CallSelfView') found.push(ancestors)
    })

    expect(found).toHaveLength(1)
    expect(found[0]!.some(isAvatarLayer)).toBe(true)
  })

  it('no #question slot remains: not in the page, not in the stage', () => {
    const page = stripComments(read(join(APP_ROOT, 'components/InterviewSession.vue')))
    const stage = stripComments(read(join(APP_ROOT, 'components/organisms/CallStage.vue')))

    expect(page).not.toMatch(/#question\b|v-slot:question\b/)
    expect(stage).not.toMatch(/name="question"|\[grid-area:question\]|call-stage-question/)
    expect(stage).not.toMatch(/'question/)
  })

  it('the guard can fail: it recognises the avatar-layer element in a template', () => {
    const { descriptor } = parse(
      '<template><div data-slot="avatar-layer"><CallQuestion /></div></template>'
    )
    const ast = descriptor.template!.ast as unknown as Node
    const hits: boolean[] = []
    walk(ast, (n) => {
      if (isAvatarLayer(n)) hits.push(true)
    })

    expect(hits).toEqual([true])
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
