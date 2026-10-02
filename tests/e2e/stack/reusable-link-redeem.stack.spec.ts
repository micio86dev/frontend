import { test, expect } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { waitForHydration } from '../fixtures/hydration'

/**
 * REAL-STACK e2e — a visitor redeems a reusable link against the live local api.
 *
 * Opt-in (`bun run test:e2e:stack`, precondition `task stack:check`). Nothing
 * here is mocked: no `page.route`, the real api, the real database. It exists
 * because the mocked suites (`tests/e2e/reusable-link.spec.ts`) cannot see a real
 * api that is broken, such as a schema behind the code answering
 * `relation "reusable_interview_links" does not exist` as a 500.
 *
 * Setup and cleanup go through the api as an admin (`BEAI_E2E_ADMIN_EMAIL`,
 * `BEAI_E2E_ADMIN_PASSWORD`; no default exists on purpose, the repo documents no
 * local credentials). The link is disabled afterwards. The participant that the
 * redeem creates cannot be removed: the api has no participant deletion, so one
 * row per run, with an `e2e-stack-` name and an `@example.test` email, stays in
 * the LOCAL dev database. It is a different row every run (unique email).
 */

const API_URL = (process.env['BEAI_E2E_API_URL'] ?? 'http://localhost:8000').replace(/\/+$/, '')
const STACK_URL = (process.env['BEAI_E2E_STACK_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '')

const NAME_LABEL = /^(full name|nome e cognome)$/i
const EMAIL_LABEL = /^email$/i

function requireEnv(name: string): string {
  const value = process.env[name]

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is required for the real-stack tier. Export the email and password of an ` +
        `admin or operator of a LOCAL organization (BEAI_E2E_ADMIN_EMAIL, BEAI_E2E_ADMIN_PASSWORD); ` +
        `the repo documents no default credentials. Mint one with ` +
        `\`docker compose exec api php artisan beai:provision-organization\` if you have none.`
    )
  }

  return value
}

interface CreatedLink {
  projectId: number
  linkId: string
  /** Path + fragment of the entry URL, re-based onto the candidate app under test. */
  entryPath: string
}

async function login(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${API_URL}/api/auth/login`, {
    data: {
      email: requireEnv('BEAI_E2E_ADMIN_EMAIL'),
      password: requireEnv('BEAI_E2E_ADMIN_PASSWORD'),
    },
  })

  // The body is deliberately not printed: a failed login must never echo input.
  expect(response.status(), 'admin login (check BEAI_E2E_ADMIN_EMAIL / _PASSWORD)').toBe(200)

  const { access_token: token } = (await response.json()) as { access_token?: string }

  expect(typeof token === 'string' && token !== '', 'login returned an access_token').toBe(true)

  return token as string
}

/**
 * Creates a link on the first project that is open for interviews. A closed
 * project (403) or one without questions (422) is skipped; anything else, a 5xx
 * above all, fails the run at once with the method and path.
 */
async function createLink(request: APIRequestContext, token: string): Promise<CreatedLink> {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' }

  const projects = await request.get(`${API_URL}/api/projects`, { headers })

  expect(projects.status(), 'GET /api/projects').toBe(200)

  const ids = ((await projects.json()) as { data: Array<{ id: number }> }).data.map((p) => p.id)

  expect(
    ids.length,
    'this organization has no project: create one in the backoffice (or `./scripts/dev.sh --seed`) and re-run'
  ).toBeGreaterThan(0)

  const refused: string[] = []

  for (const projectId of ids) {
    const created = await request.post(`${API_URL}/api/projects/${projectId}/reusable-links`, {
      headers,
      data: { label: `e2e-stack-${Date.now()}` },
    })

    if (created.status() === 403 || created.status() === 422) {
      refused.push(`project ${projectId}: ${created.status()}`)
      continue
    }

    expect(created.status(), `POST /api/projects/${projectId}/reusable-links`).toBe(201)

    const body = (await created.json()) as { data: { id: string }; entry_url: string }
    const entry = new URL(body.entry_url)

    return { projectId, linkId: body.data.id, entryPath: `${entry.pathname}${entry.hash}` }
  }

  throw new Error(
    `No project could take a reusable link (${refused.join(', ')}). Activate a project that has ` +
      `questions for its competencies, then re-run.`
  )
}

test.describe('real stack — reusable link redeem', () => {
  let created: CreatedLink | undefined
  let token: string | undefined

  test.afterEach(async ({ request }) => {
    if (created !== undefined && token !== undefined) {
      const response = await request.delete(
        `${API_URL}/api/projects/${created.projectId}/reusable-links/${created.linkId}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
      )

      // 204 also when it was already disabled; anything else leaves a live link behind.
      expect(response.status(), 'cleanup: disable the e2e-stack link').toBe(204)
    }

    created = undefined
    token = undefined
  })

  test('a visitor enters name and email and reaches the consent step, with no 5xx from the api', async ({
    page,
    request,
  }) => {
    token = await login(request)
    created = await createLink(request, token)

    const serverErrors: string[] = []

    page.on('response', (response) => {
      if (new URL(response.url()).pathname.includes('/api/') && response.status() >= 500) {
        serverErrors.push(
          `${response.request().method()} ${new URL(response.url()).pathname} -> ${response.status()}`
        )
      }
    })

    await page.goto(`${STACK_URL}${created.entryPath}`)
    await waitForHydration(page)

    const form = page.getByTestId('reusable-identity-form')

    await expect(form).toBeVisible()

    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    await page.getByLabel(NAME_LABEL).fill(`E2E Stack ${unique}`)
    await page.getByLabel(EMAIL_LABEL).fill(`e2e-stack-${unique}@example.test`)

    const redeem = page.waitForResponse(
      (response) =>
        response.url().includes('/api/reusable-links/redeem') &&
        response.request().method() === 'POST'
    )

    await page.getByTestId('reusable-identity-submit').click()

    const redeemed = await redeem

    expect(
      redeemed.status(),
      `POST /api/reusable-links/redeem answered ${redeemed.status()}, expected 2xx`
    ).toBeGreaterThanOrEqual(200)
    expect(redeemed.status()).toBeLessThan(300)

    // Same next step the mocked spec asserts: the session route and its consent screen.
    await expect(page).toHaveURL(/\/interview\/session$/)
    await expect(page.getByTestId('reusable-identity-form')).toHaveCount(0)
    // The page language follows the link's `lang`, not the browser: a real link is
    // Italian, the mocked spec's is English. Match the consent heading in either.
    await expect(
      page.getByRole('region', {
        name: /privacy notice and consent|informativa sulla privacy e consenso/i,
      })
    ).toBeVisible()

    expect(
      serverErrors,
      `the api answered 5xx during the flow: ${serverErrors.join('; ')}`
    ).toEqual([])
  })
})
