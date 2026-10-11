import type { CompetencyCode } from '~/utils/competency-codes'

/**
 * The ONLY text the browser ever sends to steer the avatar at a competency
 * boundary: a fixed template plus a validated code, then a fixed trigger.
 * Both wordings are PROVISIONAL until live gate G-C (design N14); the envelope
 * shape is verified and frozen by the golden fixture.
 */
export const ADVANCE_TEMPLATE = 'The candidate has finished that topic. Begin topic code %s now.'
export const RESPOND_TEXT = 'Please continue.'

declare const ticketBrand: unique symbol

/** Carries only a validated code and the conversation id: no field can hold prose. */
export interface TavusBoundaryTicket {
  readonly [ticketBrand]: true
  readonly conversationId: string
  readonly competencyCode: CompetencyCode
}

/** Minted by the attribution cursor only (FE-03); tests use it directly. */
export function createBoundaryTicket(
  conversationId: string,
  competencyCode: CompetencyCode
): TavusBoundaryTicket {
  return { conversationId, competencyCode } as TavusBoundaryTicket
}

const envelope = <P>(event: string, conversation_id: string, properties: P) => ({
  message_type: 'conversation' as const,
  event_type: event,
  conversation_id,
  properties,
})

/** Append the steering context, then the mandatory respond (live-verified, S1). */
export function buildAdvancePayload(ticket: TavusBoundaryTicket) {
  const id = ticket.conversationId
  return Object.freeze([
    envelope('conversation.append_llm_context', id, {
      context: ADVANCE_TEMPLATE.replace('%s', ticket.competencyCode),
    }),
    envelope('conversation.respond', id, { text: RESPOND_TEXT }),
  ] as const)
}
