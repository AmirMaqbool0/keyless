# Keyless

Keyless is a production-grade, multi-tenant B2B SaaS platform that automatically reads purchase orders from distributor customer emails, extracts line items and metadata with high-accuracy LLMs, matches customer part numbers with internal product catalogues, routes orders based on confidence and custom validation rules, and pushes approved orders directly into ERP systems (Unleashed, Cin7 Core, QuickBooks Online, or automated CSV exports).

The complete specification is in [SPEC.md](SPEC.md); milestone status is in [PROGRESS.md](PROGRESS.md); free deployment instructions are in [DEPLOYMENT.md](DEPLOYMENT.md).

---

## Architecture & Technology Stack

- **Monorepo:** `pnpm` workspaces + Turborepo.
- **Frontend (`apps/web`):** React 19, TypeScript, Vite, TailwindCSS, React Query (@tanstack/react-query), React Router 7.
- **Backend API (`apps/api`):** Express 5, TypeScript, Zod, Helmet, CORS, CSRF, Rate-limiting, Pino logging with request IDs.
- **Background Worker (`apps/worker`):** Resilient queue consumer (`mongo` polling driver for zero-dependency local dev or `bullmq` with Redis), background email parsing, document OCR/extraction, scheduled mailbox synchronization.
- **Core Engine (`packages/core`):** Database models (Mongoose with enforced multi-tenant isolation plugin), AES-256-GCM encryption, S3/local file storage abstraction, ERP connectors, rules engine, learning cross-reference loop.
- **Shared Contracts (`packages/shared`):** Zod schemas and TypeScript types shared across API and client.
- **Evaluation Harness (`packages/eval`):** Automated ground-truth test suite running across 20 synthetic purchase orders measuring extraction accuracy, confidence scores, and token costs.

---

## Requirements

- **Node.js:** Node 20+ (Node 22 LTS recommended) and pnpm (`corepack enable` or `npm i -g pnpm`).
- **Database:** MongoDB 6.0+. **Zero install needed for development:** `pnpm dev` automatically spawns an ephemeral MongoDB via `mongodb-memory-server` and stores state in `.data/mongo`. If a local or containerized MongoDB is already running on port 27017, Keyless connects to it automatically.
- **Docker (Optional):** Run `docker compose up -d` for a complete stack (MongoDB, Redis, MinIO S3, and Mailpit).

---

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env
# Set JWT_SECRET and ENCRYPTION_KEY in .env
# (generate a 32-byte key: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")

# 3. Start local development
pnpm dev
```

`pnpm dev` starts:
- MongoDB (if not already running)
- API server on `http://localhost:4000`
- Worker process with live file watching
- Web application on `http://localhost:5173`

Open `http://localhost:5173` in your browser. All outbound emails (verification, invitations, password resets) are intercepted locally in development. View them in the **Dev Mailbox** at `http://localhost:5173/dev/emails`.

---

## Demo Seed Data

To populate a rich testing environment with a sample distributor company, full product catalogue, customers, and active cross-references:

```bash
pnpm seed
```

This creates the `demo` workspace with accounts for all roles (Password: `keyless-demo-1234`):

| Email                       | Role     | Capabilities                                  |
| --------------------------- | -------- | --------------------------------------------- |
| `owner@demo.keyless.local`    | owner    | Full access, billing, danger zone org deletion |
| `admin@demo.keyless.local`    | admin    | Settings, team invites, connectors, rules     |
| `reviewer@demo.keyless.local` | reviewer | Order review, corrections, approvals          |
| `viewer@demo.keyless.local`   | viewer   | Read-only access to orders and metrics        |

To grant an account platform super-admin rights:
```bash
pnpm --filter @keyless/api make-superadmin owner@demo.keyless.local
```

---

## Operations & Super-admin Console

Operators with `isSuperAdmin: true` can access the **Platform Admin Console** (`/superadmin`):
- **Platform KPIs:** Total tenants, active paid subscriptions, total orders processed, estimated LLM costs, and failed background queue jobs.
- **Tenant Directory:** Review tenant usage, order volume, error rates, and active user counts.
- **Support Impersonation:** Authorized platform admins can securely impersonate any tenant user for support purposes. Every impersonated action generates an immutable audit record with actor type `superadmin`.
- **Queue Job Resiliency:** Inspect failed background worker jobs with error traces, with one-click **Retry** or **Dismiss** options.

---

## GDPR & Data Privacy

Keyless is engineered strictly in compliance with UK GDPR and EU data protection standards:

1. **Configurable Data Retention:** Tenants can define a retention threshold (default 90 days). The background prune routine erases raw MIME payloads and file attachments while preserving structured order records and analytics for statutory accounting compliance.
2. **Complete Data Portability:** Tenants can export their complete workspace at any time via **Organisation Settings > Export All Data (JSON)**, bundling all customers, products, customer prices, cross-references, automation rules, and historical orders.
3. **Tenant Right to Erasure:** Workspace owners can permanently delete their organization via the **Danger Zone**. This soft-deletes the organization, revokes all user sessions, and invalidates all authentication cookies immediately.
4. **Zero Model Training Retention:** LLM providers (Anthropic Claude) are invoked with zero-data-retention headers. Customer purchase orders and proprietary catalogues are never used to train foundational models.

### Sub-Processor List

| Sub-processor | Purpose | Location |
| ------------- | ------- | -------- |
| **Anthropic, PBC** | LLM Extraction & Classification (zero retention) | United States / EU |
| **Stripe, Inc.** | Payment processing and billing subscriptions | United States / EU |
| **Amazon Web Services / Cloudflare** | Encrypted S3-compatible document storage | UK / EU (Configurable) |
| **MongoDB Atlas** | Hosted document database with encryption at rest | UK / EU (Configurable) |
| **Microsoft / Google** | OAuth integration for mailbox ingestion | Tenant's cloud region |

---

## Production Deployment & Operational Commands

### Monorepo CLI Commands

| Command | Action |
| ------- | ------ |
| `pnpm dev` | Starts DB, API, worker, and frontend concurrently |
| `pnpm test` | Runs the full automated test suite (18 test files, 130+ tests) |
| `pnpm typecheck` | Strict TypeScript verification across all packages |
| `pnpm lint` | ESLint check across the monorepo |
| `pnpm build` | Compiles production bundles (`apps/api/dist`, `apps/web/dist`) |
| `pnpm seed` | Seeds demo organization, users, and 5,000-SKU catalogue |
| `pnpm eval` | Runs the LLM extraction accuracy harness on 20 synthetic POs |

### Backups & Disaster Recovery

- **Automated Backup:**
  ```bash
  mongodump --uri="$MONGO_URI" --gzip --archive=/backups/keyless-$(date +%Y%m%d_%H%M%S).gz
  ```
- **Restore:**
  ```bash
  mongorestore --uri="$MONGO_URI" --gzip --archive=/backups/keyless-backup.gz --drop
  ```

---

## Security Architecture

- **Data Layer Tenant Isolation:** Enforced via Mongoose query middleware (`packages/core/src/db/tenant.ts`). Any database query or aggregation on tenant collections lacking an `orgId` throws a fatal `TenantScopeError` by default.
- **Cryptographic Storage:** OAuth tokens and ERP credentials are encrypted at rest with AES-256-GCM.
- **Token Security:** 15-minute JWT access cookies with 30-day rotating refresh tokens with automatic reuse detection and revocation.
- **CSRF & Rate Limiting:** Double-submit CSRF cookie protection and sliding-window rate limiters on all public endpoints.
