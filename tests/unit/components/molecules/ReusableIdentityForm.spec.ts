/**
 * ReusableIdentityForm — the presentational form a reusable-link visitor fills
 * in before the interview starts (DESIGN.md §16.19; spec "Reusable Identity Form
 * Content And Validation" and "Reusable Identity Form Is Accessible And
 * Localized").
 *
 * The component knows nothing about tokens, storage or the API: it validates what
 * was typed, shows the app's OWN localized messages, and emits the trimmed values.
 * The contract worth pinning is therefore the accessibility wiring and the
 * privacy posture, not the visuals:
 *
 *   - an id that `aria-describedby` points at must exist (a dangling reference is
 *     an axe violation), so the attribute is present ONLY while an error shows;
 *   - blur validates one field, submit validates all of them, never short-circuited;
 *   - the typed identity is never written anywhere.
 *
 * `$t` is backed by the REAL `en.json`, so the assertions read the shipped copy
 * rather than echoing a key back at themselves.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import ReusableIdentityForm from '../../../../app/components/molecules/ReusableIdentityForm.vue'
import en from '../../../../i18n/locales/en.json'

type Props = {
  submitting?: boolean
  serverErrors?: Partial<
    Record<
      'displayName' | 'email',
      'nameInvalid' | 'emailInvalid' | 'emailTaken' | 'nameRequired' | 'emailRequired'
    >
  >
  initialDisplayName?: string
  initialEmail?: string
}

function resolveEn(key: string): string {
  const found = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      en
    )
  if (typeof found !== 'string') throw new Error(`en.json has no string at "${key}"`)
  // vue-i18n renders the literal `{'@'}` as `@`; do the same so assertions read what a visitor reads.
  return found.replaceAll("{'@'}", '@')
}

const mounted: VueWrapper[] = []

function mountForm(props: Props = {}) {
  const wrapper = mount(ReusableIdentityForm, {
    props: { submitting: false, ...props },
    attachTo: document.body,
    global: { mocks: { $t: resolveEn } },
  })
  mounted.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount()
  vi.restoreAllMocks()
})

const NAME = '#reusable-identity-name'
const EMAIL = '#reusable-identity-email'
const ERR = (field: 'name' | 'email') => `#reusable-identity-${field}-error`

async function fill(wrapper: VueWrapper, selector: string, value: string) {
  await wrapper.get(selector).setValue(value)
}

describe('ReusableIdentityForm: structure', () => {
  it('is a novalidate form with a test id, so the script validation speaks, not the browser bubble', () => {
    const form = mountForm().get('form')

    expect(form.attributes('novalidate')).toBeDefined()
    expect(form.attributes('data-testid')).toBe('reusable-identity-form')
  })

  it('binds each visible label to its input by for/id', () => {
    const wrapper = mountForm()

    const nameLabel = wrapper.get('label[for="reusable-identity-name"]')
    const emailLabel = wrapper.get('label[for="reusable-identity-email"]')

    expect(nameLabel.text()).toBe('Full name')
    expect(emailLabel.text()).toBe('Email')
    expect(wrapper.get(NAME).element.tagName).toBe('INPUT')
    expect(wrapper.get(EMAIL).element.tagName).toBe('INPUT')
  })

  it('orders the fields name, then email', () => {
    const inputs = mountForm().findAll('input')

    expect(inputs.map((i) => i.attributes('id'))).toEqual([
      'reusable-identity-name',
      'reusable-identity-email',
    ])
  })

  it('gives the email input the keyboard and autofill hints that avoid a corrupted address', () => {
    const email = mountForm().get(EMAIL)

    expect(email.attributes('type')).toBe('email')
    expect(email.attributes('name')).toBe('email')
    expect(email.attributes('autocomplete')).toBe('email')
    expect(email.attributes('inputmode')).toBe('email')
    expect(email.attributes('autocapitalize')).toBe('off')
    expect(email.attributes('spellcheck')).toBe('false')
  })

  it('gives the name input the WCAG 1.3.5 autocomplete token', () => {
    const name = mountForm().get(NAME)

    expect(name.attributes('autocomplete')).toBe('name')
    expect(name.attributes('name')).toBe('name')
    expect(name.attributes('autocapitalize')).toBe('words')
  })

  it('marks both inputs required and aria-required', () => {
    const wrapper = mountForm()

    for (const selector of [NAME, EMAIL]) {
      expect(wrapper.get(selector).attributes('required')).toBeDefined()
      expect(wrapper.get(selector).attributes('aria-required')).toBe('true')
    }
  })

  it('never sets maxlength: a browser truncates silently and would store a different address', () => {
    const wrapper = mountForm()

    for (const input of wrapper.findAll('input')) {
      expect(input.attributes('maxlength')).toBeUndefined()
    }
  })

  it('offers no checkbox, no link and no verification control (OD-1, OD-2)', () => {
    const wrapper = mountForm()

    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
    expect(wrapper.find('[role="checkbox"]').exists()).toBe(false)
    expect(wrapper.find('a').exists()).toBe(false)
    // exactly the two identity inputs: a code box would be a third
    expect(wrapper.findAll('input')).toHaveLength(2)
    expect(wrapper.text()).not.toMatch(/verif|confirmation|code/i)
  })
})

describe('ReusableIdentityForm: privacy notice and submit control', () => {
  it('renders the privacy notice as visible text and links the submit button to it', () => {
    const wrapper = mountForm()
    const submit = wrapper.get('[data-testid="reusable-identity-submit"]')
    const notice = wrapper.get('#reusable-identity-privacy')

    expect(submit.attributes('aria-describedby')).toBe('reusable-identity-privacy')
    expect(notice.text()).toBe(en.interview.reusable.identity.privacy)
  })

  it('puts the notice ABOVE the submit button', () => {
    const wrapper = mountForm()
    const notice = wrapper.get('#reusable-identity-privacy').element
    const submit = wrapper.get('[data-testid="reusable-identity-submit"]').element

    expect(notice.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('has a real submit button that reads "Start the interview"', () => {
    const submit = mountForm().get('[data-testid="reusable-identity-submit"]')

    expect(submit.element.tagName).toBe('BUTTON')
    expect(submit.attributes('type')).toBe('submit')
    expect(submit.text()).toBe('Start the interview')
    expect(submit.attributes('disabled')).toBeUndefined()
    expect(submit.attributes('aria-busy')).toBeUndefined()
  })

  it('is disabled and aria-busy while a request is in flight, on the button and on the form', () => {
    const wrapper = mountForm({ submitting: true })
    const submit = wrapper.get('[data-testid="reusable-identity-submit"]')

    expect(submit.attributes('disabled')).toBeDefined()
    expect(submit.attributes('aria-busy')).toBe('true')
    expect(wrapper.get('form').attributes('aria-busy')).toBe('true')
    expect(submit.text()).toBe('Starting…')
  })

  it('does not emit when submitted while a request is in flight', async () => {
    const wrapper = mountForm({
      submitting: true,
      initialDisplayName: 'Ada Lovelace',
      initialEmail: 'ada@example.com',
    })

    await wrapper.get('form').trigger('submit')

    expect(wrapper.emitted('submit')).toBeUndefined()
  })
})

describe('ReusableIdentityForm: focus and prefill', () => {
  it('does not autofocus on mount: a screen-reader user meets the heading and intro first', () => {
    const wrapper = mountForm()

    expect(wrapper.find('[autofocus]').exists()).toBe(false)
    expect(document.activeElement).toBe(document.body)
  })

  it('prefills from initialDisplayName and initialEmail so a retry does not retype', () => {
    const wrapper = mountForm({
      initialDisplayName: 'Ada Lovelace',
      initialEmail: 'ada@example.com',
    })

    expect((wrapper.get(NAME).element as HTMLInputElement).value).toBe('Ada Lovelace')
    expect((wrapper.get(EMAIL).element as HTMLInputElement).value).toBe('ada@example.com')
  })
})

describe('ReusableIdentityForm: no error is shown until it is earned', () => {
  it('starts with no aria-invalid, no aria-describedby and no error element', () => {
    const wrapper = mountForm()

    for (const selector of [NAME, EMAIL]) {
      expect(wrapper.get(selector).attributes('aria-invalid')).toBeUndefined()
      expect(wrapper.get(selector).attributes('aria-describedby')).toBeUndefined()
    }
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('validates ONE field on blur and leaves an untouched empty field alone', async () => {
    const wrapper = mountForm()

    await wrapper.get(EMAIL).trigger('blur')

    expect(wrapper.get(ERR('email')).text()).toBe('Enter your email.')
    expect(wrapper.find(ERR('name')).exists()).toBe(false)
    expect(wrapper.get(NAME).attributes('aria-invalid')).toBeUndefined()
  })

  it('shows the field error with aria-invalid and an aria-describedby that points at it', async () => {
    const wrapper = mountForm()

    await wrapper.get(NAME).trigger('blur')

    const name = wrapper.get(NAME)
    expect(name.attributes('aria-invalid')).toBe('true')
    expect(name.attributes('aria-describedby')).toBe('reusable-identity-name-error')
    const error = wrapper.get('#reusable-identity-name-error')
    expect(error.attributes('role')).toBe('alert')
    expect(error.text()).toBe('Enter your name.')
  })

  it('drops the error, the attribute AND the dangling reference once the value is fixed', async () => {
    const wrapper = mountForm()
    await wrapper.get(EMAIL).trigger('blur')
    expect(wrapper.find(ERR('email')).exists()).toBe(true)

    await fill(wrapper, EMAIL, 'ada@example.com')

    expect(wrapper.find(ERR('email')).exists()).toBe(false)
    expect(wrapper.get(EMAIL).attributes('aria-invalid')).toBeUndefined()
    expect(wrapper.get(EMAIL).attributes('aria-describedby')).toBeUndefined()
  })

  it.each([
    ['', 'Enter your name.'],
    ['   ', 'Enter your name.'],
    ['a'.repeat(256), 'Your name can be at most 255 characters.'],
  ])('refuses the name %j on blur with its own localized message', async (value, message) => {
    const wrapper = mountForm()
    await fill(wrapper, NAME, value)

    await wrapper.get(NAME).trigger('blur')

    expect(wrapper.get(ERR('name')).text()).toBe(message)
  })

  it.each([
    ['', 'Enter your email.'],
    ['not-an-email', 'Enter a valid email address, like name@example.com.'],
    ['a@b.c'.padStart(256, 'a'), 'Your email can be at most 255 characters.'],
  ])('refuses the email %j on blur with its own localized message', async (value, message) => {
    const wrapper = mountForm()
    await fill(wrapper, EMAIL, value)

    await wrapper.get(EMAIL).trigger('blur')

    expect(wrapper.get(ERR('email')).text()).toBe(message)
  })
})

describe('ReusableIdentityForm: submit', () => {
  it('validates ALL fields on an empty submit, never short-circuited, and emits nothing', async () => {
    const wrapper = mountForm()

    await wrapper.get('form').trigger('submit')

    expect(wrapper.get(ERR('name')).text()).toBe('Enter your name.')
    expect(wrapper.get(ERR('email')).text()).toBe('Enter your email.')
    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('focuses the FIRST invalid field: the name when both are empty', async () => {
    const wrapper = mountForm()

    await wrapper.get('form').trigger('submit')

    expect(document.activeElement).toBe(wrapper.get(NAME).element)
  })

  it('focuses the email when only the email is invalid', async () => {
    const wrapper = mountForm({ initialDisplayName: 'Ada Lovelace', initialEmail: 'nope' })

    await wrapper.get('form').trigger('submit')

    expect(wrapper.find(ERR('name')).exists()).toBe(false)
    expect(wrapper.get(ERR('email')).text()).toBe(
      'Enter a valid email address, like name@example.com.'
    )
    expect(document.activeElement).toBe(wrapper.get(EMAIL).element)
  })

  it('emits the TRIMMED values exactly once on a valid submit', async () => {
    const wrapper = mountForm()
    await fill(wrapper, NAME, '  Ada Lovelace  ')
    await fill(wrapper, EMAIL, '  ada@example.com ')

    await wrapper.get('form').trigger('submit')

    expect(wrapper.emitted('submit')).toEqual([
      [{ displayName: 'Ada Lovelace', email: 'ada@example.com' }],
    ])
  })

  it('accepts a 255-character name and a well-formed email', async () => {
    const wrapper = mountForm()
    await fill(wrapper, NAME, 'a'.repeat(255))
    await fill(wrapper, EMAIL, 'ada@example.com')

    await wrapper.get('form').trigger('submit')

    expect(wrapper.emitted('submit')).toHaveLength(1)
  })

  it('submits when the visitor activates the submit button', async () => {
    const wrapper = mountForm({
      initialDisplayName: 'Ada Lovelace',
      initialEmail: 'ada@example.com',
    })

    await wrapper.get('[data-testid="reusable-identity-submit"]').trigger('click')

    expect(wrapper.emitted('submit')).toEqual([
      [{ displayName: 'Ada Lovelace', email: 'ada@example.com' }],
    ])
  })
})

describe('ReusableIdentityForm: server errors', () => {
  it('renders the mapped localized message on the named field, never server text', async () => {
    const wrapper = mountForm({ serverErrors: { email: 'emailTaken' } })
    await flushPromises()

    expect(wrapper.get(ERR('email')).text()).toBe(en.interview.reusable.identity.errors.emailTaken)
    expect(wrapper.get(EMAIL).attributes('aria-invalid')).toBe('true')
    expect(wrapper.get(EMAIL).attributes('aria-describedby')).toBe('reusable-identity-email-error')
    expect(wrapper.find(ERR('name')).exists()).toBe(false)
  })

  it('focuses the field carrying a server error when the form is shown with one', async () => {
    const wrapper = mountForm({ serverErrors: { email: 'emailTaken' } })
    await flushPromises()

    expect(document.activeElement).toBe(wrapper.get(EMAIL).element)
  })

  it('focuses the first field carrying a server error when one arrives later', async () => {
    const wrapper = mountForm({
      initialDisplayName: 'Ada Lovelace',
      initialEmail: 'ada@example.com',
    })
    expect(document.activeElement).toBe(document.body)

    await wrapper.setProps({ serverErrors: { displayName: 'nameInvalid', email: 'emailInvalid' } })
    await nextTick()

    expect(document.activeElement).toBe(wrapper.get(NAME).element)
    expect(wrapper.get(ERR('name')).text()).toBe('Check the name you entered.')
    expect(wrapper.get(ERR('email')).text()).toBe(
      'Enter a valid email address, like name@example.com.'
    )
  })

  it('clears a server error as soon as that field is edited, and only that field', async () => {
    const wrapper = mountForm({
      initialDisplayName: 'Ada Lovelace',
      initialEmail: 'ada@example.com',
      serverErrors: { displayName: 'nameInvalid', email: 'emailTaken' },
    })
    await flushPromises()

    await fill(wrapper, EMAIL, 'ada.l@example.com')

    expect(wrapper.find(ERR('email')).exists()).toBe(false)
    expect(wrapper.get(EMAIL).attributes('aria-invalid')).toBeUndefined()
    expect(wrapper.get(ERR('name')).text()).toBe('Check the name you entered.')
  })

  it('shows the server word over a stale client error on the same field', async () => {
    const wrapper = mountForm()
    await wrapper.get(EMAIL).trigger('blur')
    expect(wrapper.get(ERR('email')).text()).toBe('Enter your email.')

    await wrapper.setProps({ serverErrors: { email: 'emailTaken' } })

    expect(wrapper.get(ERR('email')).text()).toBe(en.interview.reusable.identity.errors.emailTaken)
  })

  it('shows the error again when the same server error is delivered a second time', async () => {
    const wrapper = mountForm({ initialDisplayName: 'Ada', initialEmail: 'ada@example.com' })
    await wrapper.setProps({ serverErrors: { email: 'emailTaken' } })
    await fill(wrapper, EMAIL, 'ada2@example.com')
    expect(wrapper.find(ERR('email')).exists()).toBe(false)

    await wrapper.setProps({ serverErrors: {} })
    await wrapper.setProps({ serverErrors: { email: 'emailTaken' } })

    expect(wrapper.get(ERR('email')).text()).toBe(en.interview.reusable.identity.errors.emailTaken)
  })
})

describe('ReusableIdentityForm: the typed identity is never persisted', () => {
  it('writes nothing to localStorage or sessionStorage while typing, blurring and submitting', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const wrapper = mountForm()

    await fill(wrapper, NAME, 'Ada Lovelace')
    await wrapper.get(NAME).trigger('blur')
    await fill(wrapper, EMAIL, 'ada@example.com')
    await wrapper.get(EMAIL).trigger('blur')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(setItem).not.toHaveBeenCalled()
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/Ada|ada@/)
    expect(JSON.stringify({ ...sessionStorage })).not.toMatch(/Ada|ada@/)
  })

  it('leaves the address bar and cookies alone', async () => {
    const before = { href: window.location.href, cookie: document.cookie }
    const wrapper = mountForm()

    await fill(wrapper, NAME, 'Ada Lovelace')
    await fill(wrapper, EMAIL, 'ada@example.com')
    await wrapper.get('form').trigger('submit')

    expect(window.location.href).toBe(before.href)
    expect(document.cookie).toBe(before.cookie)
  })
})

/**
 * A blur caused by pressing Start does not validate on its own.
 *
 * Pressing the button blurs the field first; validating there inserts the
 * field's error ABOVE the button between mousedown and mouseup, the button
 * moves, and the click lands somewhere else: the visitor pressed Start and
 * nothing happened. Submit validates every field anyway (and focuses the first
 * invalid one), so skipping the blur check for that one case loses nothing.
 */
