# EmMail

Single-tenant email marketing core on Cloudflare Workers: contacts, list/tag import, broadcasts, Resend sending, suppression, unsubscribe, owned open/click tracking, and sidecar ingestion for EmDash sites.

## Stack

- Cloudflare Workers for the API and public tracking endpoints
- D1 for contacts, campaigns, events, suppressions, and import state
- Cloudflare Queues for async broadcast fanout
- React/Vite admin app served as Worker static assets
- Resend for email batch sending and delivery/bounce/complaint webhooks
- React Email for campaign rendering

## Local Setup

```bash
npm install
npm test -- --run
npm run build
```

For local Worker API development, copy the dummy local env file and apply the local D1 schema before starting Wrangler:

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run worker:dev
```

Admin auth fails closed: without `EMMAIL_ADMIN_TOKEN` set (in `.dev.vars`
locally, as a secret in production) every admin page and `/api/*` route
returns 401. `.dev.vars.example` ships a dummy local token; older `.dev.vars`
copies need the line added by hand.

The backend runs at `http://localhost:8787`. The Vite-only admin shell runs at `http://127.0.0.1:5173` with:

```bash
npm run dev
```

To load or clear the built-in demo records while the local Worker is running:

```bash
npm run sample:seed
npm run sample:clear
```

The clear routine removes only deterministic sample records, not real contacts or campaigns.

For remote Cloudflare setup, create the sidecar D1 database and Queue, replace the placeholder IDs in `wrangler.toml`, then apply the remote schema:

```bash
npx wrangler d1 create emmail-southandozarks
npx wrangler queues create emmail-southandozarks-send
npm run db:migrate:remote
```

Current South & Ozarks deployment note: the Cloudflare account hit its D1 database limit during setup, so `wrangler.toml` temporarily binds EmMail to the existing empty `autojack` D1 database. Replace that binding with a dedicated `emmail-southandozarks` D1 when a slot is available.

Set secrets without committing them:

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_WEBHOOK_SECRET
npx wrangler secret put TRACKING_SECRET
npx wrangler secret put EMMAIL_INGEST_SECRET
npx wrangler secret put EMMAIL_ADMIN_TOKEN
```

Set `APP_BASE_URL`, `DEFAULT_FROM_EMAIL`, `DEFAULT_FROM_NAME`, and `EMMAIL_SEND_MODE` in `wrangler.toml` for the deployed domain and verified Resend sender. The current deploy uses the `workers.dev` fallback URL because the active Cloudflare token cannot attach the preferred `southandozarks.autojack.ai/_emmail/*` route yet. Keep `EMMAIL_SEND_MODE=dry-run` until a real Resend key is set and the integration loop is verified.

## Sending

`POST /api/campaigns/:id/send` snapshots the audience into
`campaign_recipients` and enqueues one queue message. The consumer drains
pending recipients in Resend batches of up to 100, re-enqueueing a
continuation message after each batch until none remain, then marks the
campaign `sent`. Each batch's Resend idempotency key is derived from
`campaigns.last_completed_batch`, which only advances in the same atomic D1
batch that records the outcomes — queue redeliveries re-send the identical
payload instead of duplicating or skipping recipients.

Re-POSTing `/send` is safe and doubles as the recovery path: it enqueues a
new drain message whenever recipients are still `pending` (for example after
a lost queue message), and is a no-op once the campaign has fully drained.

`GET /api/campaigns/:id/stats` returns the recipient rollup
(`total/sent/delivered/opened/clicked/pending/failed`); `pending` is the live
send progress.

## Welcome automation

When `EMMAIL_WELCOME_ENABLED = "true"`, a freshly ingested contact-form lead is
sent a one-shot welcome email. The ingest route enqueues a
`{ type: "welcome", contactId }` message onto the same send queue (unless the
contact already has a `welcome_sent` event); the consumer renders it through the
campaign email shell and sends a single Resend email keyed `welcome/{contactId}`.
Delivery is **at most once per contact** — the enqueue and consumer both gate on
the `welcome_sent` event (not the ingest `duplicate` flag), and the Resend
idempotency key dedupes, so duplicate messages are harmless. The enqueue is
best-effort and leaves no marker on failure, so it never fails lead capture and a
later submission — including a same-id replay — self-heals a dropped enqueue.
Honors `EMMAIL_SEND_MODE` (dry-run records `welcome_sent` without calling Resend).

Before sending, the consumer re-checks `isWelcomeEnabled` (so flipping the flag
back to `false` is a true kill switch for already-queued messages) and the
`suppressions` table (ingest re-subscribes on re-submit, so `status` alone can
be stale). Welcome bounces/complaints resolve back to the contact via the
`welcome_sent` provider id and suppress them; the one-click unsubscribe route
accepts both `GET` and RFC 8058 `POST`.

The flag defaults **off** in `wrangler.toml`; arming it (and `EMMAIL_SEND_MODE =
"live"`) is what makes real welcomes send. Edit the copy in
[`src/email/welcome.ts`](src/email/welcome.ts) — subject, preview, and the
Markdown body. The contact name comes from the public form and is sanitized
before it reaches the renderer.

## Admin

The preferred production setup is Cloudflare Access protecting the admin route. The current `workers.dev` fallback uses `EMMAIL_ADMIN_TOKEN` as a Worker-level admin gate; if the token is unset, admin access is denied entirely (fail closed), so set the secret before deploying.

Admin surfaces:

- Contacts table
- CSV import preview/commit
- Built-in sample data load/clear controls
- South & Ozarks contact-message ingestion
- Broadcast draft creation
- Broadcast send queueing
- Event reporting for opens/clicks/provider events

## Admin/API Endpoints

- `GET /api/sample-data/status`
- `POST /api/sample-data/seed`
- `POST /api/sample-data/clear`
- `POST /api/integrations/southandozarks/contact-message`
- `POST /api/campaigns/:id/send` (snapshot + enqueue/resume)
- `GET /api/campaigns/:id/stats` (recipient rollup + send progress)

## Public Endpoints

- `GET /t/open/:recipientId/:campaignId/:token.gif`
- `GET /t/click/:recipientId/:linkId/:token`
- `GET /unsubscribe/:recipientId/:token`
- `GET /unsubscribe/c/:contactId/:token` (contact-scoped, for transactional mail)
- `POST /webhooks/resend`

## Deferred

The ingest-triggered welcome (above) is the one shipped automation. A general
automation/flow builder, saved segments, forms, landing pages, custom-field
import, R2 storage, and multi-tenancy remain out of scope for now.
