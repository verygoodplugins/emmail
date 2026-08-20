# AGENTS.md

Guide for coding tools working in this repo. Humans: start at [README.md](README.md).

EmMail is a **single-tenant email marketing Worker** (not Pages). Config in-tree is still an example brand — rename Worker / D1 / queue / domain / from-address / ingest path before a real deploy. See README → *WIP: rebrand before you ship*.

## Cloudflare skills & MCPs

Do **not** invent Wrangler flags or D1/Queue recipes from memory. Load Cloudflare’s public material:

| Need | Use |
|---|---|
| Workers, D1, Queues, secrets, custom domains | [cloudflare/skills](https://github.com/cloudflare/skills) — especially **`wrangler`** and **`cloudflare`** |
| Live docs | [Documentation MCP](https://docs.mcp.cloudflare.com/mcp) |
| Bindings / primitives | [Workers Bindings MCP](https://bindings.mcp.cloudflare.com/mcp) |
| Account / API | [Cloudflare MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/) |

Auth: `npx wrangler whoami` first. Never ask the human to paste API tokens into chat.

This app is **`wrangler deploy`**, not Pages. Do not `wrangler pages deploy`.

## Dev setup (local)

```bash
npm install
cp .dev.vars.example .dev.vars    # rotate EMMAIL_ADMIN_TOKEN
npm run dev:setup                 # local D1 migrations (script still uses the example DB name)
npm run dev:local                 # Worker 127.0.0.1:8787 + Vite 127.0.0.1:5173
```

Login at `http://127.0.0.1:5173/login` with `EMMAIL_ADMIN_TOKEN`. Vite proxies `/api` and `/login` to the Worker — don’t mix origins or cookies break.

Worker-only: `npm run build:admin && npm run worker:dev` → `http://127.0.0.1:8787/login`.

`.dev.vars` is gitignored. Never commit Resend keys, webhook secrets, tracking/ingest/admin tokens.

`package.json` `db:migrate:*` scripts pass the example D1 name from `wrangler.toml`. After a rebrand, update **both**.

## Verify before you say done

```bash
npm run test:run
npm run typecheck
```

Ingest → enroll → drain (no Wrangler): `npm run test:ingest`. Reuse `tests/helpers/mail-harness.ts` for mail assertions.

Admin UI changes: screenshot in the PR. Anything that can send mail, change suppression, or touch secrets: say so in the PR body.

## Deploy (Worker)

Canonical path: **`npm run deploy`** (`build:admin` + `typecheck` + `wrangler deploy`). There is no Git-connected Pages build.

Preflight:

1. `npx wrangler whoami`
2. Rebrand `wrangler.toml` (Worker name, `[[routes]]`, D1 id, queue name, from-address, `EMMAIL_SEND_MODE`) — example values are not yours
3. Secrets present (`wrangler secret list`): `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `TRACKING_SECRET`, `EMMAIL_INGEST_SECRET`, `EMMAIL_ADMIN_TOKEN`
4. First-time: `wrangler d1 create` + `wrangler queues create`, then `npm run db:migrate:remote`
5. Keep **`EMMAIL_SEND_MODE=dry-run`** until Resend domain + webhook loop is verified
6. Do **not** enable `EMMAIL_WELCOME_ENABLED=true` and a live `contact_created` automation together — double welcome

`workers.dev` is the fallback hostname; don’t delete it as a “cleanup.”

## Safety rails

- Admin and `/api/*` **fail closed** without `EMMAIL_ADMIN_TOKEN`.
- Queue consumer `max_concurrency = 1` is load-bearing: batch idempotency keys assume one consumer per campaign.
- Cron `* * * * *` wakes waits past the 12h queue delay cap and heals lost messages — don’t “optimize it away” without a replacement.
- Public paths only: `/login`, ingest POST, Resend webhook, open/click/unsubscribe. Everything else is admin.
- Copy for welcome/follow-up: `src/email/welcome.ts` only (still example-branded until the backend pass).

## Layout

`src/worker.ts` routes HTTP. Domain logic stays in layer folders: `src/db/`, `src/queue/`, `src/email/`, `src/integrations/`, `src/lib/`. Admin UI: `src/admin/`. Schema: sequential `migrations/000N_*.sql`.

Tests mirror layers under `tests/` (`core/`, `db/`, `queue/`, `worker/`). D1 tests use `tests/helpers/sqlite-d1.ts`. `docs/img/` screenshots are reference assets, not build output.

## Style

TypeScript, two-space indent, semicolons, double quotes, strict types. Files kebab-case (`contact-repository.ts`); React/repository classes PascalCase; values/functions camelCase; env keys UPPER_SNAKE_CASE. Small functions. Fail closed on auth, missing secrets, and live send. No repo formatter — match neighbors.

## Git

Concise imperative subjects. History mixes Conventional Commits for docs (`docs(welcome): …`) with `Add …` / `Fix …` for features. One concern per commit. PRs: behavior change, migration/config effects, issue link, screenshots for admin UI.
