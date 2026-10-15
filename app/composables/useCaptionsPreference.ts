/**
 * useCaptionsPreference: whether the live call shows the question as captions.
 *
 * live-interview-call-chrome, design D17. A UI preference, not personal data: it lives in
 * the browser only (never sent anywhere) and defaults to on. Storage that cannot be read or
 * written (a privacy mode, a blocked origin) is swallowed: the flag then starts on and
 * still toggles in memory, so a locked-down browser never loses the captions control.
 *
 * The microphone intent is deliberately NOT persisted (D9): a reload starts unmuted.
 */

import { useLocalStorage } from '@vueuse/core'

export const CAPTIONS_STORAGE_KEY = 'beai:interview:captions'

export function useCaptionsPreference() {
  return useLocalStorage(CAPTIONS_STORAGE_KEY, true, { onError: () => {} })
}
