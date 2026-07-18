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

## Admin

The preferred production setup is Cloudflare Access protecting the admin route. The current `workers.dev` fallback uses `EMMAIL_ADMIN_TOKEN` as a temporary Worker-level admin gate because the active Cloudflare token cannot attach the preferred zone route yet.

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

## Public Endpoints

- `GET /t/open/:recipientId/:campaignId/:token.gif`
- `GET /t/click/:recipientId/:linkId/:token`
- `GET /unsubscribe/:recipientId/:token`
- `POST /webhooks/resend`

## Deferred

Automations, saved segments, visual flow builder, forms, landing pages, custom-field import, R2 storage, and multi-tenancy are intentionally out of milestone 1.
