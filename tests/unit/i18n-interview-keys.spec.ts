/**
 * i18n interview flow keys — Task 5.2 RED
 *
 * Asserts all required interview-flow i18n keys are present in both it.json and en.json.
 * Spec: D1, D11, "Flow screens — localized states" requirement.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../')

function loadLocale(locale: string): Record<string, unknown> {
  const raw = readFileSync(resolve(ROOT, `i18n/locales/${locale}.json`), 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

function getNestedKey(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

const REQUIRED_KEYS = [
  'interview.consent.title',
  'interview.consent.body',
  'interview.consent.accept',
  'interview.device_check.title',
  'interview.device_check.camera_ok',
  'interview.device_check.mic_ok',
  'interview.device_check.camera_error',
  'interview.device_check.mic_error',
  'interview.device_check.continue',
  'interview.device_check.continue_blocked',
  // Slice 5 (device-check-preview-and-device-selection, D11) — instructional
  // copy, mic-meter non-visual equivalent, browser-neutral recovery (D7), and
  // the micUnavailable dead-end fix (D6).
  'interview.device_check.camera_instruction',
  'interview.device_check.mic_instruction',
  'interview.device_check.mic_detected',
  'interview.device_check.mic_unavailable',
  'interview.device_check.recovery_title',
  'interview.device_check.recovery_instructions',
  'interview.device_check.retry',
  // Slice 6 — device picker labels + numbered fallback names (D11 item 2).
  'interview.device_check.camera_picker_label',
  'interview.device_check.mic_picker_label',
  'interview.device_check.camera_fallback',
  'interview.device_check.mic_fallback',
  'interview.live.timer_label',
  // candidate-interview-call-ui UI-06 — the call side panel: progress sentence and
  // landmark name, the duration maximum (visual + screen-reader text), and the
  // longer per-question timer caption.
  'interview.call.panel_label',
  'interview.call.progress',
  'interview.call.duration_label',
  'interview.call.duration_value',
  'interview.call.duration_sr',
  'interview.call.question_timer_label',
  // candidate-interview-call-ui UI-08 — the audio/video help link and its
  // visually hidden new-tab note.
  'interview.call.help.label',
  'interview.call.help.new_tab',
  'interview.live.pause',
  'interview.scheduled_pause.title',
  'interview.scheduled_pause.body',
  'interview.scheduled_pause.resume',
  'interview.end_of_question.title',
  'interview.end_of_question.next',
  'interview.end_of_question.pause',
  'interview.paused.title',
  'interview.paused.resume',
  'interview.done.title',
  'interview.done.body',
  'interview.error.title',
  'interview.error.retry',
  // participant-error-recovery D8 — must be true whether retry works
  // (429-exhausted, ClientError->500 leaves the participant untouched) or is
  // fatal (Upstream->errore): retry-now, and operator-must-reopen if the
  // problem persists. Enforced structurally below (D-F pattern), not just by
  // key presence.
  'interview.error.body',
  'interview.terminal.403.title',
  'interview.terminal.403.body',
  'interview.terminal.absent_phrase.title',
  'interview.terminal.absent_phrase.body',
  'interview.terminal.absent_phrase.contact',
  // candidate-session-auth Phase 3 (Task 3.5/3.6) — new honest failure copy.
  // session_expired MUST NOT suggest requesting/using a new link will help
  // (D-F) — enforced structurally below, not just by key presence.
  'interview.terminal.session_expired.title',
  'interview.terminal.session_expired.body',
  'interview.terminal.spent_link.title',
  'interview.terminal.spent_link.body',
  // public-api step 5 — hosted entry route (`/i/{token}`), `GET
  // /api/embed/exchange` error mapping (G-32): a consumed/replaced session
  // token (410) vs an expired/malformed one (401) get distinct, honest copy
  // — neither implies the OTHER failure's remedy would help.
  'interview.terminal.link_used.title',
  'interview.terminal.link_used.body',
  'interview.terminal.link_invalid.title',
  'interview.terminal.link_invalid.body',
  // reusable-interview-links — the reusable entry route (`/interview/reusable`)
  // and its three non-terminal states: loading, busy (429) and failed
  // (network / 5xx). An unknown or disabled link is the existing
  // `link_invalid` terminal above, not a new key.
  'interview.reusable.loading',
  'interview.reusable.busy.title',
  'interview.reusable.busy.body',
  'interview.reusable.failed.title',
  'interview.reusable.failed.body',
  'interview.reusable.retry',
  // reusable-link-visitor-identity — the identity form the reusable entry route
  // shows before it redeems (DESIGN.md §16.19): heading and intro, the two field
  // labels, the privacy notice, the submit control in its two states, and every
  // message the client validation and the 409/422 mapping can show.
  'interview.reusable.identity.title',
  'interview.reusable.identity.intro',
  'interview.reusable.identity.name.label',
  'interview.reusable.identity.email.label',
  'interview.reusable.identity.privacy',
  'interview.reusable.identity.submit',
  'interview.reusable.identity.submitting',
  'interview.reusable.identity.errors.nameRequired',
  'interview.reusable.identity.errors.nameTooLong',
  'interview.reusable.identity.errors.nameInvalid',
  'interview.reusable.identity.errors.emailRequired',
  'interview.reusable.identity.errors.emailInvalid',
  'interview.reusable.identity.errors.emailTooLong',
  'interview.reusable.identity.errors.emailTaken',
  // A reload while the identity form is shown loses the in-memory token: its own
  // terminal, distinct from `link_invalid` (which would be untrue).
  'interview.terminal.link_reopen.title',
  'interview.terminal.link_reopen.body',
  // candidate-interview-call-ui UI-05 — the own-camera tile and the interviewer chip.
  'interview.call.interviewer_name',
  'interview.call.you',
  // UI-09 — the hidden text a lit tile carries (the ring is never colour alone).
  'interview.call.avatar_speaking',
  'interview.call.candidate_speaking',
  'interview.call.self_view',
  'interview.call.self_view_off',
  // candidate-interview-call-ui UI-07 — the Exit button, its confirmation, and the
  // suspended screen. The two `_no_deadline` bodies exist because the deadline is
  // dropped, not guessed, when the stored session cannot be read.
  'interview.call.exit.label',
  'interview.call.exit.title',
  'interview.call.exit.body',
  'interview.call.exit.body_no_deadline',
  'interview.call.exit.confirm',
  'interview.call.exit.cancel',
  'interview.call.suspended.title',
  'interview.call.suspended.body',
  'interview.call.suspended.body_no_deadline',
]

describe('i18n interview flow keys', () => {
  const locales = ['it', 'en']

  for (const locale of locales) {
    describe(`locale: ${locale}`, () => {
      const data = loadLocale(locale)

      for (const key of REQUIRED_KEYS) {
        it(`has key "${key}"`, () => {
          const value = getNestedKey(data, key)
          expect(value, `Missing key "${key}" in ${locale}.json`).toBeDefined()
          expect(typeof value, `Key "${key}" in ${locale}.json is not a string`).toBe('string')
          expect(value as string, `Key "${key}" in ${locale}.json is empty`).not.toBe('')
        })
      }
    })
  }

  // ---------------------------------------------------------------------------
  // D-F: the expired-session terminal MUST NOT imply a new link will help — a
  // candidate whose session expired after pausing has no self-serve path back
  // in (a fresh sso-link is refused at the exchange pre-flight read for any
  // non-`in_attesa` status). Enforced structurally, not just by key presence.
  // ---------------------------------------------------------------------------

  describe('session_expired copy never suggests a new link will help (D-F)', () => {
    const linkWordPattern = /\blink\b/i

    for (const locale of locales) {
      it(`${locale}.json — session_expired body does not mention "link"`, () => {
        const data = loadLocale(locale)
        const body = getNestedKey(data, 'interview.terminal.session_expired.body') as string
        expect(body).not.toMatch(linkWordPattern)
      })

      it(`${locale}.json — session_expired title does not mention "link"`, () => {
        const data = loadLocale(locale)
        const title = getNestedKey(data, 'interview.terminal.session_expired.title') as string
        expect(title).not.toMatch(linkWordPattern)
      })
    }
  })

  // ---------------------------------------------------------------------------
  // participant-error-recovery D8: interview.error.body must NOT promise an
  // UNCONDITIONAL resume. A ClientError/Throttle failure leaves the
  // participant untouched (retry genuinely works), but an Upstream failure
  // flips the participant to `errore` — recoverable only by an operator, not
  // by retrying. Locale-specific because "resume" phrasing differs per
  // language (unlike D-F's "link", which is the same word in both).
  // ---------------------------------------------------------------------------

  describe('interview.error.body never promises an unconditional resume (participant-error-recovery D8)', () => {
    const resumePromisePattern: Record<string, RegExp> = {
      it: /riprender|dal punto in cui/i,
      en: /resume|where you left off/i,
    }

    for (const locale of locales) {
      it(`${locale}.json — interview.error.body does not promise an unconditional resume`, () => {
        const data = loadLocale(locale)
        const body = getNestedKey(data, 'interview.error.body') as string
        expect(body).not.toMatch(resumePromisePattern[locale])
      })
    }
  })

  // ---------------------------------------------------------------------------
  // reusable-interview-links: the busy and failed states are RETRYABLE, so they
  // must never tell the visitor the link is bad — that is the one thing a
  // 429 or a network blip does not mean, and the wording is what makes someone
  // walk away from a link that would have worked a moment later.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // reusable-link-visitor-identity: the copy the SPEC fixes word for word. Where
  // the design's first draft differed, the spec string is the normative one
  // (reconciliation R1), so these are exact pins, not key-presence checks.
  // ---------------------------------------------------------------------------

  describe('spec-normative identity copy is pinned exactly', () => {
    const PINNED: Record<string, Record<string, string>> = {
      en: {
        'interview.reusable.identity.privacy':
          'Your name and email are shared with the organization running this interview so your interview can be identified and requests about your data can be handled.',
        'interview.reusable.identity.errors.emailTaken':
          'This email address has already been used for this interview. Please contact the person who shared the link with you.',
        'interview.terminal.link_reopen.title': 'Please open the link again',
        'interview.terminal.link_reopen.body':
          'This page was reloaded, so your interview link is no longer here. Open the link again (scan the QR code or use the message you received) to start.',
      },
      it: {
        'interview.reusable.identity.privacy':
          "Il tuo nome e la tua email sono condivisi con l'organizzazione che conduce il colloquio, così che il tuo colloquio possa essere identificato e le richieste relative ai tuoi dati possano essere gestite.",
        'interview.reusable.identity.errors.emailTaken':
          'Questo indirizzo email è già stato utilizzato per questo colloquio. Contatta chi ti ha condiviso il link.',
        'interview.terminal.link_reopen.title': 'Apri di nuovo il link',
        'interview.terminal.link_reopen.body':
          'Questa pagina è stata ricaricata, quindi il link del tuo colloquio non è più qui. Riapri il link (inquadra di nuovo il codice QR oppure usa il messaggio ricevuto) per iniziare.',
      },
    }

    for (const locale of locales) {
      for (const [key, expected] of Object.entries(PINNED[locale] as Record<string, string>)) {
        it(`${locale}.json — "${key}" is the spec string`, () => {
          expect(getNestedKey(loadLocale(locale), key)).toBe(expected)
        })
      }
    }
  })

  describe('a duplicate email never promises a resume', () => {
    // 409 means "this address already enrolled here". The visitor is never
    // resumed into that interview (that would hand it to whoever typed the
    // address), so the copy must not suggest a way back in.
    const resumeWord: Record<string, RegExp> = { en: /resum/i, it: /riprend/i }

    for (const locale of locales) {
      it(`${locale}.json — emailTaken does not claim a resume is possible`, () => {
        const value = getNestedKey(
          loadLocale(locale),
          'interview.reusable.identity.errors.emailTaken'
        ) as string

        expect(value).not.toMatch(resumeWord[locale] as RegExp)
      })
    }
  })

  describe('the identity form never promises verification', () => {
    // The email is accepted as typed and is NOT verified (OD-1): copy that
    // mentions a code or a confirmation would be untrue.
    const verifyWord: Record<string, RegExp> = {
      en: /verif|confirmation|code/i,
      it: /verific|conferma|codice/i,
    }

    for (const locale of locales) {
      for (const key of [
        'interview.reusable.identity.intro',
        'interview.reusable.identity.privacy',
        'interview.reusable.identity.submit',
      ]) {
        it(`${locale}.json — ${key} does not mention verification`, () => {
          const value = getNestedKey(loadLocale(locale), key) as string

          expect(value).not.toMatch(verifyWord[locale] as RegExp)
        })
      }
    }
  })

  describe('the reopen terminal is distinct from link_invalid and never claims the link is bad', () => {
    for (const locale of locales) {
      it(`${locale}.json — link_reopen differs from link_invalid`, () => {
        const data = loadLocale(locale)

        expect(getNestedKey(data, 'interview.terminal.link_reopen.title')).not.toBe(
          getNestedKey(data, 'interview.terminal.link_invalid.title')
        )
        expect(getNestedKey(data, 'interview.terminal.link_reopen.body')).not.toBe(
          getNestedKey(data, 'interview.terminal.link_invalid.body')
        )
      })
    }
  })

  // ---------------------------------------------------------------------------
  // Key parity: a key present in one locale only renders as the raw key path for
  // every visitor of the other, and nothing else would notice.
  // ---------------------------------------------------------------------------

  describe('en and it carry exactly the same keys', () => {
    function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
      return Object.entries(obj).flatMap(([key, value]) =>
        value !== null && typeof value === 'object'
          ? flatten(value as Record<string, unknown>, `${prefix}${key}.`)
          : [`${prefix}${key}`]
      )
    }

    it('has no key in en.json that is missing from it.json', () => {
      const it_ = new Set(flatten(loadLocale('it')))

      expect(flatten(loadLocale('en')).filter((key) => !it_.has(key))).toEqual([])
    })

    it('has no key in it.json that is missing from en.json', () => {
      const en = new Set(flatten(loadLocale('en')))

      expect(flatten(loadLocale('it')).filter((key) => !en.has(key))).toEqual([])
    })
  })

  describe('the retryable reusable states never call the link invalid', () => {
    const invalidPattern: Record<string, RegExp> = {
      it: /non (?:è )?(?:più )?valid|scadut|disattivat/i,
      en: /not (?:a )?valid|invalid|expired|no longer|disabled/i,
    }

    for (const locale of locales) {
      for (const key of [
        'interview.reusable.busy.title',
        'interview.reusable.busy.body',
        'interview.reusable.failed.title',
        'interview.reusable.failed.body',
      ]) {
        it(`${locale}.json — ${key} does not claim the link is invalid`, () => {
          const value = getNestedKey(loadLocale(locale), key) as string

          expect(value).toMatch(/\S/)
          expect(value).not.toMatch(invalidPattern[locale] as RegExp)
        })
      }
    }
  })
})
