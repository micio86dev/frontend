/**
 * CallMicMutedBadge — the informative badge shown while the microphone is off.
 *
 * Pinned: it renders only while `visible`, inside a persistent polite live region (so the
 * appearance is announced); copy comes from the shipped locales; the action emits `unmute`;
 * red background with white text; the action is a white button with red text.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CallMicMutedBadge from '~/app/components/molecules/CallMicMutedBadge.vue'
import en from '../../i18n/locales/en.json'
import it_ from '../../i18n/locales/it.json'

const t = (locale: typeof en) => (key: string) =>
  key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      locale
    ) as string

function mountBadge(visible: boolean, locale = it_) {
  return mount(CallMicMutedBadge, {
    props: { visible },
    global: { mocks: { $t: t(locale as typeof en) } },
  })
}

describe('CallMicMutedBadge', () => {
  it('keeps the live region but renders no badge while hidden', () => {
    const wrapper = mountBadge(false)

    expect(wrapper.get('[role="status"]').attributes('aria-live')).toBe('polite')
    expect(wrapper.find('[data-testid="call-mic-muted-badge"]').exists()).toBe(false)
  })

  it('shows the Italian message and the Riattiva action while visible', () => {
    const wrapper = mountBadge(true)

    expect(wrapper.get('[data-testid="call-mic-muted-badge"]').text()).toContain(
      "Microfono spento: l'intervistatore non ti sente."
    )
    expect(wrapper.get('[data-testid="call-mic-muted-unmute"]').text()).toBe('Riattiva')
  })

  it('has English copy too', () => {
    const wrapper = mountBadge(true, en as typeof it_)

    expect(wrapper.get('[data-testid="call-mic-muted-unmute"]').text()).toBe('Unmute')
  })

  it('emits unmute when the action is clicked', async () => {
    const wrapper = mountBadge(true)

    await wrapper.get('[data-testid="call-mic-muted-unmute"]').trigger('click')

    expect(wrapper.emitted('unmute')).toHaveLength(1)
  })

  it('is a red badge with white text and a white action with red text', () => {
    const wrapper = mountBadge(true)

    expect(wrapper.get('[data-testid="call-mic-muted-badge"]').classes()).toEqual(
      expect.arrayContaining(['bg-error-dark', 'text-white'])
    )
    expect(wrapper.get('[data-testid="call-mic-muted-unmute"]').classes()).toEqual(
      expect.arrayContaining(['bg-card', 'text-error-dark'])
    )
  })
})
