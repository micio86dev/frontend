import { redactAnalyticsPath } from '~/app/utils/analytics-path'

/**
 * Strips candidate data from Sentry events and breadcrumbs before they leave
 * the browser (C13, task 5.1 — Nuxt half).
 *
 * Mirrors `api/app/Support/Observability/SentryScrubber.php`'s discipline and,
 * where a leak class exists on both sides, its exact denylist — the api half
 * already decided this, and the point is for this half to agree with it, not
 * invent a second convention.
 *
 * `sendDefaultPii: false` (set in `app/utils/sentry-init.ts` and spread into
 * both `sentry.client.config.ts` and `sentry.server.config.ts` through
 * `posture`) stops Sentry attaching cookies, IP and header context
 * automatically. It does nothing about what THIS app hands Sentry
 * itself, and in the candidate-facing app that is substantial:
 *
 * - The interview entry link is a PATH SEGMENT — `/interview/<jwt>` — and
 *   Sentry populates `event.request.url` from `window.location.href`
 *   automatically, `sendDefaultPii` or not.
 * - The SSO exchange that consumes that link sends the same token as a QUERY
 *   PARAMETER (`GET /sso/exchange?token=...`), which lands in fetch/XHR
 *   breadcrumbs' `data.url`.
 * - The candidate JWT, `candidate_ref` and interview transcript/answers can
 *   all be in scope of an exception thrown inside the interview flow, and
 *   Sentry serializes whatever local variables a manual `captureException`
 *   call was given as `extra`/`contexts`.
 *
 * So this scrubs by KEY at any depth (candidate content, tokens, secrets)
 * AND by URL SHAPE (the entry-link token specifically) — two different leak
 * classes, both closed by this one module.
 */

/**
 * Structural shapes rather than the SDK's own `Event`/`Breadcrumb` types —
 * see the backoffice mirror for the other half of this rule: this module scrubs a
 * handful of well-known fields on plain objects, and pinning to a minimal
 * local shape means a Sentry version bump cannot change what this file
 * compiles against. `sentry.client.config.ts` and `sentry.server.config.ts` are
 * the only places that talk to the real SDK types — BOTH of them, and an
 * earlier edit narrowed this sentence to the client alone, which was false.
 */
export interface ScrubbableRequest {
  url?: string
  query_string?: unknown
  cookies?: unknown
  headers?: unknown
  [key: string]: unknown
}

export interface ScrubbableBreadcrumb {
  message?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

export interface ScrubbableExceptionValue {
  value?: string
  [key: string]: unknown
}

export interface ScrubbableException {
  values?: ScrubbableExceptionValue[]
  [key: string]: unknown
}

export interface ScrubbableEvent {
  message?: string
  tags?: Record<string, unknown>
  transaction?: string
  fingerprint?: unknown[]
  exception?: ScrubbableException
  // Same shape as `exception`, and handled by the same rules — see the branch
  // that mirrors it in `scrubSentryEventInner`.
  threads?: ScrubbableException
  request?: ScrubbableRequest
  extra?: Record<string, unknown>
  contexts?: Record<string, unknown>
  breadcrumbs?: ScrubbableBreadcrumb[]
  user?: unknown
  [key: string]: unknown
}

// Words that count in ANY segment position, not only as the last one.
//
// The single-word rule below matches the whole key or its last segment, and that
// is right for ONE word: `content`. Matching it anywhere would redact
// `content_type` and `content_length`, which are ordinary diagnostics, so it is
// the only single word left on that rule.
//
// `env` was once cited as the same case and it is NOT: `env_dump` shipped an
// `APP_KEY` while `cookie_raw` one key over was cut. The collateral — `app.env`,
// `node_env`, `build_env` going too — is accepted, because nothing
// distinguishes a framework's environment name from a request env dump.
//
// It is wrong for these. There is no innocent key shaped like `answer_1`,
// `prompt_body`, `transcript_lines`, `text_raw`, `messages_json`,
// `explanation_raw` or `payload_json` — every one names a candidate's speech or
// the LLM's rationale about it — and the last-segment rule let them all through
// in prefix position. A second list rather than widening the first, because the
// collateral the first rule avoids is real.
//
// `content` is deliberately NOT here, and that is the line: `content_type` and
// `content_length` are ordinary diagnostics, so `content` keeps the
// last-segment rule while `text` — this product's own name for transcribed
// speech — does not.
//
// `q` / `query` / `search` / `filter` ARE here, and the asymmetry with `content`
// is the point. There is no `q_type` or `query_length` the way there is for
// `content`: these name the participants filter, which by this module's own
// header carries a candidate's NAME. The COST is stated — `query_builder` goes
// with them — and it is worth paying, because the same value was already cut
// inside a query string and handed over under a key one position left.
//
// `name` is NOT here and that is deliberate: `scrubNonPlain` writes `clone.name`
// for every Error, so denying it would redact `TypeError` on every event.
//
// `header`, `env` and `fragment` ARE here with their plurals, and they were the
// last half-application: every other credential word — `password`, `token`,
// `secret`, `authorization`, `cookie` — was on BOTH lists while these three sat
// on the denylist only, so `headers_raw` shipped a bearer token, `env_dump`
// shipped an APP_KEY and `fragment_raw` shipped an entry-link token, while
// `cookie_raw` one key over was cut. Unlike `content`, they carry no
// `*_type`/`*_length` diagnostic to protect.
//
// BOTH SPELLINGS. `DENIED_KEYS` carries singular and plural for every one of
// these, and an earlier version of this list carried only the singulars — so
// `answers_1` and `transcripts_lines` were allowed while `answer_1` and
// `transcript_lines` were denied. That is the half-applied shape this module
// states one list up: each time one spelling was added without the other, the
// missing one walked.
export const DENIED_CONTENT_WORDS = new Set([
  // CREDENTIAL words, matched anywhere for the same reason the content words
  // are. `password_confirmation` ends in `confirmation`, so the last-segment
  // rule never tested `password` and the plaintext shipped.
  'header',
  'headers',
  'env',
  'envs',
  'fragment',
  'fragments',
  'password',
  'passwords',
  'token',
  'tokens',
  'secret',
  'secrets',
  'authorization',
  'authorizations',
  'cookie',
  'cookies',
  'q',
  'query',
  'queries',
  'search',
  'searches',
  'filter',
  'filters',
  'text',
  'texts',
  'messages',
  'explanation',
  'explanations',
  'payload',
  'payloads',
  'transcript',
  'transcripts',
  'prompt',
  'prompts',
  'answer',
  'answers',
  'excerpt',
  'excerpts',
  'utterance',
  'utterances',
])

// EXPORTED for the suite, deliberately. A denylist entry is only real if
// something would go red without it, and six of these — `cookie`, `answer`,
// `excerpt`, `excerpts`, `utterance`, `payload` — once could be deleted with
// the whole suite still green. Four of those six are candidate speech and BARS
// evidence excerpts, which is the whole reason this module exists. Past tense:
// the pairing below closed it, and the sentence stays as the reason it exists.
//
// The suite does NOT iterate this set. That was tried and rejected: a test
// deriving its cases from the thing under test shrinks instead of failing —
// deleting an entry deleted its own case, so the run stayed green with one
// fewer test. It compares this set against a STATIC `EXPECTED_DENIED_KEYS` and
// then walks the static list, so adding or removing an entry is a decision that
// has to be made twice, in two files, on purpose.
//
// No test counts in this comment, deliberately: a number nobody re-checks is
// the drift this module spends paragraphs warning against.
export const DENIED_KEYS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'key_hash',
  'password',
  'secret',
  'webhook_secret',
  'authorization',
  'cookie',
  // `header` as well as `headers`: every other credential pair here has both
  // forms, and this was the one that did not.
  'header',
  // The request-shaped keys go in the LIST, not only in the two `unset` sites.
  // Unsetting a literal misses `queryString` and `Query-String`, and reaches
  // neither `extra`, `tags`, a non-http context, nor `breadcrumb.data` — while
  // the list runs through the normalizer, which folds camelCase and hyphens.
  // `q` is the participants filter. This file's own header says it "is free
  // text and carries the candidate's name" — which is why the query string is
  // dropped wholesale — and the key itself was never denied.
  // `toJSON` is a DENIED KEY, not a value. `@sentry/core`'s `normalize()` runs
  // AFTER `beforeSend` and prefers `value.toJSON()` over walking own props — so
  // a method closing over unscrubbed data outranked this entire walk. The
  // premise was already written down in `scrubNonPlain`'s docblock and never
  // carried here.
  'to_json',
  'q',
  'search',
  'searches',
  'filter',
  'filters',
  'query',
  'query_string',
  'fragment',
  'env',
  // ONE recorded carve-out to the both-spellings rule: `messages` has no
  // `message`. That is Sentry's own top-level field and the thing an operator
  // reads first, so denying it would cost the report its headline. An invariant
  // with a SILENT exception is how the next contributor adds a second one, so it
  // is named here and exempted by name in the suite's plural check.
  // The PLURALS. The content keys were pluralised (`transcripts`, `answers`,
  // `excerpts`, `utterances`) and the credential keys never were — same list,
  // same rule, half applied. `{"tokens":["T1"],"api_keys":["K1"]}` walked out.
  'tokens',
  'api_keys',
  'passwords',
  'secrets',
  'cookies',
  'headers',
  // Candidate-identifying and candidate-authored content — same set the api
  // scrubber denies, so an object that crosses the wire between BEAI's three
  // apps is treated identically everywhere.
  'candidate_ref',
  // The candidate-identifying PLURALS. The rule was applied to the credential
  // keys and to the content keys and skipped here — the third half of the same
  // list. `redactFreeText('CR-99')` has nothing to grip on.
  'candidate_refs',
  'display_names',
  'entry_urls',
  'display_name',
  // The candidate email is the GLOBAL identity key (CLAUDE.md ruling 8,
  // reversed 2026-09-01) and is named in the GDPR retention sign-off
  // (ruling 2). Unlike candidate_ref it is directly identifying with no
  // calling system needed to resolve it.
  'email',
  'transcript',
  'transcripts',
  'prompt',
  'prompts',
  'answer',
  'answers',
  'excerpt',
  'excerpts',
  'utterance',
  'utterances',
  'content',
  'contents',
  // `text` is the name this PRODUCT uses for a candidate's transcribed speech —
  // `utterances.text` in the schema, the validated field on the api's
  // UtteranceController, and HeygenProvider's transcript shape. The list named
  // five synonyms and missed the one the database uses.
  //
  // The cost is real, wider than it first looked, and accepted deliberately.
  // `text` is on the ANY-POSITION list, not the last-segment one, so the
  // collateral is wider than an earlier version of this comment enumerated:
  // `text_align`, `text_content` and anything else carrying `text` in prefix
  // position goes too, on top of `formMessage.text` and `errors.text`.
  //
  // That is the trade, stated at its real size: `text` is what this PRODUCT
  // calls a candidate's transcribed speech — `utterances.text` in the schema,
  // the validated field on UtteranceController, HeygenProvider's transcript
  // shape — and enumerating the cost only works if the enumeration is current.
  'text',
  // The AI conversation as a JSON string — the api's AiIntegration json_encodes
  // it, so it lands under one key with nothing inside to walk.
  'messages',
  // The LLM's behavioural rationale on `indicator_scores`. `payload` covers it
  // on the webhook path; a bare `explanation` had nothing.
  'explanation',
  'payload',
  'texts',
  'explanations',
  'payloads',
  'authorizations',
  'query_strings',
  'fragments',
  'envs',
  'key_hashes',
  'access_tokens',
  'refresh_tokens',
  'webhook_secrets',
  'queries',
  'emails',
  // The interview entry link — this app's own motivating threat, named in the
  // header above: the entry link IS a bearer credential — holding it
  // is sufficient to start a specific candidate's interview. Treated the
  // same as an access token because it functions as one.
  'entry_url',
])

const REDACTED = '[redacted]'
const REDACTED_CYCLE = '[circular]'

/**
 * `camelCase` -> `snake_case`, so a JS-native key (`candidateRef`,
 * `entryUrl`) is checked against the same denylist as its API-shaped
 * counterpart (`candidate_ref`, `entry_url`) without maintaining two lists
 * that can drift apart.
 */
