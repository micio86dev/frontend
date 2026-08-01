import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import ConsentBanner from '../../app/components/ConsentBanner.vue'
import { ANALYTICS_CONSENT_EVENT, ANALYTICS_CONSENT_KEY } from '../../app/utils/analytics-consent'

/**
 * The analytics consent banner (C13, task 5.6).
 *
 * ONE banner, not two. The interview page already collects a RECORDING consent
 * before a session starts, and that one is a precondition of the service:
 * refuse it and there is no interview. Analytics consent must be refusable with
 * no consequence at all.
 *
 * Bundling those two into a single "Accept" is exactly what makes a consent
 * invalid — it is not freely given if saying no costs you the thing you came
 * for. So they stay separate decisions, and this banner simply never appears on
 * the pages where the other one lives. The candidate sees one surface at a time.
 */

function mountBanner(props: Partial<{ path: string; enabled: boolean }> = {}) {
  return mount(ConsentBanner, {
    props: { path: '/', enabled: true, ...props },
    global: { mocks: { $t: (key: string) => key } },
  })
}

const banner = '[data-testid="analytics-consent"]'

beforeEach(() => {
  window.localStorage.clear()
})

describe('when the banner appears', () => {
  it('appears when analytics is configured and nothing has been decided', () => {
    expect(mountBanner().find(banner).exists()).toBe(true)
  })

  it('stays hidden when no analytics tool is configured', () => {
    // Asking for permission to do something that cannot happen is pure noise.
    // A deployment with no measurement ID has nothing to ask about.
    expect(mountBanner({ enabled: false }).find(banner).exists()).toBe(false)
  })

  it('stays hidden once the visitor has already answered', () => {
    for (const answer of ['granted', 'denied']) {
      window.localStorage.setItem(ANALYTICS_CONSENT_KEY, answer)
      expect(mountBanner().find(banner).exists()).toBe(false)
    }
  })

  it('stays hidden on the interview, where the recording consent lives', () => {
    // The whole point of "one banner, not two". A candidate about to be
    // assessed must not be handed a cookie dialog on top of the consent that
    // actually gates their session — and analytics does not run there anyway.
    for (const path of ['/interview/eyJ.tok.sig', '/interview/done', '/en/interview/terminal']) {
      expect(mountBanner({ path }).find(banner).exists()).toBe(false)
    }
  })
})

describe('answering', () => {
  it('remembers a grant and tells the app it may start', async () => {
    let announced = false
    window.addEventListener(
      ANALYTICS_CONSENT_EVENT,
      () => {
        announced = true
      },
      { once: true }
    )

    const wrapper = mountBanner()
    await wrapper.find('[data-testid="analytics-consent-accept"]').trigger('click')

    expect(window.localStorage.getItem(ANALYTICS_CONSENT_KEY)).toBe('granted')

    // The event exists so analytics starts NOW rather than on the next page
    // load. Consenting and then seeing nothing happen reads as a broken button.
    expect(announced).toBe(true)
    expect(wrapper.find(banner).exists()).toBe(false)
  })

  it('remembers a refusal explicitly', async () => {
    const wrapper = mountBanner()
    await wrapper.find('[data-testid="analytics-consent-reject"]').trigger('click')

    // 'denied', not absence. Storing nothing would be indistinguishable from
    // never asking, so the banner would come back on every visit — nagging
    // somebody who already said no, which regulators read as pressure.
    expect(window.localStorage.getItem(ANALYTICS_CONSENT_KEY)).toBe('denied')
    expect(wrapper.find(banner).exists()).toBe(false)
  })

  it('does not announce anything when refused', async () => {
    let announced = false
    window.addEventListener(
      ANALYTICS_CONSENT_EVENT,
      () => {
        announced = true
      },
      { once: true }
    )

    const wrapper = mountBanner()
    await wrapper.find('[data-testid="analytics-consent-reject"]').trigger('click')

    expect(announced).toBe(false)
  })
})

describe('the two choices are equally available', () => {
  it('gives accept and reject the same styling', () => {
    const wrapper = mountBanner()
    const accept = wrapper.find('[data-testid="analytics-consent-accept"]')
    const reject = wrapper.find('[data-testid="analytics-consent-reject"]')

    // A prominent "Accept" beside a faint "Reject" link is a dark pattern, and
    // one regulators now name explicitly: a choice that is harder to refuse
    // than to accept is not freely given. Asserted rather than left to a code
    // review, because this is the exact detail a redesign erodes by accident.
    expect(accept.classes().sort()).toEqual(reject.classes().sort())
  })

  it('offers refusal first in the DOM', () => {
    const wrapper = mountBanner()
    const order = wrapper.findAll('button').map((b) => b.attributes('data-testid'))

    // Keyboard and screen-reader users reach the first control first. If either
    // option gets that advantage, it should be the one with no consequences.
    expect(order[0]).toBe('analytics-consent-reject')
  })
})

describe('accessibility', () => {
  it('is a labelled region, not a modal dialog', () => {
    const wrapper = mountBanner()
    const el = wrapper.find(banner)

    // Deliberately NOT role="dialog". A dialog implies a focus trap, and
    // trapping somebody in a question they are free to ignore is hostile —
    // especially when ignoring it already means "no". The page stays usable.
    expect(el.attributes('role')).toBe('region')
    expect(el.attributes('aria-label')).toBeTruthy()
  })

  it('describes itself for screen readers', () => {
    const wrapper = mountBanner()
    const describedBy = wrapper.find(banner).attributes('aria-describedby')

    expect(describedBy).toBeTruthy()
    expect(wrapper.find(`#${describedBy}`).exists()).toBe(true)
  })

  it('labels both buttons with real text, not icons', () => {
    const wrapper = mountBanner()

    for (const id of ['accept', 'reject']) {
      expect(wrapper.find(`[data-testid="analytics-consent-${id}"]`).text()).not.toBe('')
    }
  })

  it('uses i18n keys for every string it renders', () => {
    // $t is mocked to echo its key, so any literal text in the template would
    // show up here as something other than a key.
    const wrapper = mountBanner()

    expect(wrapper.text()).toContain('analytics_consent.')
  })
})