describe('ReusableIdentityForm: pressing Start is never swallowed by the blur check', () => {
  const SUBMIT = '[data-testid="reusable-identity-submit"]'

  it('does not validate a field that loses focus because the pointer pressed Start', async () => {
    const wrapper = mountForm()
    await fill(wrapper, EMAIL, 'ana@gmail')

    wrapper.get(SUBMIT).element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await wrapper.get(EMAIL).trigger('blur')

    expect(wrapper.find(ERR('email')).exists()).toBe(false)
  })

  it('still validates when the keyboard tabs from the field to Start', async () => {
    const wrapper = mountForm()
    await fill(wrapper, EMAIL, 'ana@gmail')
    const submit = wrapper.get(SUBMIT).element

    wrapper.get(EMAIL).element.dispatchEvent(new FocusEvent('blur', { relatedTarget: submit }))
    await nextTick()

    expect(wrapper.find(ERR('email')).exists()).toBe(true)
  })

  it('validates on blur again once the press is over', async () => {
    const wrapper = mountForm()
    await fill(wrapper, EMAIL, 'ana@gmail')
    const submit = wrapper.get(SUBMIT).element

    submit.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    submit.dispatchEvent(new Event('pointerup', { bubbles: true }))
    await wrapper.get(EMAIL).trigger('blur')

    expect(wrapper.find(ERR('email')).exists()).toBe(true)
  })
})