function toSnakeKey(key: string): string {
  // Hyphens and dots first: header names arrive as `X-Api-Key`, and
  // OpenTelemetry attributes arrive dotted — `auth.token`, `user.content`,
  // `request.transcript`. Every one of those trailing words is already denied;
  // without this the normalizer simply cannot reach them.
  //
  // The second pattern is what a lone `/([a-z0-9])([A-Z])/` cannot do: `APIKey`
  // and `SSOToken` have no lowercase character before the uppercase one.
  return (
    key
      // EVERY non-word character folds, not a hand-kept list of three.
      // `-`, `.` and whitespace were enumerated one leak at a time; brackets and
      // colons were never added, so `headers[authorization]` shipped a live
      // bearer token and `data[transcript]` shipped candidate speech — the same
      // values the dotted spelling one character away had cut correctly. Both
      // mirrors AND the api carried the identical three-delimiter set, so the
      // gap was symmetric: no second copy was left to disagree and expose it.
      //
      // `\W` is `[^A-Za-z0-9_]`, and `_` is the segment separator itself, so the
      // rule is now "a segment is a run of word characters" rather than a list
      // that has to anticipate every producer's spelling.
      .replace(/\W+/g, '_')
      // The EMPTY trailing segment a CLOSING delimiter leaves. `data[content]`
      // folded to `data_content_`, whose parts are `['data','content','']`, and
      // the single-word rule requires the denied word to BE the last one — so
      // `content` was never tested there and candidate speech walked, one
      // character from `data.content` being cut. Leading too, for `[content]`.
      .replace(/^_+|_+$/g, '')
      // The letter->DIGIT boundary too. Without it the normalizer produced
      // `answer1` as ONE segment: not in the list, not a run the walk can reach,
      // so `answer1` shipped while `answer_1` — the same field, one character
      // away, and the shape a template literal or an index-suffixed form field
      // produces most naturally — was denied.
      .replace(/([a-z])(\d)/gi, '$1_$2')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .toLowerCase()
  )
}

/**
 * The longest denied key, in `_`-delimited segments.
 *
 * Derived from the list rather than written down, so adding a longer entry
 * cannot silently put it out of reach of the run walk below.
 */
const MAX_DENIED_SEGMENTS = Math.max(...[...DENIED_KEYS].map((key) => key.split('_').length))

function isDeniedKey(key: string): boolean {
  const normalized = toSnakeKey(key)

  if (DENIED_KEYS.has(normalized)) {
    return true
  }

  // The LAST SEGMENT, because a namespaced key names its field at the end:
  // `http.request.header.authorization`, `user.content`, `request.transcript`.
  // Each of those trailing words is already in the set; matching the whole
  // normalised string alone could never see them.
  // EVERY `_`-delimited suffix, not only the final segment. Taking the text
  // after the last underscore can never reach a MULTI-WORD entry: `candidate_ref`,
  // `display_name`, `entry_url`, `key_hash`, `query_string` and `to_json` were
  // all unreachable behind a prefix, so `tags: {'participant.candidateRef': …}`
  // shipped verbatim one key over from a redacted `candidate_ref` in the same
  // object. The docblock's own examples — `user.content`, `request.transcript` —
  // are single-word finals, which is why the rule read as correct.
  // Every contiguous RUN of segments, not only the suffixes: suffix-only left
  // the prefix side open, and `candidate_ref_original` or `display_name_raw` is
  // an ordinary shape.
  //
  // BOUNDED by the longest denied key, not by the input. The unbounded form was
  // cubic — every start, every end, and a `join` inside both — on a key whose
  // length an attacker influences. No entry in the list is longer than
  // `MAX_DENIED_SEGMENTS`, so a longer run cannot match anything.
  const parts = normalized.split('_')

  // MULTI-WORD entries match any contiguous run; SINGLE-WORD entries match only
  // the whole key or its LAST segment. The distinction is signal strength, and
  // it is not cosmetic: `candidate_ref` or `display_name` appearing anywhere
  // inside a key means that field, full stop. A bare word like `content` does
  // not — matching it in any position redacted `content_type` and
  // `content_length`, which are ordinary diagnostics, and this module's whole
  // argument is that an unusable error reporter is the worse outcome.
  // `user_content` and `sql_query` still resolve, on the last segment.
  //
  // `app.env` is NOT among the survivors, and an earlier version of this comment
  // claimed it was. The dot folds to `_`, `env` is the last segment, and it is
  // denied — as are `node_env` and `build_env`. That is the RULING, not an
  // oversight: nothing here distinguishes a harmless framework environment name
  // from a request env dump, and denial is the safe side of that ambiguity. The
  // api mirror states the same, and a comment that named a survivor which does
  // not survive is the documentation-drift class this repo has ratified twice.
  for (let i = 0; i < parts.length; i += 1) {
    const limit = Math.min(parts.length, i + MAX_DENIED_SEGMENTS)

    for (let j = i + 1; j <= limit; j += 1) {
      if (i === 0 && j === parts.length) {
        continue
      }

      const run = parts.slice(i, j)

      // A single-word run only counts as the whole key or its LAST segment —
      // except for the candidate-content words, which count anywhere. See
      // `DENIED_CONTENT_WORDS` for why the two lists.
      if (run.length === 1 && j !== parts.length && !DENIED_CONTENT_WORDS.has(run[0] as string)) {
        continue
      }

      if (DENIED_KEYS.has(run.join('_'))) {
        return true
      }
    }
  }

  // Conventions, so a newly-named field (`sessionToken`, `signing_secret`,
  // `providerApiKey`) is covered without an edit here — enumerating every
  // future field name is impossible; a naming convention is not.
  return (
    // ONLY `_key`. `_token`, `_secret` and `_messages` were shadowed dead by the
    // last-segment check above — `token`, `secret` and `messages` are all in the
    // set, so that branch always decided first and these could never fire. `key`
    // alone is NOT in the set (too generic to deny outright), which is why this
    // one is still reachable. Keeping the dead clauses meant a future edit to
    // the set would silently change which branch is live.
    normalized.endsWith('_key') ||
    // `_keys` too: the set gained `api_keys`, the convention did not, so
    // `stripe_api_keys` was allowed while `stripe_api_key` was denied — the
    // plural strictly weaker than the singular.
    normalized.endsWith('_keys') ||
    // Any key NAMING an address, not merely one suffixed with it. The api half
    // considered `endsWith('_email')` and rejected it by name: it misses
    // `email_address`, `emails` and `emailAddress`, and `excerpts` was already
    // pluralised in the list above. This file's own contract at the top is that
    // where a leak class exists on both sides it carries the api's EXACT
    // denylist rather than inventing a second convention.
    // Collateral, enumerated rather than discovered later, the way the `text`
    // entry above does: this also redacts `send_email: true`, `email_sent: false`
    // and `emails_queued: 3`. None is an address and all three are diagnostic —
    // the trade is accepted because an address under a key nobody named is the
    // worse half, and ruling 8 makes it the global identity key.
    normalized.includes('email')
  )
}

/**
 * Objects this walk must NOT flatten into `{}`.
 *
 * `Object.entries(new Date(0))` is empty, and so is an `Error`'s — their state
 * lives in internal slots or on the prototype. Recursing into them replaced
 * `extra.cause` (an Error) with `{}`, which is the allowlist damage this
 * module's own docblock argues against while claiming to be a denylist.
 */
function isPlainWalkable(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value)

  // `Object.prototype` OR null, because a null-prototype object IS an ordinary
  // map — `JSON.parse` and `Object.create(null)` both produce one — and this
  // predicate is asked whether a value can be walked by key.
  //
  // A choice about what this predicate MEANS, not a claim about output.
  //
  // Both spellings scrub identically — `scrubNonPlain` walks own enumerable keys
  // under the body rule too, so only the result object's own prototype differs
  // and Sentry serialises that the same way. No test distinguishes them, and
  // none should be invented to.
  //
  // The clause stays because the function is named `isPlainWalkable` and asked
  // whether a value can be walked BY KEY. `Object.create(null)` and
  // `JSON.parse` both produce maps that can. Dropping it would make the
  // predicate answer a different question and happen to be right by accident,
  // which is the shape that breaks the next time the two routes diverge.
  return proto === Object.prototype || proto === null
}

/**
 * Scrubs a non-plain object WITHOUT flattening it.
 *
 * "Do not flatten" and "do not scrub" are different requirements, and treating
 * them as one branch was a denylist bypass: returning the value verbatim shipped
 * `{ cause: new ApiError('failed on /participants/42', 'CR-99') }` with both the
 * path and the candidate_ref intact, one field over from the same string
 * correctly redacted. It is not dropped downstream either — `@sentry/core`'s
 * `normalize()` runs AFTER `beforeSend` and turns class instances into plain
 * objects carrying their own enumerable props, so it ships.
 *
 * The prototype is preserved so `instanceof` still holds and the walk does not
 * do the allowlist damage this module argues against.
 */
function scrubNonPlain(value: object, seen: WeakSet<object>): unknown {
  // Containers take the keyless cut; scalars take the general rule, because an
  // own enumerable property HAS a key and a plain string under one is
  // diagnostic. The same split `scrubRecord` makes, applied to the children of
  // a non-plain object — the hop where the rule used to stop dead, leaving
  // `{err: new ApiError('boom', [BODY])}` shipping the blob that
  // `{items: [BODY]}` one level out had cut.
  const walkChild = (entry: unknown): unknown =>
    entry !== null && typeof entry === 'object' ? scrubBody(entry, seen) : scrubValue(entry, seen)

  // No candidate string can hide in these, and cloning them would lose the
  // internal slots that hold their entire value.
  if (value instanceof Date || value instanceof RegExp) {
    return value
  }

  // NO Map or Set arm, deliberately. `scrubBodyInner` is the only way into this
  // function and it catches both BEFORE it delegates here, so arms for them
  // would be dead code — and this file carried two, each with a comment
  // swearing it was load-bearing. The Map arm's own tests exercised
  // `scrubBodyInner`'s copy and could not have failed. Keeping dead code that a
  // comment insists is live is how the next reader trusts the comment instead
  // of the call graph.

  const clone = Object.create(Object.getPrototypeOf(value) as object | null) as Record<
    string,
    unknown
  >

  // Guarded for the same reason `scrubRecord`'s walk is: `Object.entries`
  // INVOKES getters, and a computed one that throws takes the event down inside
  // `beforeSend`.
  let ownEntries: [string, unknown][]

  try {
    ownEntries = Object.entries(value)
  } catch {
    return { [REDACTED]: REDACTED }
  }

  for (const [key, entry] of ownEntries) {
    defineOwn(clone, outputKeyFor(key, clone), isDeniedKey(key) ? REDACTED : walkChild(entry))
  }

  // `message` and `stack` are own but NOT enumerable on an Error, so
  // Object.entries misses them — and the message is exactly where a path or an
  // id rides.
  if (value instanceof Error) {
    // `name` through the same VALUE pass as `message`: it was the one field of
    // this branch that bypassed `redactFreeText`, and one key over the identical
    // address is cut. Not through `outputKeyFor` — the key here is the literal
    // `'name'`, which needs neither redaction nor de-collision, and saying
    // otherwise reads as a guarantee this line does not make.
    // Read through a guard: these four are NON-ENUMERABLE, so neither
    // `safeClone` nor `Object.entries` ever touched them, and a throwing
    // accessor on any one killed the event inside `beforeSend`.
    defineOwn(clone, 'name', walkChild(readGuarded(value, 'name')) as string)

    // `cause` is own but NON-enumerable, exactly like `message` and `stack`
    // above — so `Object.entries` misses it and the chain was dropped. This is
    // the case `isPlainWalkable`'s docblock names as its motivation, and the fix
    // written for `extra.cause` never reached `extra.cause`.
    const causeValue = readGuarded(value, 'cause')

    if ('cause' in value && causeValue !== undefined) {
      // Through `walkChild`, not `scrubValue` — `cause` is the ONE of the four
      // non-enumerable fields that can hold a container, and it was the one
      // that skipped the helper written to carry the body rule across this hop.
      // A keyless blob sitting directly at `cause` got only `redactFreeText`,
      // which has no slash, no `@` and no scheme to grip on, so it rejoined
      // verbatim — while the identical blob one prototype over was cut.
      defineOwn(clone, 'cause', walkChild(causeValue))
    }
    defineOwn(clone, 'message', walkChild(readGuarded(value, 'message')) as string)

    // A STACK is not prose. `redactFreeText` reduces every absolute URL to its
    // bare origin, which strips the filename, line and column off EVERY frame —
    // the outcome `scrubStacktrace` litigates and fixes for
    // `exception.stacktrace.frames`, never applied here. `redactUrl` keeps the
    // redacted path, so Sentry can still say where it broke.
    const stackValue = readGuarded(value, 'stack')

    if (typeof stackValue === 'string') {
      defineOwn(clone, 'stack', redactStack(stackValue))
    }
  }

  // These four go through `defineOwn` like every other write here, and the
  // reason is sharper than `__proto__`: this clone PRESERVES the prototype, so
  // `[[Set]]` walks the chain — and a getter-only accessor on it makes a plain
  // assignment THROW in strict mode, not silently no-op.
  // `class ValidationError extends Error { get name() {…} }` is an ordinary
  // shape, and the TypeError propagated straight out of `beforeSend`.
  //
  // An INHERITED `toJSON` is invisible to `Object.entries`, and this clone
  // deliberately preserves the prototype — so a class method closing over
  // unscrubbed data still outranked the walk, exactly as an own one did.
  // Shadowed rather than stripped: the prototype stays intact for everything
  // else it carries.
  // THROUGH `readGuarded`, like the four fields above it. This read walks the
  // PRESERVED prototype chain, and a getter-only `toJSON` on a prototype that
  // throws propagates straight out of `beforeSend` — the whole event gone, not
  // just this object. The comment three lines up already calls a getter-only
  // accessor on the preserved prototype an ordinary shape; the guard reached
  // `name`, `cause`, `message` and `stack` and stopped one line short of the
  // fifth.
  if (typeof readGuarded(clone, 'toJSON') === 'function') {
    defineOwn(clone, 'toJSON', REDACTED)
  }

  return clone
}

function scrubValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value !== 'string') {
      return value
    }

    // `redactFreeText` owns the document rule now, so every string sink gets it
    // — see the note there.
    return redactFreeText(value)
  }

  // `seen.add`, and nothing else. The `has` check and the `REDACTED_CYCLE` it
  // returned were UNREACHABLE — a probe that threw on entry when
  // `seen.has(value)` was true never fired across the whole suite, because
  // `scrubBody` catches every cycle one hop earlier — so they are gone. This
  // file deletes branches that cannot fire rather than documenting them, and an
  // earlier revision of this block documented them instead, which is the one
  // place the rule was not held.
  //
  // The `add` is load-bearing: `scrubBodyInner` RELEASES a value from `seen`
  // before delegating here, so without putting it back a self-referential
  // `err.cause = err` recurses until the stack blows — `RangeError` inside
  // `beforeSend`, which loses the event whole.
  //
  // NO matching `delete`. `scrubBody` releases the value before delegating here
  // and releases it again on the way out, so a second release changed nothing
  // observable — including for a shared non-plain reference,
  // `{ a: err, b: err }`, which is the case it would have mattered for and
  // which comes back whole either way. Same rule as the `has` check above:
  // deleted, not documented.
  seen.add(value)

  // ONLY non-plain objects arrive here. `scrubBodyInner` is the sole caller
  // that passes an object, and it does so exactly when `isPlainWalkable` is
  // false — after handling arrays, Maps and Sets in its own branches. An
  // array branch and a `scrubRecord` branch used to sit here defending
  // against shapes that cannot arrive; both were removed after a probe that
  // threw on entry never fired across the whole suite.
  return scrubNonPlain(value, seen)
}

/**
 * One property read that cannot throw.
 *
 * A computed accessor invoked by a plain read escapes `beforeSend` and loses the
 * event whole — the same hazard `safeClone` covers for spreads, on the fields a
 * spread never reaches because they are non-enumerable.
 */
function readGuarded(source: object, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key]
  } catch {
    return REDACTED
  }
}

/**
 * A shallow copy that cannot throw.
 *
 * A rest-spread destructure INVOKES getters exactly as `Object.entries` does,
 * and the five guards this module already carries all sat on the latter. A
 * computed accessor that throws — `contexts.vue.propsData` on a Vue reactive
 * graph, the case the cycle guard names — escaped `beforeSend` and lost the
 * event whole.
 */
function safeClone(value: object): Record<string, unknown> | null {
  try {
    return { ...(value as Record<string, unknown>) }
  } catch {
    return null
  }
}

/**
 * An OWN property, even when the key is `__proto__`.
 *
 * Plain assignment invokes the prototype setter there, so the entry vanishes
 * from the report and the accumulator's prototype is quietly swapped —
 * `JSON.parse` produces exactly that key.
 */
function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

//
// TWO CONVENTIONS, and this file uses both — said once here so the next reader
// does not have to guess which is live:
//
//   DELETE a branch that CANNOT FIRE. The `scrubNonPlain` Map/Set arms went for
//   exactly that, and so did `scrubValue`'s cycle `has` check: no input reaches
//   them, so keeping them is a comment insisting on something the call graph
//   denies.
//
//   DECLARE a branch that fires but whose output is EQUIVALENT. Those are live
//   code with a live effect; the only thing no test can see is the choice of
//   value or spelling. `isPlainWalkable`'s `proto === null`, `scrubbedContext`'s
//   fail-closed marker and the opener-type check in `redactEmbeddedDocuments`
//   are all of that kind, and each says so at its own site.
//
// Inventing a test that cannot fail is refused in both cases.

// Per-accumulator suffix cursors — see `outputKeyFor`. Keyed on the output
// object, which is fresh per walk, so nothing outlives the event.
const SUFFIX_CURSORS = new WeakMap<object, Map<string, number>>()

/**
 * The output key for `key`, redacted and de-collided.
 *
 * ONE rule, called by every walker. `scrubRecord` had it and `scrubNonPlain` did
 * not, so it held for a plain object and evaporated one prototype over.
 *
 * A key can CARRY the secret, not just be named after one. And two addresses as
 * sibling keys normalise to the same marker, so without a suffix a plain
 * assignment would drop one — silent diagnostic loss, not a leak.
 */
function outputKeyFor(key: string, out: Record<string, unknown>): string {
  const redacted = redactFreeText(key)

  if (!Object.hasOwn(out, redacted)) {
    return redacted
  }

  // O(1) per insert, not a rescan from 2. Every colliding key restarted the
  // search at the beginning, so n keys redacting to the SAME marker cost O(n^2)
  // `hasOwn` probes — measured inside `beforeSend`, on the main thread: 82 ms at
  // 1000 keys, 806 ms at 4000, 2.9 s at 8000, a clean 4x per doubling. The
  // control (4000 keys that do NOT collide) was 8 ms, so it was the scan and not
  // the walk.
  //
  // Reachable by this module's own account: `scrubRecord` says a map keyed by
  // address is the ordinary shape of a delivery-result map, and a map keyed by
  // absolute URL collides just as hard, since every one collapses to the same
  // origin.
  //
  // The cursor remembers where the scan for this base reached, so the total is
  // linear. Same defect class as the cubic run-walk and the quadratic document
  // scan, and the same answer: bound it, then pin the bound with a timing
  // assertion.
  let cursors = SUFFIX_CURSORS.get(out)

  if (cursors === undefined) {
    cursors = new Map<string, number>()
    SUFFIX_CURSORS.set(out, cursors)
  }

  let suffix = cursors.get(redacted) ?? 2

  while (Object.hasOwn(out, `${redacted}_${suffix}`)) {
    suffix += 1
  }

  cursors.set(redacted, suffix + 1)

  return `${redacted}_${suffix}`
}

/**
 * A denylist, deliberately, not an allowlist: an allowlist would silently drop
 * the diagnostic context that makes an error report useful, and an unusable
 * error reporter gets switched off — a worse outcome than a scrubbed one.
 */
function scrubRecord(
  data: Record<string, unknown>,
  seen: WeakSet<object> = new WeakSet()
): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  // `Object.entries` INVOKES getters, and a computed one on a Vue reactive
  // graph can throw — inside `beforeSend`, which loses the event whole. Same
  // failure the cycle guard exists for, different trigger.
  let entries: [string, unknown][]

  try {
    entries = Object.entries(data)
  } catch {
    return { [REDACTED]: REDACTED }
  }

  for (const [key, value] of entries) {
    // The KEY can carry the secret too. `isDeniedKey()` inspects what a key is
    // CALLED and `redactFreeText()` what a value CONTAINS — nothing inspected
    // what a key contains, so this module denies `email`, `emails` and
    // `email_address` by name and then hands the address over the moment it
    // moves one position left. Keying a map by address is the ordinary shape of
    // a delivery-result map.
    const outKey = outputKeyFor(key, out)

    defineOwn(
      out,
      outKey,
      isDeniedKey(key)
        ? REDACTED
        : value !== null && typeof value === 'object'
          ? scrubBody(value, seen)
          : scrubValue(value, seen)
    )
  }

  return out
}

/**
 * The anchored path rule, then the unanchored one — UNCONDITIONALLY.
 *
 * Unconditionally, and that is the whole point: an earlier revision ran the
 * second pass only "on a miss", and a miss is undetectable here — the anchored
 * helper also strips the query and any trailing slash, so an unchanged return
 * value and a changed-but-unmatched one are the same string.
 *
 * `redactAnalyticsPath`'s patterns are anchored behind a rigid
 * `^(\/(?:[a-z]{2}\/)?interview)\/([^/]+)$`-shaped patterns, so anything they do not
 * anticipate falls straight through — and returning there made a MISS look like
 * a hit, so the fallback never ran.
 *
 * The worked example belongs to the MIRROR: `/x/reset-password/TOKEN` is a
 * backoffice route (`app/pages/reset-password/[[token]].vue`) and does not exist
 * in this app, where the only unanchored pattern is `EMBEDDED_INTERVIEW_PATH`
 * and that string comes back verbatim. Named as the mirror's rather than
 * restated as ours: this module's comments are its threat model, and claiming
 * coverage that lives in another repo is the worst thing to be wrong about.
 */
function redactPath(path: string): string {
  const viaRoute = redactAnalyticsPath(path)

  // The unanchored pass runs UNCONDITIONALLY, because a miss cannot be detected
  // by inequality: `redactAnalyticsPath` also strips the query string and any
  // trailing slash, so `/anything/TOKEN?a=1` comes back CHANGED without any
  // pattern having matched — it read as a hit and the fallback never ran. It is
  // idempotent, so running it on a genuine hit costs nothing.
  // …except where `redactAnalyticsPath` ALREADY considered this shape and
  // deliberately left it: `/interview/done` is a named page, not a token.
  // Checked on the normalised value, since the query is stripped by then.
  if (ANCHORED_INTERVIEW_ROUTE.test(viaRoute)) {
    return viaRoute
  }

  return viaRoute.replace(EMBEDDED_INTERVIEW_PATH, '$1/:token')
}

/**
 * The shape `redactAnalyticsPath` itself anchors on, so a decision it already
 * made is not revisited here.
 */
const ANCHORED_INTERVIEW_ROUTE = /^\/(?:[a-z]{2}\/)?interview\/[^/]+$/

function redactAddressInPath(url: string): string {
  return url.replace(EMAIL_PATTERN, REDACTED)
}

/**
 * Strips a URL down to what Sentry may keep — reusing `redactAnalyticsPath`
 * rather than re-deriving its rules a second time in this codebase.
 *
 * The query string is dropped WHOLESALE, not filtered, and in THIS app that is
 * the load-bearing half: the SSO exchange sends the interview token as
 * `GET /sso/exchange?token=…`, so the query string is where a live bearer
 * credential rides. An allowlist of "safe" parameter names is a promise nobody
 * could keep.
 *
 * Route ids collapse to placeholders only for the shapes THIS app's
 * `redactAnalyticsPath` knows — `/interview/:token` above all. It does NOT
 * know `/participants/:id` — that route belongs to the other app — and an
 * earlier version of this docblock claimed it here.
 * What is unconditional in both is the address pass below, which is why the
 * shared routing test fixtures use an address rather than a route id.
 */
export function redactUrl(url: string | undefined): string | undefined {
  // NOTE: the address pass runs at the end of this function — an address can
  // sit in the PATH (`/participants/jane@acme.test/transcript`), and a URL is
  // client-controlled, so a 404 on a hand-typed path is enough. The api half
  // has carried this since its own url work.
  if (url === undefined || url === '') {
    return url
  }

  // Defensive, not a fix for a reachable path: every caller type-guards before
  // calling. It exists because this function is EXPORTED, and the module's
  // stated posture is not trusting a shape it did not construct itself.
  if (typeof url !== 'string') {
    return REDACTED
  }

  try {
    const parsed = new URL(url)

    return redactAddressInPath(`${parsed.protocol}//${parsed.host}${redactPath(parsed.pathname)}`)
  } catch {
    // Not an absolute URL (Vue Router breadcrumbs pass bare paths) — treat
    // the whole string as a path.
    return redactAddressInPath(redactPath(url))
  }
}

const ABSOLUTE_URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi

/**
 * An interview route EMBEDDED in prose, which `redactAnalyticsPath` cannot see.
 *
 * That function is anchored at `^`, so it only fires on a string that is a bare
 * route and nothing else — the Vue Router breadcrumb shape. `entry link
 * /interview/<token> rejected` is the shape this module's docblock names as its
 * motivating threat, and it walked straight through: no scheme for the
 * absolute-URL pass, no `@` for the address pass, and a leading token the
 * anchored pass never reached.
 *
 * The mirror has its own embedded-route helper; this app's
 * analytics-path has one route shape and exports no such helper.
 */
