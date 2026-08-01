# BEAI — candidate app

Nuxt 4, SSR. The interview a candidate takes: SSO entry, device check, avatar session, proctoring.

> **Bun only.** Bun is the sole package manager here: install, dev and build.
> Node runs the SSR production runtime (Nitro `node-server`) and the Vitest/Playwright runners, nothing else.
> `npm`, `pnpm`, `yarn`, `npx` and `pnpx` are not used — see `AGENTS.md` and the
> pinned version catalogue in `openspec/changes/project-skeleton-ci/design.md`.
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
