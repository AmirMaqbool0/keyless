# Progress

## M1 - Foundation ✅ (2026-10-26)

**Done when:** I can sign up, invite a user, and log in with roles enforced. Verified with the
automated tests and by hand in the browser (sign up → verify email → invite reviewer → accept →
reviewer sees a read-only team page).

### Built

- **Monorepo:** pnpm workspaces, strict TypeScript, ESLint + Prettier, GitHub Actions CI
  (lint, typecheck, test).
- **Zero-install dev DB:** `pnpm dev` starts MongoDB itself (or uses one already on :27017).
  `docker-compose.yml` is provided for when Docker is installed.
- **packages/shared:** Zod schemas for auth, users and orgs, plus role helpers. The API and the
  web app both use them.
- **apps/api:**
  - Auth: sign up (creates org + owner), email verification, login, logout, refresh-token rotation
    with reuse detection, forgot/reset password, TOTP 2FA with 8 single-use recovery codes.
  - Users: list, invite (email link, 7 days), revoke invite, change role, remove (signed out
    immediately). Rules: admins can't touch owners, nobody manages themselves, an org always keeps
    at least one owner.
  - Organisation settings, an append-only audit log, health endpoints (`/health`, `/health/ready`).
  - Tenant-scoping Mongoose plugin that fails closed. orgId always comes from the session.
  - Security: helmet, CORS, rate limits, CSRF, Zod on every input, pino logs with request IDs.
  - Dev mailer shows emails at `/dev/emails`. Seed script and make-superadmin script.
- **apps/web:** sign-up, login (+2FA step), forgot/reset password, verify email, accept invite,
  app shell with role-aware navigation, Organisation / Team / Security (2FA) / Audit log pages,
  placeholder pages for later milestones, dev mailbox.

### How to try it

```bash
pnpm install
pnpm dev            # http://localhost:5173
pnpm seed           # optional demo users (see README)
pnpm test           # 23 tests
```

### Tests

- `packages/shared`: role helpers.
- `apps/api/test/auth.test.ts`: sign-up/verify, login, CSRF, refresh rotation + reuse detection,
  logout, password reset kills sessions, 2FA + recovery codes.
- `apps/api/test/users.test.ts`: invites, role matrix, owner protections, immediate role changes,
  removal ends sessions.
- `apps/api/test/tenancy.test.ts`: unscoped queries throw; org A cannot read or change org B through
  the API; audit log is append-only.

### Known gaps / decisions

- Google/Microsoft sign-in is not built yet (spec says optional). It can come with the M3 mailbox
  OAuth work.
- 2FA is available to every role and recommended for owners/admins, but not forced. An org setting
  "require 2FA for admins" can be added in M10.
- Rate limiting uses an in-memory store. Switch to Redis when there is more than one API instance.
- Email: console/dev mailer only. A real provider (Postmark/Resend free tier) plugs in behind
  `Mailer` in M8 or earlier when needed.
- The super-admin flag exists (script); the panel itself is M10.
- One user belongs to one org (MVP decision).

## M2 - Catalogue and customers ✅ (2026-10-26)

**Done when:** I can import a 5,000-product catalogue and search it quickly. Measured in the test
suite: **5,000 products import in ~1.5 s, search returns in ~60-70 ms.** Also done by hand in the
browser: upload `samples/products.csv` → auto-mapped → check → import 5,000 → search.

### Built

- **Data model:** Product, Customer (senders, domains, delivery addresses, price list, credit hold,
  trusted flag, extraction hints), CustomerPrice (contract or price-list, qty breaks, validity
  dates), CrossReference (customer code and/or description → SKU, unit conversion factor, source,
  usage counters), ImportJob, Connector, MockErpOrder. All tenant-scoped, with indexes on the
  lookup keys that matching will use in M5.
- **CSV imports (admin):** upload → automatic column mapping (recognises typical ERP headers such as
  "Stock Code", "Pack Qty", "EAN", "On Stop") → dry-run check with a row-by-row problem report →
  import. Re-imports update in place, and blank cells never wipe existing data. Rows with problems
  are skipped and reported. Handles Excel's UTF-8 BOM, Windows-1252 files (£ signs), "£1,234.50",
  yes/no/Y/1 and UK dates. One-row-per-address customer exports are merged. Blank templates can be
  downloaded. Up to 100,000 rows / 25 MB.
- **Matching-friendly keys:** customer part codes are compared ignoring case and separators
  (`ab-12.3` = `AB123`), so a code typed differently updates the same cross-reference.
- **Lists and search:** products (by SKU, description words or barcode; an exact SKU/barcode hit is
  always first), customers (by name, account code, sender email or domain), cross-references
  (search, filter by source, delete, **CSV export that re-imports cleanly**), prices.
- **Customer page:** order controls (credit hold, trusted for auto-approve), sender addresses and
  domains (editable), delivery addresses, and cross-reference and price tabs.
- **Connectors:** the `OrderConnector` interface from the spec, plus a **MockConnector** (a demo ERP
  with 5,000 products, 60 customers and ~4,900 prices) with sync for customers → products →
  prices → stock. Products that disappear from the ERP are deactivated, not deleted.
  `createSalesOrder` is idempotent (ready for M7). An Integrations page has sync buttons and
  per-entity results.
- **Demo data:** a deterministic generator (catering/janitorial wholesaler). `pnpm seed` now loads
  the full catalogue, customers, prices and cross-references into the demo org. `samples/` holds
  realistic CSV exports to try the import with.
- **Storage:** `Storage` interface with a local-disk driver (`.data/files`); S3/R2 comes in M3.

### How to try it

```bash
pnpm dev
pnpm seed                        # demo org with everything loaded (admin@demo.keyless.local)
```

Or sign up a fresh org and import `samples/products.csv`, then `customers.csv`, `prices.csv` and
`cross-references.csv` from **Data > Imports**. Or connect the Demo ERP under
**Settings > Integrations**.

### Tests (40 total, all passing)

- `parse.test.ts`: encodings, headers, number/boolean/date/list coercion, normalised keys.
- `imports.test.ts`: mapping suggestions, row errors, dry run, re-import without blanking, mapping
  validation, file/role checks, **5,000-row import + search timing**, customers/prices/xrefs with
  lookups, export → re-import round trip, customer edits, cross-org isolation.
- `connectors.test.ts`: full sync, idempotent re-sync, deactivation, idempotent `createSalesOrder`,
  role checks.

### Known gaps / decisions

- Imports run inside the request (5,000 rows ≈ 1.5 s). They move to a BullMQ job when the worker
  arrives in M3, which large (100k-row) files will need.
- CSV only. Excel (.xlsx) upload comes with the extraction work in M4, which needs `exceljs`
  anyway. Until then users save as CSV, and the upload page says how.
- Search is substring matching on a normalised text field. That's fine at 5k-50k products. Fuzzy
  matching that tolerates typos (`ProductSearch` with trigram scoring) is M5 work, where line
  matching needs it.
- Cross-references can be imported, viewed, exported and deleted. Manual add/edit arrives with the
  review screen in M6, where corrections create them.
- The mock connector does not sync cross-references (real ERPs don't hold them either).

## Next: M3 - Ingestion

Forwarding-address inbound webhook + manual upload (drag-and-drop PDFs/emails) first, then
Microsoft Graph and Gmail OAuth. Storage, dedupe and classification. Brings in Redis + BullMQ (the
worker app) and the S3-compatible storage driver.
