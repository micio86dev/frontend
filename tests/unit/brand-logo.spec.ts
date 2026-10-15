/**
 * BrandLogo.vue — the one place the organization's mark is drawn (DESIGN.md §3.1 rule 5).
 * Every candidate screen, the live call included, must render it identically.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import BrandLogo from '../../app/components/molecules/BrandLogo.vue'

describe('BrandLogo', () => {
  it('seats the logo on the white rounded plate', () => {
    const wrapper = mount(BrandLogo, { props: { logoUrl: 'https://cdn.test/acme.png' } })
    const logo = wrapper.get('[data-testid="brand-canvas-logo"]')
    const plate = logo.element.parentElement

    expect(logo.attributes('src')).toBe('https://cdn.test/acme.png')
    expect(plate?.className).toContain('bg-card')
    expect(plate?.className).toContain('rounded-lg')
    expect(plate?.className).toContain('border')
  })

  it('leaves the alt empty: the organization name beside it is the accessible text', () => {
    const wrapper = mount(BrandLogo, { props: { logoUrl: 'https://cdn.test/acme.png' } })

    expect(wrapper.get('[data-testid="brand-canvas-logo"]').attributes('alt')).toBe('')
  })

  it.each([null, undefined, ''])('falls back to the BEAI wordmark for %j', (logoUrl) => {
    const wrapper = mount(BrandLogo, { props: { logoUrl } })

    expect(wrapper.text()).toBe('BEAI')
    expect(wrapper.find('img').exists()).toBe(false)
  })
})
