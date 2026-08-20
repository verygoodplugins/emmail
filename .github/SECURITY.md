# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in EmMail, please **do not** open a public issue.

Instead, report it privately via [GitHub Security Advisories](https://github.com/verygoodplugins/emmail/security/advisories/new). We aim to respond within 3 business days.

For urgent issues you may also email [support@verygoodplugins.com](mailto:support@verygoodplugins.com).

## Supported Versions

The latest commit on the default branch (`main`) receives security updates. Older forks and tags may be patched on a case-by-case basis.

## Disclosure Policy

We follow coordinated disclosure: we'll work with you on a fix and credit you in the release notes if you wish.

## Scope of particular interest

EmMail is a **single-tenant email marketing Worker** (contacts, broadcasts, automations, Resend webhooks, open/click/unsubscribe tracking). Reports of interest include:

- Admin auth bypass or cookie/session issues around `EMMAIL_ADMIN_TOKEN`
- Ingest endpoint abuse or secret leakage (`EMMAIL_INGEST_SECRET`)
- Tracking / unsubscribe token forgery (`TRACKING_SECRET`)
- Send-pipeline idempotency failures that could double-mail contacts
- Resend webhook signature bypass
- Secrets committed in `.dev.vars`, Wrangler config, or sample data

## Notes for self-hosters

If you fork this repository to deploy your own instance:

- **Create your own Cloudflare resources.** Example Worker / D1 / queue names and IDs in `wrangler.toml` are templates — replace them before a real deploy.
- **Set Worker secrets** (`wrangler secret put`): `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `TRACKING_SECRET`, `EMMAIL_INGEST_SECRET`, `EMMAIL_ADMIN_TOKEN`. Use long random values.
- **Keep `EMMAIL_SEND_MODE=dry-run`** until Resend domain verification and the webhook loop are proven.
- **Never commit `.dev.vars` or `.env*`.** They are gitignored; keep them that way.
- **Rotate admin / ingest / tracking secrets** whenever someone with access leaves the project.
