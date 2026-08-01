# Code Review Rules — BEAI Nuxt app (Nuxt 4 / Vue 3 / TypeScript)

Concrete, checkable rules. Every one exists because the mistake was actually made in this
codebase, not because it is good practice in the abstract.

## Tooling — non-negotiable

- **Bun only.** Never `npm`, `pnpm`, `yarn`, `npx` or `pnpx`. Use `bun` / `bunx --bun`.
- **The typecheck gate is `bun run typecheck` (`nuxi typecheck`)**, run after `bunx nuxi prepare`.
  Bare `bunx vue-tsc --noEmit` uses a different tsconfig and reports a FALSE CLEAN.
- **E2E must run via `scripts/e2e-container.sh <app>`.** On a bare host Playwright silently
  attaches to whatever container already holds the port and produces green that means nothing.

## Styling and design tokens

- **Every clickable element shows `cursor: pointer`; disabled states `cursor: not-allowed`.**
  Tailwind v4's Preflight no longer sets this on `<button>`, so without the global rule every
  new component silently loses the affordance. Applies to vendored shadcn source too.
- **Never re-declare a brand token inside the shadcn `@theme inline` bridge.** Declaring
  `--color-primary: var(--primary)` after the literal brand value shadows it — the brand
  colour is present in the file and never wins the cascade.
- **A token test must read a computed style**, not grep the stylesheet for a hex string. The
  hex was present the whole time in the known-broken version.
- All tokens must match `DESIGN.md`; it is authoritative and must be updated before any
  contradicting change.

## API access

- **`apiBase` includes the `/api` suffix.** Composables append `/auth/login` to it, and the
  API's CORS middleware only covers `api/*` — omitting it yields a 404 with no CORS headers,
  which the browser reports as a CORS error and sends everyone chasing the wrong bug.
- **Never hand-maintain request/response types.** They are generated from the API's OpenAPI
  spec; keep the snapshot synced and the drift check green.
- **Never send `organization_id` from the browser to select data.** Tenant scoping is
  server-side; the JWT already carries it.
- Reuse the single-flight refresh in `useAuth` — concurrent requests on mount must not each
  trigger a token refresh, or the denylist causes spurious logouts.

## BARS rendering — domain correctness

- **Indicator scores are the discrete set `{1, 3, 5}`.** A chip rendering `2` or `4` is a bug,
  not a styling choice.
- **`-1` (and the API's `null` mapping of it) means UNASSESSABLE.** Render a neutral `–` with
  an accessible label — never the number, never on the error/warning/success scale.
- **Unassessable indicators are excluded from the competency mean**; an all-unassessable
  competency has no mean and renders `–`, never `0`.
- **`reliability` is rendered verbatim.** No High/Medium/Low bands — no threshold formula
  exists, and inventing one bakes an unapproved business rule into the UI.

## Accessibility — binding, WCAG 2.1 AA

- **Never convey meaning by colour alone.** Every state needs a non-colour cue.
- **E2E locators must be role-based** — never a CSS class or id.
- Keyboard operability and correct roles/labels are requirements, not polish.

## Components and i18n

- **Every component has a matching Vitest unit test** (`DESIGN.md` §5).
- Atoms take only props and emit only events; molecules hold UI composition logic only.
- **Zero hardcoded user-facing strings.** Everything through i18n, it + en mandatory,
  including accessible labels and error states.

## Error states

- **A 409 is not a generic error.** It means "not ready yet" — temporal and self-resolving —
  and must render distinctly from 403 (no permission) and 404 (does not exist). Collapsing
  them into one toast discards the only reason the status was chosen.

## Tests

- **A test that has never been seen to fail is not evidence.** Ask what mutation would make it
  fail before trusting it.
- Never weaken an assertion to restore green.
