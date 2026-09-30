/**
 * COMPILE-TIME contract test — enforced by `bun run typecheck`, not by Vitest.
 *
 * It lives in `tests/nuxt/` because that is the directory the project
 * `nuxi typecheck` actually builds includes (`.nuxt/tsconfig.app.json` lists
 * `../tests/nuxt/**`); `tests/unit/**` is outside it, so a type-level assertion
 * there would be a gate that can never fail.
 *
 * What it guards: the candidate-facing session (`GET /api/candidate/session`)
 * must NOT carry the candidate's external reference (`external_id`, `source`).
 * Those are the calling system's own identifiers, exposed to operators and
 * integrations only. The api keeps the candidate response on a dedicated
 * resource for exactly that reason; this pins the same boundary in the client
 * types this app generates from the api contract, so a regenerated client that
 * starts describing the fields on the candidate session fails the build instead
 * of letting the app read them.
 */
import type { components, paths } from '../../types/api'

type SessionPayload =
  paths['/candidate/session']['get']['responses']['200']['content']['application/json']

type CandidateSession = SessionPayload['data']

/** Resolves to `true` only when the object type has none of the forbidden keys. */
type LacksKeys<T, K extends PropertyKey> = Extract<keyof T, K> extends never ? true : false

/** Resolves to `true` only when the object type has every one of the keys. */
type HasKeys<T, K extends PropertyKey> = [K] extends [keyof T] ? true : false

export const candidateSessionHasNoExternalReference: LacksKeys<
  CandidateSession,
  'external_id' | 'source'
> = true

// The schema is also pinned by name, because a regenerated client could point
// the session operation at a different schema and leave this one untouched.
export const candidateParticipantSchemaHasNoExternalReference: LacksKeys<
  components['schemas']['App.Http.Resources.ParticipantResource'],
  'external_id' | 'source'
> = true

// Positive control: the operator/integration enrolment schema DOES carry both,
// so the absence asserted above is a boundary and not a renamed or vanished
// field that would make every check here pass for the wrong reason.
export const enrolmentSchemaCarriesExternalReference: HasKeys<
  components['schemas']['ParticipantEnrolmentResource'],
  'external_id' | 'source'
> = true