// NO upper bound on the token segment. `{1,256}` looked like a safety valve and
// was a leak: a candidate magic-link JWT carries candidateRef, project, role,
// lang and exp, and runs past 256 routinely — so the tail rejoined the message
// after the `:token` placeholder. A signature tail is not a usable credential on
// its own, but this module's contract is that the entry link IS a bearer
// credential, and "mostly cut" is not that promise.
//
// Unbounded is safe here because the class excludes whitespace and quotes, so
// the run ends at the token and the scan stays linear.
const EMBEDDED_INTERVIEW_PATH = /(\/(?:[a-z]{2}\/)?interview)\/[^\s/"'<>]+/gi

/**
 * An address in prose, which no key denylist can reach.
 *
 * Exactly the argument `ABSOLUTE_URL_PATTERN` above already makes for entry
 * links: a thrown message is free text, so `invite to x@y.test failed` carries
 * the identifier with no key attached to deny.
 *
 * The classes are what an ADDRESS uses, not merely "not whitespace". A broader
 * local part ate scoped package paths — `redactFreeText` runs on `Error.stack`,
 * and a stack in this app is `@sentry/nuxt`, `@nuxtjs/i18n`, `@vue/*` and Vite's
 * `/@fs/` all the way down, so `at Module.render (/app/node_modules/@sentry/…)`
 * came back as `at Module.render [redacted])`. That is the silent failure
 * `scrubStacktrace` below already litigates and calls the worse outcome: not a
 * leak, just an error reporter that can no longer say where anything broke.
 */
// The leading lookbehind is SEMANTICALLY a no-op: the local-part class is
// greedy, so the leftmost viable start always already satisfies it, and no
// input exists that it changes. It is kept purely as a MEASURED ReDoS guard —
// on `'x@' + 'a'.repeat(80_000)` V8 goes 1506 ms without it to 0.28 ms with it.
//
// The api mirror deliberately does NOT carry it: PCRE is 0.0 ms either way and
// pays more on ordinary prose. The mirror contract binds LEAK classes to the
// same answer on every side; this is an engine property.
//
// It also sets an ENGINE FLOOR, which that argument alone does not say: a
// lookbehind is a PARSE-TIME `SyntaxError` on Safari below 16.4, so it would
// take the whole chunk down rather than just this pass. Acceptable — the
// product is desktop-only and the WebKit E2E project would catch it — but it is
// a cost this comment has to name, not only a benefit.
const EMAIL_PATTERN = /(?<![\w.%+-])[\w.%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}/gi

/**
 * Every pass that is NOT about how an absolute URL should be treated.
 *
 * `redactFreeText` and `redactStackFrames` were two separate chains, and they
 * drifted apart three times: the document rule reached one and not the other,
 * then `redactRelativeQuery`, then `redactSelectorCopy` — each time leaving the
 * same string cut under `message` and verbatim inside `.stack`, one field over.
 *
 * One chain, so a new pass cannot be added to half of it. The ONLY thing the
 * two callers are still allowed to differ on is the absolute URL: free text
 * reduces it to its origin, a frame keeps the redacted PATH, because a stack
 * Sentry cannot symbolicate is the outcome this module calls worse than a
 * scrubbed one.
 */
function redactSharedPasses(text: string): string {
  return redactSelectorCopy(redactRelativeQuery(redactEmbeddedDocuments(redactEmbeddedPairs(text))))
}

/**
 * A stack trace, with its frames intact.
 *
 * The message line gets the same path and address passes as any prose; the
 * FRAME urls go through `redactUrl`, which keeps the redacted path rather than
 * reducing each one to a bare origin and leaving Sentry unable to symbolicate.
 */
function redactStackFrames(stack: string): string {
  // THE SHARED CHAIN, then the passes that are allowed to differ. Keeping two
  // hand-written chains drifted three times — the document rule, the
  // relative-query cut, the selector-copy cut — each leaving the same string cut
  // under `message` and verbatim inside `.stack`.
  //
  // A frame keeps its redacted PATH rather than collapsing to the origin: that
  // is the symbolication `scrubStacktrace` exists to protect.
  return redactSharedPasses(stack)
    .replace(EMBEDDED_INTERVIEW_PATH, '$1/:token')
    .replace(EMAIL_PATTERN, REDACTED)
    .replace(/https?:\/\/[^\s"'<>)]+/gi, (match) => redactUrl(match) ?? REDACTED)
}

function redactStack(stack: string): string {
  // The first line of a stack IS the error message, and the message FIELD is
  // scrubbed as a document while this was not — the same text cut one field over
  // and kept here. `console.error(JSON.stringify(utterances))` inside a throw
  // produces exactly that.
  //
  // Split rather than blanket: only the message line goes through
  // `redactFreeText` (which owns the document rule). The FRAMES keep the
  // path-preserving chain below, because reducing them is the symbolication
  // loss this module calls worse than a scrubbed event.
  // BOTH frame dialects. ` at ` is the V8 marker; WebKit and Firefox write
  // `fn@https://host/file.js:12:3` with no `at` anywhere. Searching only for the
  // V8 form returned -1 on those engines, so the ENTIRE stack was classified as
  // the message head and went through the free-text pass — which reduces every
  // absolute URL to its bare origin and takes the file, line and column off
  // every frame.
  //
  // That is the symbolication loss this module calls worse than a scrubbed
  // event, on a browser CLAUDE.md names as supported with its own WebKit E2E
  // project.
  //
  // The WebKit alternative is anchored on `:line:col` so a line STARTING with an
  // address is not mistaken for a frame. Output-equivalent for an address —
  // both halves run the address pass — so no test distinguishes it, and one is
  // not invented. It matters for a URL: the head reduces an absolute URL to its
  // origin while a frame keeps the redacted path, so a wrapped message line
  // misread as a frame would keep a path the head would have cut.
  const firstFrame = stack.search(/\n\s*(?:at\s|[^\s@]*@\S+:\d+:\d+)/)
  const head = firstFrame === -1 ? stack : stack.slice(0, firstFrame)
  const frames = firstFrame === -1 ? '' : stack.slice(firstFrame)
  const scrubbedHead = redactFreeText(head)

  return scrubbedHead + (frames === '' ? '' : redactStackFrames(frames))
}

/**
 * The address and absolute-URL passes, shared by both of `redactFreeText`'s
 * exits so a hit and a miss cannot answer differently.
 */
function redactTail(text: string): string {
  return text.replace(EMAIL_PATTERN, REDACTED).replace(ABSOLUTE_URL_PATTERN, (match) => {
    try {
      const parsed = new URL(match)

      return `${parsed.protocol}//${parsed.host}`
    } catch {
      return REDACTED
    }
  })
}

// The VALUE inside `[attr="…"]` in a DOM-selector breadcrumb.
//
// `@sentry/core`'s `_htmlElementAsString` appends the values of `aria-label`,
// `title` and `alt` into every `ui.click` breadcrumb message, and that copy is
// interpolated: `:aria-label="$t('nav.profileLabel', { name: currentUserName })"`
// puts a person's NAME into the selector. This module drops `event.user`
// arguing an identity adds nothing to a stack trace — and the identity walked
// back in one field over, with no slash, no `@` and no scheme for the free-text
// pass to grip.
//
// The SELECTOR survives: `div#app > a[aria-label="[redacted]"]` still says which
// element was clicked, which is the whole diagnostic value. `type` and `name`
// are left alone — they are structural, not copy.
const SELECTOR_COPY_ATTR_PATTERN = /\[(aria-label|title|alt)="[^"]*"\]/gi

function redactSelectorCopy(text: string): string {
  return text.replace(
    SELECTOR_COPY_ATTR_PATTERN,
    (_match, attr: string) => `[${attr}="${REDACTED}"]`
  )
}

/**
 * A RELATIVE path carrying a query or fragment, anywhere in the text.
 *
 * `redactUrl` cuts at `?` and `#`; the free-text URL pass is anchored to
 * `https?://`, so it only ever saw an ABSOLUTE one. The two passes therefore
 * disagreed on the same string — `/auth/magic?token=<jwt>` came back cut under
 * `request.url` and verbatim under `transaction`, a breadcrumb, an exception
 * message or `extra`. That field matters most: Sentry's tracing middleware
 * seeds the transaction with the raw client-controlled path and only replaces
 * it once a ROUTE matches, so on a 404 it stays exactly as typed.
 *
 * This module already fixed the mirror image once — `redactUrl` gained the
 * address pass so the two would agree on an email — and wrote the invariant
 * down: two passes claiming the same promise must not disagree on the same
 * input.
 *
 * A leading `/` preceded by a NON-WORD character is what distinguishes a rooted
 * path from prose, so an ordinary sentence ending in `?` is untouched and
 * `foo/bar?x=1` — a fragment mid-token, not a path — is left alone.
 *
 * An earlier version listed the allowed leads by hand (whitespace, quote,
 * bracket, start-of-string) and said nothing about it here. Anything else and
 * the pass simply never fired: `x:/auth/magic?token=<jwt>` shipped a live
 * bearer token, and `to=/participants?q=Ada Lovelace` shipped a candidate's
 * surname out of a navigation breadcrumb, because the free-text query cut lives
 * inside this pass. Every test used a whitespace or quote lead, so the pass had
 * never been asked the question it got wrong.
 *
 * WHITESPACE ENDS THE QUERY, which is where this and `redactUrl` answer
 * differently on the same characters — and the difference is the input, not the
 * rule. `redactUrl` is handed a string that IS a URL, so everything after `?`
 * is query by definition. This pass is handed PROSE, where a URL ends at the
 * first space, so `/participants?q=Ada Lovelace failed` keeps ` Lovelace
 * failed` rather than eating the rest of the sentence.
 *
 * The residue is a fragment of a value that was never a well-formed URL token:
 * a real query encodes a space as `%20` or `+`, and a JWT contains none at all,
 * so `?token=<jwt>` is cut whole. Stated rather than silently traded.
 *
 * The path class EXCLUDES `?` and `#`. Without that it is greedy and backtracks
 * to the LAST delimiter, keeping everything before it — so
 * `/auth/magic?token=<jwt>#f` came back with the token intact, and `/a?b=1?x=…`
 * lost only the second query. `redactUrl` cuts at the FIRST of either, and the
 * invariant this pass exists to restore is that the two must not disagree.
 */
// The `key=` pairs inside a query string, so a FREE-TEXT one can be recognised.
const QUERY_KEY_PATTERN = /[?&]([\w.-]{1,64})=/g

// Query keys whose VALUE is free text and therefore may contain spaces.
//
// The distinction is not "denied or not" — it is whether the value can run past
// the space that ends the URL. A credential never does: a JWT, a signature, an
// api key are all single tokens, so cutting at the first space already takes the
// whole thing and stopping there keeps the prose after it readable.
//
// `q` and `query` are the participants filter, which by this module's own header
// carries a candidate's NAME. `?q=Ada Lovelace` left ` Lovelace` standing, and
// that is the one case worth paying prose for.
const FREE_TEXT_QUERY_KEYS = new Set(['q', 'query', 'search', 'filter', 'name'])

const RELATIVE_QUERY_PATTERN = /(^|\W)(\/[^\s'"<>)\]?#]*)[?#][^\s'"<>)\]]*/g

function redactRelativeQuery(text: string): string {
  let out = ''
  let cursor = 0

  RELATIVE_QUERY_PATTERN.lastIndex = 0

  let match = RELATIVE_QUERY_PATTERN.exec(text)

  while (match !== null) {
    const lead = match[1] as string
    const path = match[2] as string
    const queryStart = match.index + lead.length + path.length
    const query = text.slice(queryStart, match.index + match[0].length)

    // A FREE-TEXT key in the query takes the rest of the LINE with it.
    //
    // The query ends at the first space, which is right for a well-formed URL
    // and for every credential — a JWT, a signature, an api key are all single
    // tokens, so `?token=<jwt> failed` is cut whole and ` failed` stays
    // readable. It is NOT right when the value is free text: `?q=Ada Lovelace`
    // left ` Lovelace` standing, and `q` is the participants filter.
    //
    // "Stated" and "safe" are not the same word. The COST is the prose after
    // the query, and it is paid only on the keys whose value can contain a
    // space at all.
    const freeText = [...query.matchAll(QUERY_KEY_PATTERN)].some((pair) =>
      FREE_TEXT_QUERY_KEYS.has((pair[1] as string).toLowerCase())
    )

    const lineEnd = freeText ? text.indexOf('\n', queryStart) : -1
    const cutEnd = freeText
      ? lineEnd === -1
        ? text.length
        : lineEnd
      : match.index + match[0].length

    out += text.slice(cursor, match.index) + lead + path
    cursor = cutEnd
    RELATIVE_QUERY_PATTERN.lastIndex = cutEnd

    match = RELATIVE_QUERY_PATTERN.exec(text)
  }

  return out + text.slice(cursor)
}

/**
 * A JSON DOCUMENT embedded in prose, scrubbed as the document it is.
 *
 * `redactEmbeddedPairs` finds `"key": value` pairs, so it saves the object
 * form. A bare ARRAY has no keys at all — `["I led the migration alone"]` —
 * and `console.error(JSON.stringify(utterances))` produces exactly that, inside
 * a breadcrumb or an `Error` message that then becomes the first line of a
 * stack.
 *
 * Only spans that actually PARSE are replaced. That is what keeps it from
 * eating `at [native code]` or a bracketed log prefix: those are not JSON, the
 * parse fails, and the text is left alone.
 */
function redactEmbeddedDocuments(text: string): string {
  if (!text.includes('[') && !text.includes('{')) {
    return text
  }

  // PAIRS, not a depth counter. The counter only attempted a span when it
  // returned to zero, so ONE unmatched `{` or `[` earlier in the string latched
  // it open and every later document went unattempted —
  // `Unexpected token { in JSON then ["I led the migration alone"]` shipped the
  // speech verbatim. That is the exact sibling of the stray-QUOTE latch below,
  // and only one of the two was fixed.
  //
  // `Unexpected token '{' …` is an ordinary V8 message and a truncated body
  // leaves an unmatched opener by construction, which `embeddedValueEnd`'s own
  // docblock already says.
  //
  // Recording pairs as they close means an opener that never closes simply
  // never produces one. Still a single pass, still linear.
  const stack: { at: number; opener: string }[] = []
  const pairs: { start: number; end: number }[] = []
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }

      continue
    }

    // Quotes only count INSIDE a span. One unmatched `"` in prose used to latch
    // this flag on for the rest of the input, so every later `{` or `[` read as
    // string content and no document was ever attempted.
    if (char === '"' && stack.length > 0) {
      inString = true

      continue
    }

    if (char === '{' || char === '[') {
      stack.push({ at: i, opener: char })

      continue
    }

    if (char !== '}' && char !== ']') {
      continue
    }

    const wanted = char === '}' ? '{' : '['
    const top = stack[stack.length - 1]

    // The TYPE check is a choice, not a claim. Every mismatched-closer input
    // probed — `{"a": [1} then ["…"]`, `[ "x" } then {…}`, `{ [ } ] {…}` —
    // comes out identical with it and without, because a wrongly-paired span
    // fails `JSON.parse` and is skipped, and the real document still closes
    // later. No test is invented for it.
    //
    // It stays because without it the stack pops an opener that did not close,
    // and the next real pair is then computed from a corrupted stack. Being
    // right by way of a failed parse is not a property this scanner should
    // depend on.
    if (top === undefined || top.opener !== wanted) {
      continue
    }

    stack.pop()
    pairs.push({ start: top.at, end: i + 1 })
  }

  if (pairs.length === 0) {
    return text
  }

  // OUTERMOST first, so a nested span is not rewritten and then rewritten again
  // inside its parent.
  pairs.sort((a, b) => a.start - b.start)

  let out = ''
  let cursor = 0

  for (const { start, end } of pairs) {
    if (start < cursor) {
      continue
    }

    // Past the length bound the span is REDACTED, not skipped. The bound exists
    // so a huge document is not parsed — a cost decision — and skipping turns it
    // into a disclosure decision.
    if (end - start > JSON_STRING_LIMIT) {
      out += text.slice(cursor, start) + REDACTED
      cursor = end

      continue
    }

    let parsed: unknown

    try {
      parsed = JSON.parse(text.slice(start, end))
    } catch {
      continue
    }

    out += text.slice(cursor, start) + JSON.stringify(scrubBody(parsed))
    cursor = end
  }

  return out + text.slice(cursor)
}

// A `"key": value` pair sitting INSIDE a longer string.
//
// `redactEmbeddedDocuments` handles a whole-string document, and the
// carrier that matters most is not: an ofetch or Guzzle error reads
// `[POST] "/api/score": 422 — {"transcript":[…]}`, and a breadcrumb records the
// same shape. Both reach `redactFreeText`, which cuts URLs and addresses and has
// nothing to say about a denied KEY embedded in prose.
//
// A SCANNER, not a regex. The first version matched only scalar values, so a
// denied key holding STRUCTURE passed through untouched — and structure is
// exactly what the worst keys hold: `{"transcript":["I led the migration
// alone"]}` and `{"payload":{"answer_summary":"…"}}` are a candidate's spoken
// answers, which is the single thing this module exists to stop.
//
// NO engine-failure branch here, and the api mirror has one. That is not a
// missing port: PHP's `preg_match` returns `false` when PCRE exhausts a
// backtrack or JIT stack limit, and collapsing that with "no more matches"
// returned the raw remainder — so the api has to distinguish them. A JS regex
// has no such return; `exec` either matches or yields null. Different engine,
// same fail-closed posture.
//
// Scanning rather than parsing, deliberately: the embedded document is
// frequently TRUNCATED — Sentry and most HTTP clients cap the body they attach
// — and a parse of a truncated document fails, which would hand the whole thing
// back. An unterminated value here is redacted to the end of the string, which
// is the fail-closed direction.
// The key class is `[^"\\]` — ANYTHING but a quote and a backslash, which is
// exactly what a JSON key may hold — and not `[\w.-]`. The narrow class could
// not see the delimiter spellings `toSnakeKey` can now segment, so an embedded
// `{"candidate ref":…}`, `{"data[transcript]":…}` or `{"user:candidate_ref":…}`
// was never even FOUND, let alone denied.
//
// Bounded by its own quotes, so it cannot run past its key. A prose value that
// happens to contain `"…":` can be read as a key and denied — accepted, because
// that direction is fail-closed and this module takes a false redaction over a
// false disclosure everywhere else. Swept 184KB of quote-heavy prose on the api
// twin: 0.1ms, no backtracking pathology, output length unchanged.
const EMBEDDED_KEY_PATTERN = /\\?"([^"\\]+)\\?"\s*:\s*/g

