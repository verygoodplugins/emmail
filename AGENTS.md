# Repository Guidelines

## Project Structure & Module Organization

`src/worker.ts` is the Cloudflare Worker entry point and owns HTTP routing.
Keep domain logic close to its layer: D1 repositories in `src/db/`, queue
consumers in `src/queue/`, email rendering in `src/email/`, integrations in
`src/integrations/`, and shared utilities in `src/lib/`. The React/Vite admin
app lives in `src/admin/`. Schema changes belong in sequential SQL migrations
under `migrations/` (for example, `0004_add_feature.sql`).

Tests mirror the production layers under `tests/`: `core/`, `db/`, `queue/`,
and `worker/`. Reuse `tests/helpers/sqlite-d1.ts` for D1-backed tests. Static
screenshots in the repository are reference assets, not build output.

## Build, Test, and Development Commands

- `npm run worker:dev` starts the local Worker at port 8787.
- `npm run dev` runs the Vite-only admin shell at `127.0.0.1:5173`.
- `npm run db:migrate:local` applies D1 migrations locally; run it before
  exercising data-dependent routes.
- `npm run test:run` executes the complete Vitest suite once.
- `npm run typecheck` checks strict TypeScript without emitting files.
- `npm run build` builds the admin assets and type-checks; run it before a PR.

Copy `.dev.vars.example` to `.dev.vars` for local Worker development. Never
commit `.dev.vars`, Resend credentials, webhook secrets, or admin tokens.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, semicolons, double-quoted strings,
and strict types. Name files by responsibility in kebab-case (for example,
`contact-repository.ts`); use PascalCase for React components and repository
classes, camelCase for values and functions, and UPPER_SNAKE_CASE for env keys.
Prefer small, explicit functions and keep Worker handlers fail-closed around
authentication, secret checks, and live-send behavior. No formatter or linter
is configured, so follow the surrounding code.

## Testing Guidelines

Use Vitest (`tests/**/*.test.ts`) with `describe` blocks and behavior-focused
`it("...")` names. Add regression coverage beside the relevant layer, mock
external providers, and exercise D1 behavior through the SQLite D1 helper.
Run `npm run test:run` and `npm run typecheck` before submitting changes.

## Commit & Pull Request Guidelines

Use concise, imperative commit subjects; existing history favors Conventional
Commit prefixes for scoped changes, such as `docs(welcome): clarify retry
boundary`, while feature and fix commits use `Add ...` or `Fix ...`. Keep each
commit focused. PRs should explain the behavior change, note migration or
configuration effects, link the issue when available, and include screenshots
for admin UI changes. Call out any change that can affect email delivery,
suppression, or production secrets.
