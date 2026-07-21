/**
 * browser-gate.global.ts — Browser Support Gate Middleware (Task 3.6 GREEN)
 *
 * Implements SA-11: Firefox + mobile redirect at every navigation entry point.
 *
 * Detection split (D5):
 *   SSR path:    useRequestHeaders(['user-agent']) → pass Infinity as width to
 *                isSupportedBrowser (viewport not available server-side)
 *   Client path: navigator.userAgent + window.innerWidth (< 1024 = tablet/mobile)
 *
 * The resize listener (client-mid-session gate) lives in useInterviewSession —
 * NOT here. This middleware handles only route-entry gating.
 *
 * Skip condition: to.path.endsWith('/unsupported') covers both /unsupported and
 * /en/unsupported (i18n-prefixed) — prevents redirect loops on non-default locales.
 *
 * SSR invariant: window/navigator access is guarded by import.meta.client.
 */

import { defineNuxtRouteMiddleware, navigateTo, useRequestHeaders } from '#imports'
import { isSupportedBrowser } from '~/utils/browser-gate'

export default defineNuxtRouteMiddleware((to) => {
  // Skip for the /unsupported page itself (covers both /unsupported and /en/unsupported)
  if (to.path.endsWith('/unsupported')) {
    return
  }

  if (import.meta.server) {
    // Server-side: UA from request headers; pass Infinity as width (not detectable server-side)
    const headers = useRequestHeaders(['user-agent'])
    const ua = headers['user-agent'] ?? ''
    if (!isSupportedBrowser(ua, Infinity)) {
      return navigateTo('/unsupported')
    }
  }

  if (import.meta.client) {
    // Client-side: UA from navigator + actual viewport width
    const ua = navigator.userAgent
    const width = window.innerWidth
    if (!isSupportedBrowser(ua, width)) {
      return navigateTo('/unsupported')
    }
  }
})
