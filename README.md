# Keyless

Multi-tenant SaaS that reads purchase orders from email, extracts and matches them with an LLM,
and pushes approved sales orders into a distributor's ERP. The full spec is in [SPEC.md](SPEC.md);
milestone status is in [PROGRESS.md](PROGRESS.md).

## Requirements

- Node.js 20+ (22 recommended) and pnpm (`corepack enable` or `npm i -g pnpm`)
- MongoDB. **Nothing to install:** `pnpm dev` starts a local MongoDB automatically (downloaded once
  by `mongodb-memory-server`, data kept in `.data/mongo`). If MongoDB is already running on port
  27017 (a local install or Docker) it uses that instead.
- Docker is optional (`docker compose up -d` gives Mongo, Redis, MinIO and Mailpit).

## Quick start

```bash
pnpm install
cp .env.example .env        # then set JWT_SECRET and ENCRYPTION_KEY (see the comment in the file)
pnpm dev                    # MongoDB + API on :4000 + web on :5173
```

Open http://localhost:5173 and sign up. Emails are not really sent in development. Open the
**Dev mailbox** at http://localhost:5173/dev/emails to click verification, invite and reset links.

Optional demo data: one org with a user per role (password `keyless-demo-1234`), plus a
5,000-product catalogue, 60 customers, prices and cross-references:

```bash
pnpm seed
```

| Email                       | Role     |
| --------------------------- | -------- |
| owner@demo.keyless.local    | owner    |
| admin@demo.keyless.local    | admin    |
| reviewer@demo.keyless.local | reviewer |
| viewer@demo.keyless.local   | viewer   |

Make yourself platform super-admin: `pnpm --filter @keyless/api make-superadmin you@example.com`.

## Commands

| Command          | What it does                                         |
| ---------------- | ---------------------------------------------------- |
| `pnpm dev`       | DB + API (watch) + web (Vite)                        |
| `pnpm test`      | All tests (API tests use an in-memory MongoDB)       |
| `pnpm typecheck` | TypeScript across all packages                       |
| `pnpm lint`      | ESLint                                               |
| `pnpm build`     | Production builds (`apps/api/dist`, `apps/web/dist`) |
| `pnpm seed`      | Demo organisation, users and catalogue               |

## Layout

```
apps/api         Express API (auth, users, orgs, audit, catalogue, imports, connectors)
samples/         Example CSV exports for trying imports (regenerate: pnpm --filter @keyless/api samples)
apps/web         React + Vite + Tailwind frontend
packages/shared  Zod schemas and types shared by API and web
```

`apps/worker` (BullMQ jobs) arrives in M3 and `packages/eval` (accuracy harness) in M4.

## Free hosted options (when you deploy)

- MongoDB Atlas M0 (free, choose an EU/UK region): set `MONGO_URI`.
- Upstash Redis free tier (from M3): set `REDIS_URL`.
- Cloudflare R2 (10 GB free) for files (from M3): set the `S3_*` variables.
- Anthropic API key for extraction (M4). Until then `LLM_PROVIDER=mock` runs offline.

## Security notes

- Tenant isolation is enforced in the data layer (`apps/api/src/db/tenant.ts`): any query on a
  tenant collection without `orgId` throws. Cross-tenant system lookups must opt in with
  `{ skipTenant: true }`. Tests in `apps/api/test/tenancy.test.ts` prove it.
- Passwords: argon2id. Sessions: 15-minute JWT access cookie plus a rotating refresh cookie with
  reuse detection, both httpOnly and SameSite=Lax. CSRF: double-submit token.
- TOTP secrets are encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`).
- Backups: use Atlas continuous backups in production, or `mongodump` on a schedule for self-hosted.
