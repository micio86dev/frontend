/**
 * CallTile.vue — the frame of a call tile and its speaking ring
 * (DESIGN.md §3.5, §7.3, §10; change `candidate-interview-call-ui`, D5).
 *
 * The contract pinned here is the ring's STATE and its accessibility, not its
 * pixels: the ring turns on with `data-speaking`, is never signalled by colour
 * alone, never loops, and only transitions where motion is welcome. The class
 * list is asserted because the tile is styled entirely by Tailwind utilities:
 * a utility in the list is the style.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CallTile from '../../app/components/molecules/CallTile.vue'

function mountTile(props: Record<string, unknown> = {}, slots: Record<string, string> = {}) {
  return mount(CallTile, {
    props: { name: 'Interviewer', speakingLabel: 'The interviewer is speaking', ...props },
    slots: { default: '<video data-testid="media" />', ...slots },
  })
}

const RING_SHADOW =
  'data-[speaking=true]:shadow-[0_0_0_2px_var(--color-avatar-bg),0_0_0_5px_var(--color-speaking-ring),0_0_0_7px_var(--color-avatar-bg),0_0_32px_rgb(255_255_255/0.3)]'

describe('CallTile resting state', () => {
  it('is a dark frame with a 2px avatar-bg resting ring and renders its media slot', () => {
    const wrapper = mountTile()

    expect(wrapper.attributes('data-slot')).toBe('call-tile')
    expect(wrapper.classes()).toEqual(
      expect.arrayContaining([
        'relative',
        'overflow-hidden',
        'rounded-surface',
        'bg-avatar-bg',
        'shadow-[0_0_0_2px_var(--color-avatar-bg)]',
      ])
    )
    expect(wrapper.find('[data-testid="media"]').exists()).toBe(true)
  })

  it('reports data-speaking="false" and carries the ring only as a data-variant utility', () => {
    const wrapper = mountTile()

    expect(wrapper.attributes('data-speaking')).toBe('false')
    // The ring composite exists in the class list, but only behind the variant.
    expect(wrapper.classes()).toContain(RING_SHADOW)
  })

  it('shows the name chip with the name and no microphone icon or hidden text', () => {
    const wrapper = mountTile()
    const chip = wrapper.get('[data-slot="call-tile-name"]')

    expect(chip.text()).toContain('Interviewer')
    expect(chip.find('svg').exists()).toBe(false)
    expect(chip.find('.sr-only').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('The interviewer is speaking')
  })
})

describe('CallTile speaking state', () => {
  it('sets data-speaking="true", the attribute the ring variant keys on', () => {
    const wrapper = mountTile({ speaking: true })

    expect(wrapper.attributes('data-speaking')).toBe('true')
    expect(wrapper.classes()).toContain(RING_SHADOW)
  })

  it('draws the ring from avatar-bg and speaking-ring only, never a brand token', () => {
    const ring = mountTile({ speaking: true })
      .classes()
      .filter((c) => c.includes('--color-'))
      .join(' ')

    expect(ring).toContain('--color-speaking-ring')
    expect(ring).toContain('--color-avatar-bg')
    expect(ring).not.toMatch(/primary|brand|canvas|accent|lavender|on-primary/)
  })

  it('shows the microphone icon and visually hidden text on the chip, only when speaking', () => {
    const chip = mountTile({ speaking: true }).get('[data-slot="call-tile-name"]')
    const icon = chip.get('svg')
    const hidden = chip.get('.sr-only')

    expect(icon.attributes('aria-hidden')).toBe('true')
    expect(hidden.text()).toBe('The interviewer is speaking')
  })

  it('removes the icon and the hidden text again when the speaking state ends', async () => {
    const wrapper = mountTile({ speaking: true })

    await wrapper.setProps({ speaking: false })

    const chip = wrapper.get('[data-slot="call-tile-name"]')
    expect(chip.find('svg').exists()).toBe(false)
    expect(chip.find('.sr-only').exists()).toBe(false)
  })

  it('does not make the hidden text a live region, anywhere in the tile', () => {
    const wrapper = mountTile({ speaking: true })
    const html = wrapper.html()

    expect(wrapper.get('.sr-only').attributes('aria-live')).toBeUndefined()
    expect(wrapper.find('[aria-live]').exists()).toBe(false)
    expect(wrapper.find('[role="status"], [role="alert"], [role="log"]').exists()).toBe(false)
    expect(html).not.toContain('aria-live')
  })
})

describe('CallTile motion', () => {
  it.each([false, true])('has no animate-* utility and no infinite loop (speaking: %s)', (on) => {
    const classes = mountTile({ speaking: on }).classes()

    expect(classes.filter((c) => /(?:^|:)animate-/.test(c))).toEqual([])
    expect(classes.filter((c) => c.includes('infinite'))).toEqual([])
  })

  it('transitions the box-shadow in 150ms only under the motion-safe variant', () => {
    const classes = mountTile().classes()

    expect(classes).toEqual(
      expect.arrayContaining([
        'motion-safe:transition-shadow',
        'motion-safe:duration-150',
        'motion-safe:ease-out',
      ])
    )
    // Any transition or duration utility that is not behind motion-safe would
    // also run under `prefers-reduced-motion: reduce`.
    const bare = classes.filter(
      (c) =>
        /(?:^|:)(?:transition|duration|ease|delay)(?:-|$)/.test(c) && !c.startsWith('motion-safe:')
    )
    expect(bare).toEqual([])
  })
})
