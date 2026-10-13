/**
 * The api prepends an optional platform intro phrase INSIDE the single opening
 * string ("<intro> <first question>"). The opening string is handed to the
 * avatar provider by the api (Tavus `custom_greeting`); the frontend never
 * builds it. What the frontend does see is the avatar speaking it back, so
 * these tests pin that the spoken intro (a) reaches the transcript verbatim and
 * (b) never trips end/final-phrase completion detection.
 */
import { describe, it, expect, vi } from 'vitest'
import { matchesEndPhrase } from '~/app/utils/proctor-config'
import { TavusProvider } from '~/app/providers/tavus'

const LOCALES = {
  it: { endPhrase: 'Passiamo alla prossima domanda.', finalPhrase: 'Grazie per il tuo tempo.' },
  en: {
    endPhrase: 'Let us move on to the next question.',
    finalPhrase: 'Thank you for your time.',
  },
} as const

const IT_INTRO =
  'Benvenuto, è un piacere averti qui. Questa conversazione è un colloquio “comportamentale”: ' +
  'ti chiederò di raccontare episodi concreti della tua esperienza, per capire come agisci davvero. ' +
  'Non esistono risposte giuste o sbagliate; è importante che tu risponda con calma, a voce, ' +
  'come in un normale incontro. Se non senti bene o vuoi che ripeta, dillo pure: nessun problema. ' +
  "L'intervista dura circa venti minuti, e puoi prenderti il tempo che ti serve per riflettere. " +
  'Più sei specifico, più il quadro sarà fedele. Ti ringrazio già adesso per l’impegno, ' +
  'e ti auguro un ottimo colloquio: cominciamo con calma, quando sei pronto. ' +
  'Per iniziare, una piccola presentazione: dimmi chi sei e di cosa ti occupi. È tutto chiaro?'
const EN_INTRO =
  'Welcome, it is a pleasure to have you here. This is a "behavioural" conversation: ' +
  'I will ask you to describe concrete episodes from your experience. ' +
  'There are no right or wrong answers, and you can take your time. ' +
  'I will not say thank you just yet, nor move on before you are ready. ' +
  'The more specific you are, the better the picture; the whole thing takes about twenty minutes. ' +
  'Please answer aloud, as in a normal meeting, and ask me to repeat anything you did not catch. ' +
  'Let us begin gently whenever you feel ready.'
const IT_QUESTION = 'Raccontami di una volta in cui hai dovuto cambiare idea davanti a un collega.'
const EN_QUESTION = 'Tell me about a time you changed your mind in front of a colleague.'

describe('opening text (intro + first question) vs completion detection', () => {
  it('uses a realistically long intro (about 600 chars)', () => {
    expect(IT_INTRO.length).toBeGreaterThan(550)
    expect(EN_INTRO.length).toBeGreaterThan(450)
  })

  it.each([
    ['it', `${IT_INTRO} ${IT_QUESTION}`],
    ['en', `${EN_INTRO} ${EN_QUESTION}`],
    ['it', 'Grazie, è un piacere. Cominciamo: dimmi chi sei.'],
    ['it', 'Passiamo subito ai fatti, poi alla domanda successiva: raccontami un episodio.'],
    ['en', 'Thank you for joining. Let us start: who are you?'],
    ['en', 'Thank you for joining, and for coming on time. Next question soon.'],
    ['it', 'PERCHE’ GRAZIE, PER IL TUO impegno: è un’occasione. Tempo permettendo, iniziamo.'],
  ] as const)(
    'does not complete on a %s opening text without the end/final phrases',
    (lang, text) => {
      expect(matchesEndPhrase(text, LOCALES[lang])).toBe(false)
    }
  )

  it.each([
    ['it', `${IT_INTRO} ${IT_QUESTION}`, LOCALES.it.finalPhrase],
    ['it', `${IT_INTRO} ${IT_QUESTION}`, LOCALES.it.endPhrase],
    ['en', `${EN_INTRO} ${EN_QUESTION}`, LOCALES.en.finalPhrase],
    ['en', `${EN_INTRO} ${EN_QUESTION}`, LOCALES.en.endPhrase],
  ] as const)(
    'still completes when a %s text does contain the exact phrase (regression guard)',
    (lang, text, phrase) => {
      expect(matchesEndPhrase(`${text} ${phrase}`, LOCALES[lang])).toBe(true)
      expect(matchesEndPhrase(phrase.toUpperCase(), LOCALES[lang])).toBe(true)
    }
  )
})

describe('TavusProvider speaking the opening text', () => {
  async function run(speech: string) {
    const handlers = new Map<string, ((d: unknown) => void)[]>()
    const frame = {
      on: vi.fn((e: string, cb: (d: unknown) => void) => {
        handlers.set(e, [...(handlers.get(e) ?? []), cb])
      }),
      join: vi.fn().mockResolvedValue(undefined),
      leave: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    const provider = new TavusProvider(vi.fn().mockResolvedValue(frame))
    const states: string[] = []
    const transcripts: string[] = []
    provider.on('state', (s) => states.push(s as string))
    provider.on('transcript', (t) => transcripts.push((t as { text: string }).text))
    await provider.start(document.createElement('div'), {
      dbSessionId: 1,
      conversationUrl: 'https://tavus.daily.co/x',
      ...LOCALES.it,
    })
    for (const cb of handlers.get('app-message') ?? []) {
      cb({
        data: {
          event_type: 'conversation.utterance',
          properties: { role: 'replica', speech },
        },
      })
    }
    return { states, transcripts }
  }

  it('forwards the intro + question to the transcript byte-for-byte without completing', async () => {
    const opening = `${IT_INTRO} ${IT_QUESTION}`
    const { states, transcripts } = await run(opening)

    expect(transcripts).toEqual([opening])
    expect(states).not.toContain('complete')
  })

  it('completes when the spoken text does contain the final phrase', async () => {
    const { states } = await run(`${IT_INTRO} ${LOCALES.it.finalPhrase}`)

    expect(states).toContain('complete')
  })
})