/**
 * The index just past the value starting at `from`, or the string length.
 *
 * Handles BOTH quote forms. A document nested inside another JSON string
 * arrives escaped — `{\"transcript\":\"…\"}` — which is the ordinary shape
 * once an error body has been serialised twice, and the plain-quote scanner
 * walked straight past it. Which form applies is told by the CALLER, from how
 * the key was quoted, because a structure value opens with a bare `{`.
 */
function embeddedValueEnd(text: string, from: number, escaped: boolean): number {
  // `\"` is one delimiter spelled in two characters, so an escaped STRING value
  // starts one character later than its opener.
  const start = escaped && text[from] === '\\' ? from + 1 : from
  const opener = text[start]

  const closesString = (i: number): number => {
    // In escaped mode the delimiter is `\"`, and an inner quote is `\\\"`.
    if (escaped) {
      return text[i] === '\\' && text[i + 1] === '"' && text[i - 1] !== '\\' ? i + 2 : 0
    }

    return text[i] === '"' && text[i - 1] !== '\\' ? i + 1 : 0
  }

  if (opener === '"') {
    for (let i = start + 1; i < text.length; i += 1) {
      const end = closesString(i)

      if (end !== 0) {
        return end
      }
    }

    return text.length
  }

  if (opener === '{' || opener === '[') {
    let depth = 0
    let inString = false

    for (let i = start; i < text.length; i += 1) {
      const char = text[i]

      if (inString) {
        const end = closesString(i)

        if (end !== 0) {
          inString = false
          i = end - 1
        }

        continue
      }

      if (char === '"' || (char === '\\' && text[i + 1] === '"')) {
        inString = true
        i = escaped ? i + 1 : i
      } else if (char === '{' || char === '[') {
        depth += 1
      } else if (char === '}' || char === ']') {
        depth -= 1

        if (depth === 0) {
          return i + 1
        }
      }
    }

    return text.length
  }

  // A bare scalar runs to the next separator.
  for (let i = start; i < text.length; i += 1) {
    if (/[,}\]\s]/.test(text[i] as string)) {
      return i
    }
  }

  return text.length
}

function redactEmbeddedPairs(text: string): string {
  if (!text.includes('"')) {
    return text
  }

  let out = ''
  let cursor = 0

  EMBEDDED_KEY_PATTERN.lastIndex = 0

  let match = EMBEDDED_KEY_PATTERN.exec(text)

  while (match !== null) {
    const key = match[1] as string
    const valueStart = match.index + match[0].length

    if (isDeniedKey(key)) {
      // ESCAPED mode is decided by the KEY's quoting, not the value's opener. A
      // denied key holding a STRUCTURE opens with a bare `{` or `[`, so deducing
      // it from the value left the flag false in a doubly-serialised document —
      // the brace walker then read the inner `\"` as non-terminating, never
      // closed the string, and ran to the end. Fail-closed, but it swallowed
      // every sibling field, which is the diagnostic collapse this module calls
      // the worse outcome.
      const isEscaped = match[0].startsWith('\\')
      const valueEnd = embeddedValueEnd(text, valueStart, isEscaped)

      // Quoted the way the DOCUMENT is. A plain-quoted marker inside an escaped
      // document closes the outer string early and the rest of the payload stops
      // being parseable — an error report nobody can read, which is the outcome
      // this module calls worse than a scrubbed one.
      out += text.slice(cursor, valueStart) + (isEscaped ? `\\"${REDACTED}\\"` : `"${REDACTED}"`)
      cursor = valueEnd
      EMBEDDED_KEY_PATTERN.lastIndex = valueEnd
    }

    match = EMBEDDED_KEY_PATTERN.exec(text)
  }

  return out + text.slice(cursor)
}

/**
 * Redacts free text that MAY embed a URL or a path, rather than assuming the
 * whole string IS one.
 *
 * `redactUrl` treats its whole argument as an address — correct for
 * `request.url` and a breadcrumb's `data.to`/`data.from`, which ARE
 * addresses. `message` (on a breadcrumb, on an event, or on an exception
 * value) is developer- or vendor-written prose that SOMETIMES contains a URL
 * and usually does not ("Vue warn: #app not found"). Running the whole
 * string through `redactUrl` split ordinary text on its first `#` or `?` and
 * silently discarded everything after — no failing build, no visible
 * symptom, and a branch `tests/unit/sentry-scrub.spec.ts` had never once
 * exercised.
 *
 * A leading `/` still goes through `redactAnalyticsPath` in full, for the Vue
 * Router breadcrumbs that pass a bare route as the whole message.
 *
 * That fast path alone was not enough: `ofetch` builds its own error message
 * as `` `[${method}] ${JSON.stringify(url)}: …` `` — the path is quoted
 * MID-SENTENCE, not the whole string, so it never took that branch and
 * reached Sentry through `exception.values[].value` on any unhandled
 * `FetchError`, verbatim. `redactPath` is the general case: it runs
 * `redactAnalyticsPath` and then an UNANCHORED pass, so the route shapes that
 * function knows are found wherever they sit inside the text, not only at the
 * start of it.
 *
 * Separately, any absolute URL found ANYWHERE in the text is reduced to its
 * origin: `entry_url` is exactly this shape (`https://…/interview/<token>`),
 * and it can end up inside an exception message (`entry link ${entryUrl}
 * rejected`) rather than as a field of its own — where the key-based
 * denylist above cannot reach it, and where the route passes cannot either.
 * `EMBEDDED_INTERVIEW_PATH` closes the same shape when it appears in prose
 * without a scheme — `redactAnalyticsPath` is anchored at `^`, so it only ever
 * fires on a string that IS a bare route.
 */
export function redactFreeText(rawText: string): string {
  // The same non-string guard `redactUrl` carries: this is exported too, and
  // the module's posture is not trusting a shape it did not construct.
  if (typeof rawText !== 'string') {
    return REDACTED
  }

  // The fast path is ONLY for a message that is a bare route and nothing else —
  // the Vue Router breadcrumb shape — because `redactPath` normalises a whole
  // path, which is meaningful on a route and wrong on prose that merely starts
  // with one. A route contains no whitespace, so that is the test.
  //
  // It does NOT exist to preserve a trailing segment: an earlier version of this
  // comment said so and cited `/participants/:id/transcript`, which is the
  // MIRROR's route — this app has no `app/pages/participants/` at all.
  //
  // Everything else, including prose that merely BEGINS with a slash, goes
  // through the general branch WHOLE. Redacting just the leading token and
  // pasting the remainder back was tried twice and leaked twice: the remainder
  // reached neither the route passes nor the absolute-URL reduction, so
  // `/participants/42 failed: entry link https://…/interview/<token> rejected`
  // came back with the bearer token intact — and the absolute-URL reduction
  // exists precisely because that string has no key for the denylist to catch.
  // One path, applied to the whole string, is the only shape that cannot have
  // a hole in it.
  // The EMBEDDED passes run first and on every branch below, because a denied
  // key can ride inside any of them — a bare route, a prose message, an
  // exception value. Running them once here is what keeps that from being three
  // decisions.
  //
  // A WHOLE-STRING document needs no separate rule: a string that IS `["…"]` is
  // a span starting at index 0, so `redactEmbeddedDocuments` already covers it.
  // An earlier revision carried a `scrubJsonString` alongside this, and it was
  // deleted once mutation showed it could not fire — dead code with a confident
  // comment is what this file removes rather than documents.
  const text = redactSharedPasses(rawText)

  if (text.startsWith('/') && !/\s/.test(text)) {
    // `redactPath`, not `redactAnalyticsPath`: the same miss-detection defect
    // lived here too.
    const viaRoute = redactPath(text)

    // RETURNED UNCONDITIONALLY, and that is the fix: `redactPath` ALREADY runs
    // both passes — the anchored one and then the unanchored one — so there is
    // nothing left for the fallthrough to add on a bare route, and everything
    // for it to break.
    //
    // What it broke: `redactPath` carries a guard whose whole stated purpose is
    // that `/interview/done` and `/interview/error` are NAMED PAGES, not
    // tokens. Falling through ran `EMBEDDED_INTERVIEW_PATH` on them anyway and
    // reported both as `/interview/:token`, so `redactUrl` and `redactFreeText`
    // returned different answers for the same input — the exact disagreement
    // `redactRelativeQuery`'s docblock forbids. Every event from the done and
    // error pages grouped under the token page. Not a leak; a GROUPING
    // COLLAPSE, which this module argues at length is the worse outcome.
    //
    // NOT returned raw. `redactAnalyticsPath` keeps the trailing remainder
    // verbatim, so everything after the placeholder never reached the address
    // or absolute-URL passes: `/participants/:id/notes/jane@acme.test` shipped
    // the address, and `redactUrl` — the twin with the same threat model — cut
    // it.
    return redactTail(viaRoute)
  }

  return redactTail(text.replace(EMBEDDED_INTERVIEW_PATH, '$1/:token'))
}

