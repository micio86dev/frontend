import { describe, it, expect } from 'vitest'
import golden from '../fixtures/tavus/boundary_interaction_golden.json'
import { asCompetencyCode } from '~/utils/competency-codes'
import {
  ADVANCE_TEMPLATE,
  RESPOND_TEXT,
  buildAdvancePayload,
  createBoundaryTicket,
  type TavusBoundaryTicket,
} from '~/utils/advance-interaction'

const ticketFor = (raw: string, conversationId = 'c0golden') => {
  const code = asCompetencyCode(raw)
  if (!code) throw new Error(`invalid test code ${raw}`)
  return createBoundaryTicket(conversationId, code)
}

const [HEAD, TAIL] = ADVANCE_TEMPLATE.split('%s') as [string, string]
const FIXED_APPEND_LENGTH = (code: string) =>
  JSON.stringify({
    message_type: 'conversation',
    event_type: 'conversation.append_llm_context',
    conversation_id: 'c0golden',
    properties: { context: HEAD + TAIL },
  }).length + code.length

describe('buildAdvancePayload', () => {
  it('matches the golden for BOTH messages, append then respond', () => {
    expect(JSON.parse(JSON.stringify(buildAdvancePayload(ticketFor('INN'))))).toEqual(golden)
  })

  it('has the exact key sets on both envelopes', () => {
    const [append, respond] = buildAdvancePayload(ticketFor('INN'))
    expect(Object.keys(append).sort()).toEqual([
      'conversation_id',
      'event_type',
      'message_type',
      'properties',
    ])
    expect(Object.keys(append.properties)).toEqual(['context'])
    expect(Object.keys(respond).sort()).toEqual([
      'conversation_id',
      'event_type',
      'message_type',
      'properties',
    ])
    expect(Object.keys(respond.properties)).toEqual(['text'])
  })

  it.each(['INN', 'INNOVAZIONE', 'A', 'X'.repeat(16)])(
    'append is the fixed template plus exactly the code (%s)',
    (raw) => {
      const [append] = buildAdvancePayload(ticketFor(raw))
      expect(JSON.stringify(append).length).toBe(FIXED_APPEND_LENGTH(raw))
      const ctx = append.properties.context
      expect(ctx.startsWith(HEAD) && ctx.endsWith(TAIL)).toBe(true)
      // exact equality, never containment: INN is a substring of INNOVAZIONE
      expect(ctx.slice(HEAD.length, ctx.length - TAIL.length)).toBe(raw)
    }
  )

  it('decoy: a word-like code passes only because it matches the pattern, and adds no free text', () => {
    expect(asCompetencyCode('INNOVAZIONE')).not.toBeNull()
    const [append, respond] = buildAdvancePayload(ticketFor('INNOVAZIONE'))
    expect(append.properties.context).toBe(`${HEAD}INNOVAZIONE${TAIL}`)
    expect(respond.properties.text).toBe(RESPOND_TEXT)
  })

  it('respond text is a constant that carries no code', () => {
    const a = buildAdvancePayload(ticketFor('INN'))[1]
    const b = buildAdvancePayload(ticketFor('COL'))[1]
    expect(a.properties.text).toBe(RESPOND_TEXT)
    expect(b.properties.text).toBe(RESPOND_TEXT)
    expect(RESPOND_TEXT).not.toMatch(/\bINN\b|\bCOL\b/)
  })

  it('returns a frozen payload', () => {
    expect(Object.isFrozen(buildAdvancePayload(ticketFor('INN')))).toBe(true)
  })
})

describe('type guards', () => {
  // Stand-in with the exact signature FE-02 gives TavusProvider.sendBoundary.
  const sendBoundary = (_ticket: TavusBoundaryTicket): void => {}

  it('refuses free text and hand-built tickets at compile time', () => {
    // @ts-expect-error free text is not a ticket
    sendBoundary('Begin INN now.')
    // @ts-expect-error a hand-built literal is not branded
    sendBoundary({ conversationId: 'c1', competencyCode: 'INN' })
    sendBoundary(ticketFor('INN'))
  })
})
