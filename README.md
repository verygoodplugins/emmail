# EmMail

Single-tenant email marketing core on Cloudflare Workers: contacts, list/tag import, broadcasts, multi-step automations, Resend sending, suppression, unsubscribe, owned open/click tracking, and sidecar ingestion for EmDash sites.

![EmMail admin Contacts view with sample subscribers, lists, tags, and status badges](docs/img/contacts-overview.png)

**Automations** — linear sequences with email, wait, and tag steps; disable to edit; preview unsaved drafts:

![EmMail Automations builder with sequence list and linear step editor for email, wait, and tags](docs/img/automations-builder.png)

**Campaigns** — draft broadcasts, queue sends, and review campaign status:

![EmMail Campaigns view with new broadcast draft form and sent or draft campaign list](docs/img/campaigns-overview.png)

## Stack

- Cloudflare Workers for the API and public tracking endpoints
- D1 for contacts, campaigns, automations, events, suppressions, and import state
- Cloudflare Queues for async broadcast fanout and automation wakes
- React/Vite admin app served as Worker static assets
- Resend for email batch sending and delivery/bounce/complaint webhooks
- React Email for campaign and automation rendering

## Local Setup

```bash
npm install
npm test -- --run
npm run build
```

For local Worker API development, copy the dummy local env file and apply the local D1 schema before starting Wrangler:

```bash
cp .dev.vars.example .dev.vars
npm run dev:setup
```

### Hot-reload admin (recommended)

Run the Worker API and Vite admin together. Vite proxies `/api` and `/login` to the local Worker, so auth cookies and API calls share the Vite origin:

```bash
npm run dev:local
```

Open **http://127.0.0.1:5173/login**, paste `EMMAIL_ADMIN_TOKEN` from `.dev.vars`, then use the admin at **http://127.0.0.1:5173/** with live UI reload.

Or run the two processes in separate terminals:

```bash
npm run worker:dev   # http://127.0.0.1:8787
npm run dev          # http://127.0.0.1:5173
```

### Worker-only preview

Built admin assets served from Wrangler (rebuild after UI changes):

```bash
npm run build:admin
npm run worker:dev
```

Open **http://127.0.0.1:8787/login**.

Admin auth fails closed: without `EMMAIL_ADMIN_TOKEN` set (in `.dev.vars`
locally, as a secret in production) every admin page and `/api/*` route
returns 401. `.dev.vars.example` ships a dummy local token; rotate it in your
local `.dev.vars` before use.

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

Set `APP_BASE_URL`, `DEFAULT_FROM_EMAIL`, `DEFAULT_FROM_NAME`, and `EMMAIL_SEND_MODE` in `wrangler.toml` for the deployed domain and verified Resend sender. Production lives at `https://emmail.autojack.ai`; the `workers.dev` URL remains as a fallback. Keep `EMMAIL_SEND_MODE=dry-run` until a real Resend key is set and the integration loop is verified.

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

The one boundary on the at-most-once guarantee: the `welcome/{contactId}`
idempotency key only dedupes within Resend's 24h window. If the post-send
`welcome_sent` write fails across every queue retry (a sustained D1 outage) *and*
the same contact re-submits after that window, a second welcome can go out —
bounded to one extra email for a re-engaging lead. Closing that sub-window would
need a transactional outbox capturing the provider id atomically at send time.

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

The preferred production setup is Cloudflare Access protecting the admin route. Until that is wired, `https://emmail.autojack.ai` uses `EMMAIL_ADMIN_TOKEN` as a Worker-level admin gate; if the token is unset, admin access is denied entirely (fail closed), so set the secret before deploying. The current token is stored locally in `.dev.vars` (gitignored) and as the macOS Keychain item `emmail-admin-token`.

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

## Multi-step automations

EmMail now has a small ActiveCampaign-style sequence engine on the same Worker +
D1 + Queue stack (no extra services):

| Piece | Role |
|---|---|
| `automations` / `automation_steps` / `automation_enrollments` | Schema (migration `0004`) |
| Trigger `contact_created` | Enroll on South & Ozarks contact-form ingest |
| Steps | `send_email`, `wait` (seconds), `add_tag` |
| Queue message `{ type: "automation", enrollmentId }` | Drain one enrollment until a wait or completion |
| Cron `* * * * *` | Re-queue due waits (>12h or lost delay) and stuck actives |

### Demo: welcome sequence

1. Apply migrations (`npm run db:migrate:local` / remote).
2. In admin → **Automations**, use **Seed welcome** from the empty state (or
   `POST /api/automations/seed-welcome`).
3. Select the sequence in the editor, review steps, then **Enable** from the list
   (disabled by default — kill switch; sequences with no steps cannot be enabled).
4. Submit a contact form (or hit the ingest endpoint). The contact gets:
   - welcome email now
   - 2-minute wait (local demo default)
   - follow-up email
   - tag `welcome-sequence-complete`

Disable a sequence before editing its name or steps. The admin editor supports
creating blank sequences, reordering `send_email` / `wait` / `add_tag` steps,
**Preview sequence** (unsaved draft + sample first name; does not send mail),
and viewing recent enrollments.

Copy lives in [`src/email/welcome.ts`](src/email/welcome.ts) (welcome + follow-up).
Bodies support `{{first_name}}`. Sends honor `EMMAIL_SEND_MODE`, suppression, and
contact-scoped one-click unsubscribe. Provider ids are stored as
`automation_email_sent` events so Resend bounce/complaint webhooks still suppress.

**Do not arm both** `EMMAIL_WELCOME_ENABLED=true` and an enabled `contact_created`
automation for the same stream — that double-emails new leads. Prefer the
multi-step sequence and leave the one-shot welcome flag off.

### Admin/API

- `GET /api/automations`
- `POST /api/automations` — create blank sequence (`{ name }`)
- `POST /api/automations/preview` — render unsaved draft timeline (`{ firstName?, steps }`)
- `PATCH /api/automations/:id` — rename while disabled (`{ name }`)
- `PUT /api/automations/:id/steps` — replace all steps while disabled (`{ steps: [{ stepType, config }] }`)
- `POST /api/automations/seed-welcome`
- `POST /api/automations/:id/enable` / `.../disable` (enable requires ≥1 step)
- `GET /api/automations/:id/enrollments`

### Automated ingest / sequence checks

Vitest covers the full HTTP ingest → enroll → drain path with a capturing
email adapter (no Wrangler required):

```bash
npm test -- tests/worker/ingest-automation.test.ts
```

Shared helpers live in [`tests/helpers/mail-harness.ts`](tests/helpers/mail-harness.ts)
(`createMailHarness`, `seedEnabledWelcomeSequence`). Reuse them when adding
builder step tests or template assertions — captured emails expose
`subject` / `html` / `text` / unsubscribe headers.

## Deferred

A full visual flow builder, saved segments, forms, landing pages, custom-field
import, R2 storage, and multi-tenancy remain out of scope for now.