/**
 * The same last net `scrubSentryEvent` carries, on the same argument.
 *
 * `beforeBreadcrumb` is a separate hook with an identical failure mode:
 * anything thrown here escapes into the SDK and the breadcrumb is lost. The net
 * existed on one hook and not the other — the half-applied shape this module
 * names on nearly every line.
 *
 * PINNED, through the same door as its twin: the cycle guard catches cycles and
 * not DEPTH, so a non-cyclic graph nested past the engine's frame limit raises
 * `RangeError` inside the walk. An earlier version of this comment said no test
 * could reach it — that was true only because no test had tried 20,000 levels.
 * "No input has been found" is a statement about the search, not about the
 * code, and this file does not get to treat the two as the same.
 */
export function scrubBreadcrumb(breadcrumb: ScrubbableBreadcrumb): ScrubbableBreadcrumb {
  try {
    return scrubBreadcrumbInner(breadcrumb)
  } catch {
    return { message: REDACTED } as ScrubbableBreadcrumb
  }
}

function scrubBreadcrumbInner(breadcrumb: ScrubbableBreadcrumb): ScrubbableBreadcrumb {
  // The ELEMENT, not only the container. `Array.isArray` guarded the array and a
  // `[null]` element then threw on destructuring INSIDE beforeSend, losing the
  // event whole — the outcome the cycle guard calls monitoring dying silently on
  // the richest events.
  // `Array.isArray` FIRST: `typeof [] === 'object'`, so an array element cleared
  // the guard below, `safeClone` spread it into `{"0": …}`, and every element
  // landed under an index key that denies nothing — shape lost AND the blob
  // shipped. The same class already guarded for `request`, `stacktrace` and
  // `breadcrumb.data`, never for the breadcrumb itself.
  if (!isWalkableObject(breadcrumb)) {
    return scrubOffShape(breadcrumb) as ScrubbableBreadcrumb
  }

  // Built WITHOUT the raw spread, for the reason the event branch already gives:
  // `ScrubbableBreadcrumb` carries an open index signature, so only `data` and
  // `message` were handled and `candidate_ref`, `display_name` and `entry_url`
  // rode out verbatim on everything else.
  const safeBreadcrumb = safeClone(breadcrumb)

  if (safeBreadcrumb === null) {
    return { [REDACTED]: REDACTED }
  }

  const { data: _data, message: _message, ...rest } = safeBreadcrumb
  // Equivalent to `scrubRecord` here — see the note on `scrubBody` itself.
  const next: ScrubbableBreadcrumb = { ...(scrubBody(rest) as Record<string, unknown>) }

  // Read through a guard, not off the ORIGINAL. `safeClone` above protects the
  // spread, but a NON-ENUMERABLE throwing accessor is invisible to a spread —
  // so the clone succeeds and these two reads detonate, losing the event whole.
  // Every sibling walker in this file already reads this way.
  let rawData: unknown
  let rawMessage: unknown

  try {
    rawData = breadcrumb.data
  } catch {
    rawData = REDACTED
  }

  try {
    rawMessage = breadcrumb.message
  } catch {
    rawMessage = REDACTED
  }

  if (rawData !== undefined) {
    next.data = rawData as ScrubbableBreadcrumb['data']
  }

  if (rawMessage !== undefined) {
    next.message = rawMessage as ScrubbableBreadcrumb['message']
  }

  if (next.data) {
    if (Array.isArray(next.data) || typeof next.data !== 'object') {
      // NOT an early return. The message branch below redacts the route, the
      // address and the entry link, and returning here skipped it for every
      // non-object `data` — a previously-safe path made unsafe.
      //
      // `scrubBody` rather than `scrubRecord`: the latter runs `Object.entries`
      // over a string, making every character its own key, and flattens an array
      // into an index map — the shape lost and the payload intact.
      next.data = scrubBody(next.data) as Record<string, unknown>
    } else {
      // `scrubBody`, not `scrubValue`: a TOP-LEVEL array `data` was cut and a
      // NESTED one was not — `{items: [BODY]}`, the ordinary envelope of a
      // paginated list response, which this file names by hand one function over.
      const walkedData = scrubBody(next.data)
      const data = (
        walkedData !== null && typeof walkedData === 'object' && !Array.isArray(walkedData)
          ? walkedData
          : {}
      ) as Record<string, unknown>

      // Re-derived from the ORIGINAL value, not the scrubbed copy. These three
      // keys ARE addresses and get `redactUrl`, which keeps the route because
      // knowing which endpoint failed is most of a breadcrumb's worth.
      // `scrubRecord` runs every string through `redactFreeText`, which reduces
      // an absolute URL to its bare origin — correct for prose, destructive
      // here, and it left `redactUrl` with nothing to cut.
      for (const urlKey of ['url', 'to', 'from'] as const) {
        // Read through a guard like every other read here: a non-enumerable
        // throwing accessor is invisible to `safeClone` and `Object.entries`,
        // so neither existing try/catch fires.
        let original: unknown

        try {
          original = (next.data as Record<string, unknown>)[urlKey]
        } catch {
          original = undefined
        }

        if (typeof original === 'string') {
          data[urlKey] = redactUrl(original)
        }
      }

      next.data = data
    }
  }

  if (next.message !== undefined) {
    next.message =
      typeof next.message === 'string'
        ? redactFreeText(next.message)
        : // Non-string, so `scrubOffShape` — the rule and its argument live
          // there. The STRING arm keeps `redactFreeText` deliberately: a route
          // or a thrown message is readable text, and cutting it destroys
          // Sentry grouping.
          (scrubOffShape(next.message) as typeof next.message)
  }

  return next
}

/**
 * The event fields `scrubSentryEvent` handles BY NAME below.
 *
 * Anything absent from this set is walked by the key denylist instead of
 * being spread through untouched — see the note at the top of that function.
 */
// EXPORTED for the same reason. Dropping `request` or `breadcrumbs` from here
// left the suite green while silently downgrading their URL handling from
// `redactUrl` to `redactFreeText` — `https://bo.test/participants/:id` came
// back as the bare `https://bo.test/`. Not a leak, and therefore the kind of
// loss nothing notices: it is the symbolication failure `scrubStacktrace`
// litigates, one field over.
export const HANDLED_EVENT_FIELDS = new Set([
  'message',
  'tags',
  'transaction',
  'fingerprint',
  'exception',
  // `threads` carries the IDENTICAL `{values:[{stacktrace:{frames}}]}` shape
  // as `exception` and was absent, so its frames took `redactFreeText` instead
  // of `redactUrl` and collapsed to the bare origin — the symbolication loss
  // `scrubStacktrace` litigates, one field over.
  'threads',
  'request',
  'extra',
  'contexts',
  'breadcrumbs',
  'user',
])

/**
 * Frame fields that carry a URL, and therefore the URL SHAPE rule.
 *
 * `scrubRecord` walks a stacktrace by key, which catches `vars` (a frame's
 * captured locals) but cannot help with these two: they are not denied keys,
 * they are keys whose VALUE is an address.
 */
const FRAME_URL_FIELDS = ['filename', 'abs_path'] as const

// SOURCE LINES, restored after the walk. They are arrays, an array element is
// keyless, and the body rule cuts a keyless string outright — so every source
// line of every frame reached Sentry as the marker, undocumented and untested.
//
// That is pure diagnostic loss with no leak class behind it: these hold the
// compiled bundle's own code, not candidate data, and `scrubStacktrace` exists
// precisely to argue that a stack Sentry cannot symbolicate is worse than a
// scrubbed one. `context_line` already survived; its two neighbours did not,
// which is the same half-applied shape this file keeps finding in itself.
const FRAME_SOURCE_FIELDS = ['pre_context', 'post_context'] as const

function scrubStacktrace(stacktrace: unknown): unknown {
  if (!isWalkableObject(stacktrace)) {
    // `typeof [] === 'object'`, so an array came out `{"0":…}` — the shape-lost
    // class the `request` branch names and guards, never carried here.
    return scrubOffShape(stacktrace)
  }

  // The RAW frames, captured before the walk. `scrubRecord` has already put
  // every string value through the free-text pass, so reading `filename` back
  // out of `walked` and handing it to `redactUrl` redacts a redacted value:
  // `https://bo.test/_nuxt/D1abc.js` came back as the bare `https://bo.test/`,
  // which strips the filename off EVERY frame of EVERY event and leaves Sentry
  // unable to symbolicate anything. That is not a leak, it is silent — and this
  // module's own thesis is that an unusable error reporter is the worse outcome.
  const rawFrames = readGuarded(stacktrace, 'frames')
  const walked = scrubRecord(stacktrace as Record<string, unknown>)
  const frames = walked['frames']

  if (!Array.isArray(frames)) {
    return walked
  }

  walked['frames'] = frames.map((frame, index) => {
    if (typeof frame !== 'object' || frame === null) {
      return frame
    }

    const original = Array.isArray(rawFrames) ? rawFrames[index] : undefined
    const nextFrame = { ...(frame as Record<string, unknown>) }

    for (const field of FRAME_URL_FIELDS) {
      let raw: unknown

      try {
        raw = (original as Record<string, unknown> | undefined)?.[field]
      } catch {
        raw = undefined
      }

      if (typeof raw === 'string') {
        nextFrame[field] = redactUrl(raw)
      }
    }

    for (const field of FRAME_SOURCE_FIELDS) {
      let raw: unknown

      try {
        raw = (original as Record<string, unknown> | undefined)?.[field]
      } catch {
        raw = undefined
      }

      if (Array.isArray(raw) && raw.every((line) => typeof line === 'string')) {
        // THROUGH the free-text pass, not raw. Restoring these untouched was an
        // over-correction: it fixed "every source line cut to the marker" by
        // giving them the only zero-redaction path in the whole event, and a
        // bundled line reads `const email = "jane@acme.test"` as readily as it
        // reads `const a = 1`. `redactFreeText` keeps the code and takes the
        // address, the token and the route — which is the middle ground the
        // first fix stepped over.
        nextFrame[field] = raw.map((line) => redactFreeText(line))
      }
    }

    return nextFrame
  })

  return walked
}

/**
 * `exception` and `threads` are the same shape, so they get the same walker.
 *
 * Sentry defines both as `{values: [{…, stacktrace: {frames: […]}}]}`. They were
 * two copies of one block, comments included — and the copy still described
 * "an exception" while walking threads. This file's own line is that two copies
 * of one rule is how the second instance goes missing, and this pair had
 * already proved it once: `threads` sat in `HANDLED_EVENT_FIELDS` with no
 * branch at all, which in that walker means "copied raw".
 */
function scrubExceptionLike(value: unknown): unknown {
  if (value !== undefined && !isWalkableObject(value)) {
    // Off-shape guard — see `scrubOffShape` for why this is the keyless rule
    // and not the general one.
    return scrubOffShape(value)
  }

  if (!value) {
    return value
  }

  // The MARKER when the clone is impossible, not an empty object. A throwing
  // getter made `safeClone` return null, the rest-spread became `{}`, and the
  // whole field evaporated — while `request` one branch over returned the
  // marker on the identical input. A dropped key says the field never existed,
  // which is a different claim and a false one.
  const safe = safeClone(value)
  const { values, ...rest } = safe ?? { values: undefined, [REDACTED]: REDACTED }

  return {
    ...(scrubBody(rest) as Record<string, unknown>),
    // REDACTED, not dropped, when `values` is off-shape: every sibling guard in
    // this file argues the key should survive carrying the marker.
    ...(values === undefined
      ? {}
      : {
          values: Array.isArray(values)
            ? values.map(scrubExceptionValue)
            : (scrubOffShape(values) as ScrubbableExceptionValue[]),
        }),
  }
}

/**
 * `stacktrace` rode out on the `...value` spread this replaces.
 *
 * The module applies its URL-shape rule to `request.url`, `breadcrumb.data.url`
 * and `transaction`, then stopped at the exception boundary — a frame's
 * `filename`/`abs_path` are addresses and its `vars` are captured locals, both
 * of which the rest of this file would have refused to ship.
 */
