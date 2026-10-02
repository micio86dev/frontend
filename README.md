# BEAI — candidate app

Nuxt 4, SSR. The interview a candidate takes: SSO entry, device check, avatar session, proctoring.

> **Bun only.** Bun is the sole package manager here: install, dev and build.
> Node runs the SSR production runtime (Nitro `node-server`) and the Vitest/Playwright runners, nothing else.
> `npm`, `pnpm`, `yarn`, `npx` and `pnpx` are not used — see `AGENTS.md` and the
> pinned version catalogue in `openspec/changes/archive/2026-07-16-project-skeleton-ci/design.md`.
>
> This file used to be the stock Nuxt starter README, listing three other
> package managers ahead of bun. The first thing a new developer opened
> contradicted the project's own toolchain rule, and the CI guard meant to
> catch that looked for only two of the five banned tools and never looked at
> Markdown at all.

## Setup

```bash
bun install
```

## Development

```bash
bun run dev          # http://localhost:3000
```

## Production

```bash
bun run build
node .output/server/index.mjs
```

## Tests

```bash
bunx vitest run      # unit
bunx playwright test # E2E — chromium, webkit, mobile
bunx nuxi typecheck
bunx eslint .
```

> Playwright reuses a server already listening on 3000. If one is running —
> started by hand, or the Docker container — the suite tests THAT, without the
> environment variables Playwright injects, and fails for reasons unrelated to
> the code. Stop it first.

### Real-stack e2e (opt-in)

Every spec above mocks `/api` with `page.route`, so none of them can see a real
api that is broken (for example a database schema behind the code, which answers
500). `tests/e2e/stack/**` is a separate tier that drives the candidate redeem
flow against your LIVE local stack, with nothing mocked:

```bash
task stack:check            # precondition: the stack is up AND ready (migrated)
export BEAI_E2E_ADMIN_EMAIL=...      # admin/operator of a local organization
export BEAI_E2E_ADMIN_PASSWORD=...   # no default exists; never commit it
bun run test:e2e:stack      # chromium + webkit, one worker, no retries
```

| Variable                   | Default                 | Meaning                                  |
| -------------------------- | ----------------------- | ---------------------------------------- |
| `BEAI_E2E_ADMIN_EMAIL`     | none (required)         | admin login used for setup and cleanup   |
| `BEAI_E2E_ADMIN_PASSWORD`  | none (required)         | its password, never printed              |
| `BEAI_E2E_API_URL`         | `http://localhost:8000` | api origin for the readiness probe/setup |
| `BEAI_E2E_STACK_URL`       | `http://localhost:3000` | candidate app under test                 |
| `BEAI_E2E_PROJECT_ID`      | none (optional)         | the one project the link is created on   |
| `BEAI_E2E_ALLOW_NON_LOCAL` | none                    | `1` lifts the origin guard (see below)   |

The credentials MUST belong to an admin of a dedicated e2e organization, never your
own working one: the test writes there. Set `BEAI_E2E_PROJECT_ID` to a project that
exists for this purpose. Without it the first project that accepts a link is used,
which in a developer's own organization can be a real one; its id and name are
recorded in the test annotations (`project`) either way. A pinned project that does
not accept a link fails the run with the reason instead of falling back.

**Origin guard.** Both URLs are parsed and refused unless the hostname is exactly
`localhost`, `127.0.0.1` or `[::1]` (http or https), so a stray variable cannot
send the admin password to, or write on, staging or production. Setting
`BEAI_E2E_ALLOW_NON_LOCAL=1` lifts the check; it is for deliberate use only.

**Never run with `--trace on` or `trace: 'on'`.** The trace would record the typed
password and the access token. The default config does not enable it.

A global setup first calls `/api/health` and `/api/health/ready` and aborts the
whole run with the fix command (for example `docker compose exec api php artisan
migrate --force`) when the stack is down or its schema is behind. The test then
creates a reusable link, redeems it in the browser, and fails on any `/api/`
response with status 500 or above.

It WRITES to the local dev database only: a link (disabled again at the end of
every run) and one participant per run (`e2e-stack-<n>@example.test`), which stays
because the api has no participant deletion. Never point it at a shared or
production api. CI does not run this tier; the default projects ignore it.

## API client

`types/api.ts` is GENERATED from `openapi.json`, which is exported from the api
repository. Never edit either by hand:

```bash
bun run codegen
```

All three repositories must carry a byte-identical `openapi.json`; the wrapper's
Cross-Stack Consistency job fails otherwise.

## More

The full local walkthrough lives in the wrapper's `GUIDE.md`.
