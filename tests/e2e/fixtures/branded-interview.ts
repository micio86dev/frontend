import type { Page } from '@playwright/test'

/**
 * Routes for a candidate interview on a client's brand canvas: the SSO
 * exchange, the candidate session carrying the branding, the interview start
 * and the fire-and-forget telemetry endpoints. `primaryColor: null` is an
 * organization that configured no colour (the Quint fallback).
 */

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function makeCandidateJwt(): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      typ: 'candidate',
      candidate_ref: 'cand-chrome-001',
      project_id: 1,
      exp: Math.floor(Date.now() / 1000) + 7200,
    })
  )
  return `${header}.${payload}.e2e-fake-signature`
}

const START_RESPONSE = {
  session_id: 1,
  provider: 'heygen',
  provider_token: 'heygen-token-xyz',
  audio_only: false,
  question_context: {
    question_index: 0,
    total_questions: 3,
    end_phrase: 'Let us move on to the next question.',
    final_phrase: 'Thank you for your time.',
    competency_code: 'COM',
  },
}

export async function mockBrandedInterview(page: Page, primaryColor: string | null): Promise<void> {
  await page.route('**/api/sso/exchange*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: makeCandidateJwt() }),
    })
  )
  await page.route('**/api/candidate/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          project: { exit_redirect_url: null },
          branding: { primary_color: primaryColor, logo_url: null, name: 'Acme Selezione' },
        },
      }),
    })
  )
  await page.route('**/api/candidate/interview/start', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(START_RESPONSE),
    })
  )
  for (const path of ['utterance', 'integrity', 'snapshot']) {
    await page.route(`**/api/candidate/interview/${path}`, (route) =>
      route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok' }),
      })
    )
  }
}