function scrubExceptionValue(value: ScrubbableExceptionValue): ScrubbableExceptionValue {
  // Same element guard as `scrubBreadcrumb`: a `[null]` in `values` threw on
  // destructuring inside beforeSend. On the BODY rule, because an array element
  // has no key for the denylist to deny — a JSON string here rejoins verbatim
  // under `redactFreeText`, which only catches what it recognises.
  if (!isWalkableObject(value)) {
    return scrubOffShape(value) as ScrubbableExceptionValue
  }

  const safeValue = safeClone(value)

  if (safeValue === null) {
    return { [REDACTED]: REDACTED }
  }

  const { value: message, stacktrace, ...rest } = safeValue

  // Equivalent to `scrubRecord` here — see the note on `scrubBody` itself.
  const next: ScrubbableExceptionValue = {
    ...(scrubBody(rest) as Record<string, unknown>),
  }

  if (message !== undefined) {
    next.value = (
      typeof message === 'string' ? redactFreeText(message) : scrubOffShape(message)
    ) as typeof next.value
  }

  if (stacktrace !== undefined) {
    next.stacktrace = scrubStacktrace(stacktrace)
  }

  return next
}

/**
 * Can this field be walked by key, or did it arrive off-shape?
 *
 * ONE predicate, because this is one question and it was written by hand at
 * seven guards — each spelling out `x === null || typeof x !== 'object'` and
 * each having to remember, separately, that `typeof [] === 'object'`. Three of
 * them forgot. An ARRAY cleared the guard, reached a branch that spreads its
 * argument, and came out as `{"0": …}` — shape lost and every element under an
 * index key that denies nothing, so `candidate_ref` and `entry_url` shipped
 * verbatim.
 *
 * Written as the POSITIVE so it NARROWS: every guard reads
 * `if (!isWalkableObject(x))` and the branch below it gets a real
 * `Record<string, unknown>` instead of a cast. Off-shape means KEYLESS, so the
 * answer is always `scrubOffShape`, and asking the question in one place is
 * what stops the fourth guard forgetting.
 */
function isWalkableObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Past this length a string is not a diagnostic payload worth parsing, and
// `JSON.parse` on it is a cost paid on every event.
//
// NOT an equivalent mutant: over the limit the span becomes the marker, under it
// the document is parsed, scrubbed and re-encoded. Pinned by "REDACTS an
// oversized embedded span rather than skipping it", which asserts the EXACT
// over-limit shape — an earlier version of that test asserted only the absence
// of the secret plus the surrounding prose, and both are true on either side of
// the bound, so it passed vacuously while this comment claimed it did not.
const JSON_STRING_LIMIT = 100_000

/**
 * The rule for a field that arrived in a shape its branch cannot parse.
 *
 * ONE helper, because this is one rule and it went missing three separate
 * times. An off-shape value is a KEYLESS position by definition: the field did
 * not arrive in the shape the branch parses, so there is no key left for
 * `isDeniedKey` to deny — and `redactFreeText` only cuts what it RECOGNISES,
 * which a JSON blob is not (no slash, no `@`, no scheme). So
 * `{"candidate_ref":"CR-99","display_name":"Ada Lovelace"}` rejoined verbatim
 * at every guard that reached for `scrubValue` instead.
 *
 * `scrubValue` is the GENERAL rule, for a value that still has keys.
 * `scrubBody` is the KEYLESS rule. Every off-shape guard wants the second one,
 * and naming that here is what stops the fourth instance going missing.
 */
function scrubOffShape(value: unknown): unknown {
  return scrubBody(value)
}

/**
 * The BODY rule: a value with no key of its own is cut, at any depth.
 *
 * Named for the `request.data` case it started as, and it is now the general
 * body walker — `extra`, `tags`, `contexts`, `request`, `exception`,
 * `fingerprint`, `breadcrumb.data`, Map values and Set elements all route
 * through here. Said explicitly because the previous docblock still described
 * the narrow original role, and that is exactly how the four off-shape guards
 * above ended up reaching for `scrubValue` instead.
 *
 * `scrubRecord` covers an OBJECT body by key. An ARRAY is walked element by
 * element, with STRING elements cut — an element has no key either. A raw
 * STRING body is cut outright: it has no key to deny
 * and `redactFreeText` has nothing to grip on, no slash, no `@`, no scheme, so
 * `{"candidate_ref":"CR-99","q":"Ada Lovelace"}` went out whole.
 *
 * Worse, `scrubRecord` on a string runs `Object.entries` over it — every
 * character becomes its own key, `redactFreeText` is applied per character and
 * cuts nothing, and the value is trivially rejoined.
 *
 * One helper because `request` and `contexts.http` are the same shape under two
 * names, and fixing one and not the other is how the second instance of every
 * rule in this file went missing.
 *
 * FIVE call sites pass a MAP straight to `scrubBody`, and `scrubRecord` — the map
 * arm of this rule — is byte-identical there: the only difference is one redundant
 * cycle-guard entry for an object that cannot be its own ancestor. Kept and stated
 * rather than deleted: live calls with an equivalent twin are not dead code. Stated
 * ONCE, here, because the four copies of this paragraph were four chances for the
 * rule to go missing from one of them.
 */
function scrubBody(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  // The same ancestor-path cycle guard `scrubValue` carries: this recursion is
  // new, and a reactive graph or a self-referential body blew the stack inside
  // `beforeSend`, which loses the event whole.
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) {
      return REDACTED_CYCLE
    }

    seen.add(value)
  }

  const result = scrubBodyInner(value, seen)

  if (value !== null && typeof value === 'object') {
    seen.delete(value)
  }

  return result
}

function scrubBodyInner(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    // Elements are KEYLESS, at any depth. The rule used to stop at depth 1:
    // `[BODY]` was cut and `{items: [BODY]}` shipped verbatim — and `{items: […]}`
    // is the ordinary envelope of a paginated list response, the single most
    // likely thing under `request.data` on the participants page.
    return value.map((element) => scrubBody(element, seen))
  }

  if (value !== null && typeof value === 'object') {
    // A Map or a Set INSIDE a body keeps the body rule. Delegating them walks
    // their entries with the GENERAL rule, and a keyless JSON string in a Set
    // has nothing to deny.
    if (value instanceof Set) {
      return [...(value as Set<unknown>)].map((entry) => scrubBody(entry, seen))
    }

    if (value instanceof Map) {
      const fromMap: Record<string, unknown> = {}

      for (const [mapKey, mapValue] of value as Map<unknown, unknown>) {
        // GUARDED coercion. A Map keyed by OBJECTS is ordinary, and
        // `String(key)` calls `toString()` — a throwing one took the event down
        // whole. Every sibling walker wraps its enumeration; this one line had
        // nothing.
        let name: string

        try {
          name = String(mapKey)
        } catch {
          name = REDACTED
        }

        // A Map entry HAS a key, so it follows the object rule, not the keyless
        // one: the denylist can deny it, and a plain string under it keeps its
        // diagnostic value. Only its CONTAINERS stay on the body rule.
        defineOwn(
          fromMap,
          outputKeyFor(name, fromMap),
          isDeniedKey(name)
            ? REDACTED
            : mapValue !== null && typeof mapValue === 'object'
              ? scrubBody(mapValue, seen)
              : scrubValue(mapValue, seen)
        )
      }

      return fromMap
    }

    // Any other non-plain object — an Error, a Date — goes to `scrubValue`,
    // which owns that walk. Flattening them here is the `{}` defect
    // `isPlainWalkable` exists to prevent.
    if (!isPlainWalkable(value)) {
      // Released from the ancestor path FIRST: the wrapper added it, and
      // `scrubValue` would otherwise see its own argument as a cycle and return
      // the circular marker instead of walking it.
      seen.delete(value)

      return scrubValue(value, seen)
    }

    // Keys EXIST here, so the denylist can do its job and a plain string under a
    // named key keeps its diagnostic value. Nested containers stay on the body
    // rule, which is the part that was missing.
    //
    // ONE implementation, not two. This branch was a line-for-line copy of
    // `scrubRecord` — same denied-to-marker, same object-to-`scrubBody`, same
    // primitive-to-`scrubValue` — which is why three `scrubBody`/`scrubRecord`
    // swaps came back as equivalent mutants. Two copies of one rule is how the
    // second instance of every rule in this file went missing.
    return scrubRecord(value as Record<string, unknown>, seen)
  }

  return typeof value === 'string' ? REDACTED : value
}

function scrubbedDataEntry(data: unknown): Record<string, unknown> {
  return data === undefined ? {} : { data: scrubBody(data) }
}

/**
 * One context, copied safely and given the body rule.
 *
 * The per-context spread invoked getters raw — `contexts.vue.propsData` on a
 * reactive graph is the case this file cites by name, and it was the one level
 * every sibling walker guarded and this did not.
 */
function scrubbedContext(context: Record<string, unknown>): Record<string, unknown> {
  const safe = safeClone(context)

  // TWO different claims, and only one of them is pinned. Said separately
  // because an earlier version of this comment conflated them and got it wrong
  // in both directions.
  //
  // The EARLY RETURN is load-bearing: continuing past it re-invokes the
  // throwing getter on the spread below, the throw reaches the outer net, and
  // an event whose `message` had nothing to do with it is lost whole. Three
  // tests die on that, including "contains a throwing getter on
  // `contexts.http` to that context alone".
  //
  // The MARKER-vs-raw choice is a CHOICE, not a claim: returning the raw context
  // here is byte-identical today, because `scrubRecord`'s own `Object.entries`
  // guard catches the hostile value one hop later and the `http` post-pass
  // re-runs `safeClone` anyway. Measured, not assumed.
  //
  // It is the marker because the equivalence rests on a NEIGHBOUR's
  // implementation detail, and this function should not be the one that has to
  // be right about that. Failing closed here costs nothing and removes the
  // dependency. No test is invented for it — a test that cannot fail is the
  // thing this file refuses everywhere else.
  if (safe === null) {
    return { [REDACTED]: REDACTED }
  }

  // The WHOLE context on the body rule, not only its `data` key. A keyless array
  // element anywhere else got nothing but `redactFreeText`, which cannot grip a
  // JSON blob — so `contexts.vue.propsData.items` and `contexts.state.state.items`
  // shipped verbatim while the identical body under `data` was cut. Those two
  // keys are the ones this module already names by hand.
  // A PLAIN read, no try/catch. `safe` is a `{...context}` clone, so `data` is
  // already a data property and the read cannot throw — a guard that cannot
  // fire is the dead-code-with-a-confident-comment shape this file condemns two
  // hundred lines up, at the Map/Set arms it deleted for the same reason.
  const data: unknown = safe['data']

  // NOT walked here. The caller feeds this into `scrubRecord`, which hands every
  // OBJECT value to `scrubBody` — so a second walk on the way in was the same
  // work twice, and replacing it with a raw spread is byte-identical. Two places
  // applying one rule is how the rule later goes missing from one of them.
  //
  // `data` IS cut explicitly on top, and that is not redundant: it sits under a
  // NAMED key, so `scrubRecord` keeps a STRING there through `redactFreeText`,
  // which has nothing to grip on in `{"candidate_ref":"CR-99"}`. The body rule
  // cuts it outright.
  return { ...safe, ...scrubbedDataEntry(data) }
}

/**
 * The `http` context IS the request, under a second name.
 *
 * Sentry populates it independently of `event.request`, with the same
 * `url`/`query_string` shapes — and `query` for the same value. A generic key
 * walk denies neither, so the entry-link token the request branch exists to cut
 * walked out one context over from where it was cut.
 */
function scrubHttpContext(context: Record<string, unknown>): Record<string, unknown> {
  const safeContext = safeClone(context)

  if (safeContext === null) {
    return { [REDACTED]: REDACTED }
  }

  const { url, ...rest } = safeContext

  return {
    // Equivalent to `scrubRecord` here — see the note on `scrubBody` itself.
    ...(scrubBody(rest) as Record<string, unknown>),
    ...scrubbedDataEntry(rest['data']),
    // `REDACTED`, not dropped: the `request` branch returns `"[redacted]"` for a
    // non-string url and this returned nothing at all. One helper that disagrees
    // with the branch it was extracted to match is the defect it exists to stop.
    // `redactUrl` carries the non-string guard itself and returns the marker;
    // the cast is the shape this module refuses to trust, not a claim about it.
    ...(url === undefined ? {} : { url: redactUrl(url as string) }),
    // REDACTED IN PLACE, not dropped: `query_string`, `cookies`, `headers` and
    // `env` ride in `rest`, reach `scrubBody`, and come back as keys carrying
    // the marker. The `request` branch already corrected this exact wording and
    // the correction never reached here — the half-applied shape this file
    // names on nearly every line.
    //
    // Whole rather than filtered, for the reason that branch gives: an
    // allowlist of safe parameter names is a promise nobody could keep.
  }
}

/**
 * The last net, and it exists because `beforeSend` has no other one.
 *
 * Anything this module throws escapes into Sentry's `beforeSend` and loses the
 * event WHOLE — the failure every guard in this file is individually written
 * against, and the one it cannot enumerate. Depth is the known example: the
 * cycle guard catches cycles, not depth, and a non-cyclic graph nested past
 * roughly 3000 levels still raises `RangeError`. The api mirror answers the
 * same class with a depth cap in `scrub()`, after a self-referential ARRAY took
 * the PHP process down with SIGSEGV.
 *
 * A marker event rather than nothing: an event that says a scrub failed is a
 * signal, and silence is not.
 */
