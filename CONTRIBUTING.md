# Contributing to EmMail

Thank you for your interest in contributing.

## Before you start

**Please open an issue before submitting a large pull request.** That helps us:

- Discuss whether the change fits a single-tenant mail core (not a full ESP suite)
- Avoid duplicate work
- Provide guidance on migrations, send-pipeline safety, and secrets

For bug reports, include steps to reproduce, whether you used local Worker + Vite (`npm run dev:local`) or a deployed Worker, and whether mail was in `dry-run` or live send mode. For feature requests, explain the use case.

## Agent / project conventions

- **`AGENTS.md` is canonical** for coding agents. Do not put lasting project rules only in `CLAUDE.md` (that file is `@AGENTS.md`).
- Config in-tree is still an example brand — rename Worker / D1 / queue / domain / from-address / ingest path before a real deploy.
- Security vulnerabilities: report privately via GitHub Security Advisories (see [`.github/SECURITY.md`](./.github/SECURITY.md)), not public issues.

## Pull request process

1. Open an issue describing the proposed change (unless it is a tiny docs fix).
2. Wait for maintainer feedback before large work when unsure.
3. Fork the repo and create a branch from `main`.
4. Make your changes. Prefer conventional commit messages (`feat:`, `fix:`, `docs:`, …).
5. **PR titles must use Conventional Commits** because squash merges become the commit title on `main`. Do not prefix titles with `[codex]`, `[claude]`, `[copilot]`, `[wip]`, or similar — put agent/status context in the PR body.
6. Validate:

   ```bash
   npm run format:check
   npm run test:run
   npm run typecheck
   ```

   Ingest → enroll → drain (no Wrangler): `npm run test:ingest`.

7. Open a PR with a clear summary and test plan. Include an admin UI screenshot when the UI changed. Call out anything that can send mail, change suppression, or touch secrets.

## Code of conduct

Be respectful. We assume good intent and prefer concrete repros over blame.
