/**
 * InterviewGuide.vue — the "how this works" block on the consent screen.
 *
 * The contract is that it stays SHORT and i18n-keyed. A candidate reads it once,
 * while nervous, before consenting; a guide that grows to a page of prose is a
 * guide nobody reads, and a hardcoded English literal is one a candidate taking
 * an Italian assessment cannot read at all.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import InterviewGuide from '../../app/components/molecules/InterviewGuide.vue'
import it_ from '../../i18n/locales/it.json'
import en from '../../i18n/locales/en.json'

const tMock = (key: string) => key

describe('InterviewGuide', () => {
  it('renders every step as an ordered list item', () => {
    const wrapper = mount(InterviewGuide, { global: { mocks: { $t: tMock } } })

    expect(wrapper.findAll('ol > li')).toHaveLength(5)
  })

  it('labels its own section with its own heading', () => {
    const wrapper = mount(InterviewGuide, { global: { mocks: { $t: tMock } } })
    const labelledBy = wrapper.get('section').attributes('aria-labelledby')

    expect(labelledBy).toBeTruthy()
    expect(wrapper.get(`#${labelledBy}`).element.tagName).toBe('H2')
  })

  it('routes every string through i18n', () => {
    const wrapper = mount(InterviewGuide, { global: { mocks: { $t: tMock } } })

    expect(wrapper.text()).toContain('interview.guide.title')
    for (let index = 0; index < 5; index += 1) {
      expect(wrapper.text()).toContain(`interview.guide.steps.${index}`)
    }
  })

  it.each([
    ['it', it_],
    ['en', en],
  ])('has all five steps translated in %s', (_locale, messages) => {
    const guide = (messages as { interview: { guide: { steps: Record<string, string> } } })
      .interview.guide

    expect(Object.keys(guide.steps)).toHaveLength(5)
    for (const step of Object.values(guide.steps)) {
      expect(step.trim().length).toBeGreaterThan(0)
    }
  })
})