export function scrubSentryEvent(event: ScrubbableEvent): ScrubbableEvent {
  try {
    return scrubSentryEventInner(event)
  } catch {
    return { message: REDACTED } as ScrubbableEvent
  }
}

function scrubSentryEventInner(event: ScrubbableEvent): ScrubbableEvent {
  // Built WITHOUT the unhandled keys rather than spread-then-deleted. The
  // opening spread carried every field of the event, and `scrubRecord` may
  // RENAME its output key — an address or a path in the key itself, or a `_2`
  // collision suffix — so assigning the scrubbed entry under the new name left
  // the original sitting beside it. The entry_url shipped verbatim one key to
  // the left of its redacted twin, and the twin is what made the event LOOK
  // scrubbed.
  const next: ScrubbableEvent = {}
  const unhandled: Record<string, unknown> = {}

  // Guarded like every other walk in this module: `Object.entries` INVOKES
  // getters, and one that throws at the ENTRY POINT loses the event whole.
  let eventEntries: [string, unknown][]

  try {
    eventEntries = Object.entries(event)
  } catch {
    return { [REDACTED]: REDACTED }
  }

  for (const [key, value] of eventEntries) {
    if (HANDLED_EVENT_FIELDS.has(key)) {
      defineOwn(next as Record<string, unknown>, key, value)
    } else {
      defineOwn(unhandled, key, value)
    }
  }

  // `defineOwn` per key, not `Object.assign`: assign invokes the `__proto__`
  // setter for that key name and the entry vanishes — the same hole `defineOwn`
  // was written to close, re-opened one line over.
  for (const [key, value] of Object.entries(scrubRecord(unhandled))) {
    defineOwn(next as Record<string, unknown>, key, value)
  }

  // An object guard, for the reason the element guards exist: a non-object here
  // destructures to nothing and the branch below silently does no work.
  if (next.request !== undefined && !isWalkableObject(next.request)) {
    // A guard MISS on a handled field leaks: the value was copied into `next` by
    // name, so falling past the branch leaves it raw. `fingerprint` already
    // carries this reasoning; `request`, `contexts` and `exception` did not.
    // Off-shape guard — see `scrubOffShape` for why this is the keyless rule
    // and not the general one.
    next.request = scrubOffShape(next.request) as typeof next.request
  } else if (next.request) {
    // A rest spread invokes getters, so the copy is taken safely FIRST.
    const safeRequest = safeClone(next.request) ?? { [REDACTED]: REDACTED }
    const { url, ...rest } = safeRequest

    // The non-string guard lives in `redactUrl` itself now, so this passes the
    // value straight through — one guard, not two saying the same thing.

    next.request = {
      // Equivalent to `scrubRecord` here — see the note on `scrubBody` itself.
      ...(scrubBody(rest) as Record<string, unknown>),
      // A STRING body has no KEY for the denylist to deny, and `redactFreeText`
      // has nothing to grip on — no slash, no `@`, no scheme. The same
      // `candidate_ref` and `q=` this file cuts under `request.query` walked out
      // one key to the left. `scrubRecord(rest)` covers an OBJECT body only.
      ...scrubbedDataEntry(rest['data']),
      // `url === undefined` MUST omit the key, not spread `{ url: undefined }`:
      // `scrubHttpContext` guards the same input the same way, and a helper that
      // disagrees with the branch it was extracted to match is the defect it
      // exists to stop. `JSON.stringify` drops it before the wire, so the false
      // claim is in-process only — visible to any `beforeSend` chained after us.
      ...(url === undefined
        ? {}
        : typeof url === 'string'
          ? { url: redactUrl(url) }
          : { url: REDACTED }),
      // Query string, cookies, headers and env are REDACTED IN PLACE, not
      // filtered and not removed — the key survives carrying the marker, which
      // is how the report still shows that a cookie header existed without
      // showing what was in it. (An earlier comment here said "dropped
      // wholesale"; they were never dropped, and in a file whose comments are
      // the threat model those two words are not interchangeable.)
      //
      // Whole rather than filtered, for the same reason the URL query string
      // is: an allowlist of safe parameter names is a promise nobody could
      // keep. None of these should be populated with `sendDefaultPii: false`,
      // but this scrubber does not trust a future SDK version to keep it so.
      // `query` too. The `http` context branch already dropped it and this one
      // did not, so `{url, query}` had the URL cut and the token walk out one
      // key over in the SAME object — and `redactFreeText` cannot help: a bare
      // `token=…` has no leading slash, no `@` and no scheme to match on.
      // `env` goes with the user context, not without it: the SDK builds the
      // user bag from `env.REMOTE_ADDR`, so dropping `user` while keeping this
      // kept the IP under another name.
      // `fragment` is the third name for the same value: `redactUrl()` cuts at
      // `?` AND `#`, and this list dropped the two query spellings while the
      // fragment carried `token=…` untouched.
    }
  }

  if (next.extra) {
    // `scrubValue`, not `scrubRecord`: a raw STRING run through
    // `Object.entries` becomes a char-indexed map, `redactFreeText` is applied
    // per character and cuts nothing, and the value rejoins verbatim.
    // `scrubBody`, not `scrubValue`: a raw string here has no key to deny, and
    // `redactFreeText` only catches what it can RECOGNISE — a JSON blob of
    // `candidate_ref` rejoined verbatim. Same rule `request.data` already uses.
    next.extra = scrubBody(next.extra) as typeof next.extra
  }

  if (next.contexts !== undefined && !isWalkableObject(next.contexts)) {
    // `scrubBody`, matching `extra` and `tags`: a raw string here has no key to
    // deny, and `scrubValue` only stops the char-indexed map — the value still
    // rejoins verbatim.
    next.contexts = scrubBody(next.contexts) as typeof next.contexts
  } else if (next.contexts) {
    // `data` is PRE-processed and `http`/`response` are POST-processed, and the
    // split is not arbitrary. `scrubRecord` may RENAME a context key — an
    // address or a path in the name itself — so a generic post-walk lookup found
    // nothing and the body scrub silently did no work. `http` and `response` are
    // literal names the renamer never touches, and they must come AFTER the
    // walk: their `url` is already redacted, and walking it again reduces the
    // path this module works to keep down to a bare origin.
    const prepared: Record<string, unknown> = {}

    const safeContexts = safeClone(next.contexts) ?? { [REDACTED]: REDACTED }

    for (const [name, context] of Object.entries(safeContexts)) {
      // The Array.isArray CHECK is load-bearing; the call it used to guard was
      // not. Without the check an array context reaches `scrubbedContext`, whose
      // `{...context}` clone spreads it into `{"0":…,"1":…}` — shape lost and
      // index keys that deny nothing. But walking it HERE was redundant:
      // `scrubRecord(prepared)` hands every object value to `scrubBody` one line
      // down, and replacing the call with a pass-through is byte-identical.
      //
      // NOT a pass-through, and an earlier version of this comment said walking
      // here was byte-identical. It is not: pass-through delivers `data` under a
      // NAMED key, where it gets `redactFreeText` alone — which by this module's
      // own argument cannot grip a JSON blob. Both that swap and cutting
      // `scrubbedDataEntry` on its own turn the suite red.
      const value =
        context !== null && typeof context === 'object' && !Array.isArray(context)
          ? scrubbedContext(context as Record<string, unknown>)
          : context

      defineOwn(prepared, name, value)
    }

    const walked = scrubRecord(prepared)

    // A `data` entry is a body wherever it sits; these two carry `url` and the
    // query spellings as well, so they get the full request rules.
    for (const name of ['http', 'response'] as const) {
      const original = safeContexts[name]

      if (original && typeof original === 'object' && !Array.isArray(original)) {
        walked[name] = scrubHttpContext(original as Record<string, unknown>)
      }
    }

    next.contexts = walked
  }

  // `tags` is scrubbed for exactly the reason `request.data` is, one field over.
  // It was walked by nothing, and a probe shipped
  // `{"tags":{"route":"/participants/42","candidate_ref":"CR-99"}}` untouched —
  // `candidate_ref` being a key this module already denies. `fingerprint` and
  // `transaction` carry the same shapes and were skipped the same way. The
  // module's contract says "by KEY at any depth"; these are what made it false.
  if (next.tags) {
    // `scrubValue`, not `scrubRecord`: a raw STRING run through `Object.entries`
    // becomes a char-indexed map, `redactFreeText` applies per character and
    // cuts nothing, and the value rejoins verbatim.
    // `scrubBody`, not `scrubValue`: a raw string here has no key to deny, and
    // `redactFreeText` only catches what it can RECOGNISE — a JSON blob of
    // `candidate_ref` rejoined verbatim. Same rule `request.data` already uses.
    next.tags = scrubBody(next.tags) as typeof next.tags
  }

  if (next.transaction !== undefined) {
    next.transaction =
      typeof next.transaction === 'string'
        ? redactFreeText(next.transaction)
        : // Non-string, so `scrubOffShape` — the rule and its argument live
          // there. The STRING arm keeps `redactFreeText` deliberately: a route
          // or a thrown message is readable text, and cutting it destroys
          // Sentry grouping.
          (scrubOffShape(next.transaction) as typeof next.transaction)
  }

  if (next.fingerprint !== undefined) {
    // Unlike the `breadcrumbs` guard, a miss here LEAKS rather than skipping:
    // `fingerprint` is copied into `next` by name, so an unguarded non-array was
    // never scrubbed at all.
    next.fingerprint = Array.isArray(next.fingerprint)
      ? next.fingerprint.map((entry) =>
          // The ELSE keeps the raw value: a non-string element was never
          // scrubbed at all, which is the miss-leaks shape this branch names.
          // `scrubBody` on a container: a NESTED array of JSON blobs had
          // nothing to deny either.
          typeof entry === 'string' ? redactFreeText(entry) : scrubBody(entry)
        )
      : // Off-shape, so the body rule — see the note on `request` above. NOT
        // applied to the ARRAY branch above it: a fingerprint's elements are
        // meaningful strings and cutting them destroys Sentry grouping, which
        // is a worse outcome than a scrubbed one.
        (scrubOffShape(next.fingerprint) as typeof next.fingerprint)
  }

  // `Array.isArray`, matching the guards `fingerprint` and stacktrace `frames`
  // already carry: a malformed `breadcrumbs` threw inside beforeSend.
  if (next.breadcrumbs !== undefined) {
    // A miss LEAKS rather than skips — the value was copied in by name.
    next.breadcrumbs = Array.isArray(next.breadcrumbs)
      ? next.breadcrumbs.map(scrubBreadcrumb)
      : // Off-shape, so the body rule — see the note on `request` above.
        (scrubOffShape(next.breadcrumbs) as typeof next.breadcrumbs)
  }

  // `extra`/`contexts` catch KEYED fields; a thrown error's own message is
  // free text with no key to deny — `entry link ${entryUrl} rejected` would
  // otherwise reach Sentry through the one transport the key-based denylist
  // cannot see.
  if (next.message !== undefined) {
    next.message =
      typeof next.message === 'string'
        ? redactFreeText(next.message)
        : // Non-string, so `scrubOffShape` — the rule and its argument live
          // there. The STRING arm keeps `redactFreeText` deliberately: a route
          // or a thrown message is readable text, and cutting it destroys
          // Sentry grouping.
          (scrubOffShape(next.message) as typeof next.message)
  }

  // GUARDED on presence: a bare assignment creates the key on an event that
  // never had it, and the suite's "does not invent keys the event never had"
  // is there because inventing one is a claim about the event that is false.
  if (next.exception !== undefined) {
    next.exception = scrubExceptionLike(next.exception) as typeof next.exception
  }

  // `threads` carries the IDENTICAL `{values:[{stacktrace:{frames}}]}` shape as
  // `exception`, and it was in `HANDLED_EVENT_FIELDS` with no branch to handle
  // it — which in this walker means "copied raw". Its frames took
  // `redactFreeText` instead of `redactUrl` and collapsed to the bare origin:
  // the symbolication loss `scrubStacktrace` exists to litigate, one field over.
  //
  // Low reachability in a browser SDK — `threads` is mostly native and mobile —
  // but the handled-set comment says an omission here is the loss nothing
  // notices, and it was right again.
  // GUARDED on presence: a bare assignment creates the key on an event that
  // never had it, and the suite's "does not invent keys the event never had"
  // is there because inventing one is a claim about the event that is false.
  if (next.threads !== undefined) {
    next.threads = scrubExceptionLike(next.threads) as typeof next.threads
  }

  // User context is dropped entirely rather than scrubbed field by field —
  // same call the api scrubber makes, for the same reason. An operator's
  // identity adds nothing to a stack trace that org scope does not already
  // give, and there is no case where keeping it is worth the risk of a
  // future Sentry version adding a field this module has never heard of.
  delete next.user

  return next
}
