# Keyless — Full MVP Build Specification (for Claude Code)

> Paste this whole file into Claude Code, or save it in the repo root as `SPEC.md` and tell Claude Code: "Read SPEC.md and build it milestone by milestone."

---

## 0. How you (Claude Code) should work on this

1. Read this entire spec before writing code. Ask me clarifying questions only where the spec is genuinely ambiguous.
2. Build **milestone by milestone** (section 14). Do not start the next milestone until the current one runs, its tests pass, and you have shown me how to try it.
3. At the start, create `PROGRESS.md` and update it after every milestone: what was built, how to run it, known gaps.
4. **Never guess third-party API details** (ERP APIs, Microsoft Graph, Gmail, Stripe, LLM SDKs). Check the official documentation, and if you cannot, write the adapter against an interface plus a mock, and leave a clear `TODO(verify-api)` comment.
5. Write TypeScript everywhere. Strict mode on. No `any` unless justified in a comment.
6. Every feature needs at least basic tests. The extraction/matching pipeline needs the evaluation harness in section 12.
7. Keep secrets out of code. Use `.env` + `.env.example`.
8. Prefer simple, boring, well-known libraries over clever ones.

---

## 1. Product summary

**Keyless** is a multi-tenant B2B SaaS for small and mid-size wholesale distributors (10–80 staff, UK first).

Their customers send purchase orders (POs) by email — PDF, Excel, CSV, images, or plain email text. Today a staff member ("sales order processor") reads each one and retypes it into the distributor's inventory/ERP system.

Keyless:

1. Reads the orders mailbox automatically.
2. Classifies each email (new order, amendment, cancellation, quote request, other).
3. Identifies which customer sent it.
4. Extracts header and line items with an LLM.
5. Matches the customer's part codes/descriptions to the distributor's own SKUs, learning from every correction.
6. Validates price, stock, duplicates, addresses and credit status.
7. Routes each order: **green** (ready to approve), **amber** (needs review), **red** (blocked / needs customer clarification).
8. After human approval (or auto-approval for trusted rules), pushes a sales order into the distributor's system.
9. Drafts acknowledgment / clarification emails to the buyer.
10. Reports measurable value: orders processed, touch-free rate, time saved, accuracy.

**Core principle:** a human approves orders by default. Nothing reaches the ERP without approval unless an admin explicitly enables an auto-approve rule.

---

## 2. Users and roles

- **Owner** — billing, all settings, user management.
- **Admin** — settings, integrations, rules, catalogue, users (not billing).
- **Reviewer** — reviews and approves orders, edits lines, sends customer emails.
- **Viewer** — read-only dashboards and orders.
- **Super-admin (platform)** — me, the Keyless operator: view tenants, usage, errors, impersonate (with audit log) for support.

---

## 3. Tech stack

- **Backend:** Node.js 20+, TypeScript, Express (or Fastify), Zod for validation.
- **Database:** MongoDB with Mongoose. Every tenant-owned document carries `orgId`; every query is tenant-scoped through a shared helper/middleware (never trust `orgId` from the client).
- **Queue / jobs:** BullMQ + Redis for ingestion, extraction, matching, ERP push, emails, scheduled digests.
- **File storage:** S3-compatible storage (AWS S3 in a UK/EU region, or Cloudflare R2/MinIO for local dev). Signed URLs for viewing.
- **Frontend:** React + Vite + TypeScript, Tailwind CSS, TanStack Query, React Router. A PDF viewer (react-pdf / pdf.js) for side-by-side review.
- **Auth:** email + password with secure hashing (argon2/bcrypt), email verification, password reset, optional Google/Microsoft sign-in. JWT in httpOnly cookies or server sessions. TOTP 2FA for Owner/Admin.
- **LLM:** a provider-agnostic `LlmProvider` interface with at least one implementation (Anthropic Claude). Model names and keys from env. Must support vision input (PDF pages / images) and structured JSON output.
- **Document handling:** pdf parsing (text layer first), PDF → image rendering for scanned/visual PDFs, `xlsx`/`exceljs` for spreadsheets, CSV parser, image handling for photos.
- **Email:** Microsoft Graph (Outlook/M365) and Gmail API via OAuth for reading mailboxes; inbound-forwarding address (e.g. Postmark/SendGrid inbound webhook) as a fallback; transactional sending via a provider (Postmark/SES/Resend) or via the connected mailbox.
- **Payments:** Stripe Billing (subscriptions + usage-based metering).
- **Infra:** Docker + docker-compose for local dev (api, worker, web, mongo, redis, minio). Health checks. Structured logging (pino). Error tracking hook (Sentry-compatible).
- **Repo layout:** monorepo with `apps/api`, `apps/worker`, `apps/web`, `packages/shared` (types, Zod schemas), `packages/eval` (evaluation harness).

---

## 4. Data model (MongoDB collections)

Design proper indexes. All tenant collections have `orgId` + timestamps.

- **Organization** — name, country, timezone, currency, plan, Stripe IDs, settings (auto-approve on/off, confidence thresholds, retention days, default ERP connector).
- **User** — orgId, name, email, role, 2FA, notification preferences.
- **Mailbox** — orgId, type (`graph` | `gmail` | `forwarding`), address, encrypted OAuth tokens, folder/label to watch, status, lastSyncAt.
- **InboundEmail** — orgId, mailboxId, provider message ID (unique per org), from, to, subject, body text/html, receivedAt, classification, status, linked orderIds, raw stored in S3.
- **Attachment** — orgId, emailId, filename, mime type, size, S3 key, page count, parsed text, page images.
- **Customer** — orgId, ERP customer ID, name, account code, email domains, known sender addresses, delivery addresses, price list ID, credit hold flag, trusted-for-auto-approve flag.
- **Product** — orgId, SKU, description, unit of measure, pack size, barcode, default price, stock (synced or imported), active flag. Text index for search.
- **PriceList / CustomerPrice** — orgId, customerId or price list ID, SKU, price, valid from/to.
- **CrossReference** — orgId, customerId, customer part code and/or normalised description → SKU, UoM conversion factor, source (`import` | `learned` | `manual`), confidence, timesUsed, lastUsedAt. **This is the core learning asset.**
- **Order** — orgId, customerId, emailId, attachmentId, PO number, order date, requested delivery date, delivery address, notes, currency, status (`extracting` | `needs_review` | `ready` | `approved` | `pushing` | `pushed` | `push_failed` | `rejected` | `on_hold` | `duplicate`), route colour, overall confidence, timings (receivedAt, extractedAt, approvedAt, pushedAt), approvedBy, ERP order reference, idempotency key, version.
- **OrderLine** — orderId, line no., raw text, customer part code, raw description, quantity, raw unit, raw unit price, matched SKU, candidate SKUs (top 3 with scores), converted quantity/UoM, expected price, validation flags, field confidences, line colour, edited flag.
- **ValidationIssue** — orderId/lineId, type, severity, message, resolved flag.
- **Correction** — orgId, orderId, lineId, field, before, after, userId, timestamp (feeds learning + accuracy metrics).
- **Rule** — orgId, type (auto-approve, require-review, block), conditions (customer, value threshold, line count, confidence), actions.
- **Connector** — orgId, type (`csv_export` | `unleashed` | `cin7_core` | `quickbooks_online` | `mock`), encrypted credentials, field mappings, status, last sync.
- **OutboundEmail** — orgId, orderId, type (acknowledgment, clarification), to, subject, body, status (draft/sent/failed), sentBy.
- **AuditLog** — orgId, actor, action, entity, before/after summary, IP, timestamp. Append-only.
- **UsageRecord** — orgId, period, orders processed, pages processed, LLM tokens/cost.
- **Job / ErrorLog** — for failed jobs with retry info.

---

## 5. Ingestion pipeline (worker)

1. **Mailbox sync:** poll or subscribe (Graph change notifications / Gmail push where feasible; polling every 1–2 minutes as baseline). Only the configured folder/label. Deduplicate by provider message ID.
2. **Forwarding address:** each org gets a unique inbound address (e.g. `orders-<slug>@in.keyless.app`); inbound webhook stores the email the same way.
3. **Store raw** email and attachments in S3; create `InboundEmail` + `Attachment` records.
4. **Classify** the email with the LLM (+ cheap heuristics first): `new_order`, `amendment`, `cancellation`, `quote_request`, `delivery_query`, `not_order`. Only `new_order` continues automatically; amendments/cancellations create a review task linked to the existing order (matched by PO number + customer); everything else is shown in an "Other emails" list and left alone.
5. **One email can contain several POs** (multiple attachments, or multiple orders in one PDF). Split into separate orders.
6. All steps are idempotent BullMQ jobs with retries and exponential backoff. Failures land in a visible "Processing errors" list.

---

## 6. Extraction

- Text-layer PDFs: extract text with layout; scanned PDFs/images: render pages to images and use vision. Excel/CSV: parse to rows and let the LLM map columns. Email body orders: use the body text.
- Call the LLM with a strict JSON schema (define it in `packages/shared` with Zod and validate the output; on invalid output, retry once with the validation error, then mark for review):

```json
{
  "customer": { "name": "", "accountNumber": "", "email": "" },
  "poNumber": "",
  "orderDate": "YYYY-MM-DD",
  "requestedDeliveryDate": "YYYY-MM-DD",
  "deliveryAddress": { "line1": "", "line2": "", "city": "", "postcode": "", "country": "" },
  "notes": "",
  "currency": "GBP",
  "lines": [
    {
      "lineNo": 1,
      "customerPartCode": "",
      "description": "",
      "quantity": 0,
      "unit": "",
      "unitPrice": null,
      "lineTotal": null
    }
  ],
  "documentTotals": { "subtotal": null, "tax": null, "total": null },
  "fieldConfidence": { "poNumber": 0.0, "deliveryAddress": 0.0, "lines": [ { "quantity": 0.0, "customerPartCode": 0.0, "description": 0.0, "unitPrice": 0.0 } ] }
}
```

- **Deterministic checks after extraction:** line count matches the document, sum of line totals ≈ document subtotal (tolerance), quantities are positive numbers, dates are valid. Failures lower confidence and add a ValidationIssue.
- Never invent values: missing fields must be `null`, not guessed. Put this rule in the prompt.
- Store prompt version, model, tokens and cost per extraction (for UsageRecord and debugging).
- Customer-specific hints: include learned hints for this customer in the prompt (e.g. "this customer's codes are in column 2"), stored on the Customer record.

---

## 7. Customer identification and matching

**Customer identification (in order):** exact known sender address → sender email domain → account number on the PO → fuzzy name match. If ambiguous or unknown → amber with a customer picker in the review UI. When a reviewer picks a customer for a new sender, offer "remember this sender for this customer".

**Line matching (in order):**

1. CrossReference exact hit on (customerId, customer part code).
2. CrossReference hit on normalised description for this customer.
3. Exact SKU or barcode match in the catalogue (some customers use the distributor's own codes).
4. Fuzzy/semantic search over catalogue descriptions (MongoDB text/Atlas Search or a trigram/embedding approach behind a `ProductSearch` interface) → top 3 candidates with scores.
5. Unit-of-measure conversion using CrossReference factor or product pack size (e.g. customer orders "boxes of 100", SKU is "each").

Each line gets a match confidence. Thresholds are configurable per org.

**Learning loop:** when a reviewer confirms or corrects a match, upsert the CrossReference (source `learned`), increment usage, and record a Correction. Next time the same code from the same customer matches automatically.

---

## 8. Validation rules

For each order and line, create ValidationIssues for:

- Price differs from the customer's price list / contract price beyond a tolerance (configurable %).
- SKU inactive or not found.
- Insufficient stock (if stock data available) — warning, not blocking, unless configured.
- Below minimum order quantity / not a multiple of pack size.
- Duplicate PO number for the same customer (status `duplicate`, red).
- Customer on credit hold (red).
- Delivery address not among known addresses (amber; offer "add to customer").
- Order value above a configurable threshold (amber).
- Requested delivery date in the past.

---

## 9. Routing and approval

- **Green:** customer identified, all lines matched above threshold, no blocking issues → status `ready`.
- **Amber:** any uncertain field/line or non-blocking issue → `needs_review`.
- **Red:** blocking issue (credit hold, duplicate, unreadable document, unknown items majority) → `on_hold`, with a drafted clarification email.
- **Auto-approve rules (off by default):** admin can enable per customer or globally with conditions (e.g. green + trusted customer + value under £X + all lines learned before). Auto-approved orders are pushed automatically and clearly labelled in the UI and audit log.
- Approving an order pushes it via the active connector (job). Rejecting requires a reason.

---

## 10. ERP / system connectors

Create a `Connector` interface:

```ts
interface OrderConnector {
  testConnection(): Promise<ConnectionResult>;
  syncCustomers(): Promise<SyncResult>;
  syncProducts(): Promise<SyncResult>;
  syncPrices?(): Promise<SyncResult>;
  syncStock?(): Promise<SyncResult>;
  createSalesOrder(order: NormalisedOrder, idempotencyKey: string): Promise<PushResult>;
  findExistingOrder?(customerRef: string, poNumber: string): Promise<ExternalOrderRef | null>;
}
```

Implement in this order:

1. **MockConnector** — in-memory/DB fake ERP for development and demos.
2. **CsvExportConnector** — produces a CSV per order (and a daily batch) in a configurable column layout that the customer can import into their system. This makes the product usable with any ERP from day one.
3. **Unleashed** connector.
4. **Cin7 Core** connector.
5. **QuickBooks Online** connector (note: QBO may not have a native sales-order object; check the official docs and map to the correct document type, configurable per org).

For every real connector: verify authentication, endpoints, field names and rate limits against the official API docs before coding (`TODO(verify-api)` where unsure). Use the idempotency key (`orgId + customerId + poNumber + version`) and `findExistingOrder` before creating, so retries never create duplicates. Push failures → `push_failed` with the error shown and a "Retry" button; alert admins after 3 failures.

Also support **imports without a connector**: catalogue CSV, customers CSV, price list CSV, cross-reference CSV, with a column-mapping step and validation report.

---

## 11. Frontend pages

1. **Auth:** sign up, log in, verify email, reset password, 2FA.
2. **Onboarding wizard:** company details → connect mailbox (Graph/Gmail/forwarding) → connect system or choose CSV → import catalogue, customers, prices, cross-references → set thresholds → send a test PO → done.
3. **Inbox / Orders queue (main screen):** tabs for Needs review, Ready, On hold, Pushed, Failed, All. Columns: received time, customer, PO number, lines, value, colour, confidence, age. Filters, search, bulk approve (green only).
4. **Order review screen (most important screen):**
   - Left: original document viewer (PDF/image/Excel rendered/email body), with highlighting of the area for the selected line if available.
   - Right: editable header fields and lines table: customer code, description, quantity, unit, matched SKU (searchable dropdown with top-3 candidates), price vs expected price, issues per line.
   - Colour per line; keyboard shortcuts (next issue, accept suggestion, approve, next order).
   - "Approve and push", "Save", "Hold", "Reject", "Draft clarification email", "Mark as not an order".
   - Activity timeline: received, extracted, edited by whom, approved, pushed.
5. **Other emails:** non-order emails detected, with "convert to order" action.
6. **Customers:** list, detail (senders, addresses, price list, trusted flag, learned cross-references with edit/delete).
7. **Products / Catalogue:** list, search, import, sync status.
8. **Cross-references:** global view, search, bulk import/export.
9. **Rules:** auto-approve / review / block rules builder.
10. **Outbound emails:** templates (acknowledgment, clarification) with variables; sent log.
11. **Analytics dashboard:** orders/day, touch-free %, median minutes email→approved, median review time, lines corrected %, accuracy trend, estimated hours and £ saved (configurable minutes-per-order and hourly cost), top customers by volume, top error causes.
12. **Settings:** organisation, users and roles, mailboxes, connectors, thresholds, notifications, data retention, API keys (later), billing.
13. **Billing:** plan, usage this period vs limit, invoices, upgrade (Stripe Checkout / Customer Portal).
14. **Super-admin panel:** tenants, usage, LLM cost per tenant, error rates, failed jobs, impersonation with audit.

UI quality: clean, fast, desktop-first (reviewers work on desktop), responsive enough for tablet. Clear empty states and loading states. Toasts for actions. Accessible forms.

---

## 12. Evaluation harness (must build — this is how we prove accuracy)

`packages/eval`:

- A `fixtures/` folder where I can drop real or synthetic POs plus a ground-truth JSON per document (expected header + lines + expected SKUs).
- A CLI: `pnpm eval` runs extraction + matching on all fixtures and prints field-level and line-level accuracy, SKU match accuracy, cost per document, and latency; writes an HTML report highlighting every mismatch.
- Generate 20 synthetic messy POs (different layouts, scanned-looking, Excel, email-body orders, multiple POs in one email) to start.
- Run the eval in CI; fail the build if accuracy drops below a configurable baseline.

---

## 13. Notifications, security, compliance, operations

**Notifications:** in-app + email: new orders needing review (batched), push failures, daily digest to managers (orders processed, pending, time saved), weekly value report.

**Security:**
- Tenant isolation enforced in the data layer, with tests proving one org cannot read another org's data.
- Encrypt OAuth tokens and connector credentials at rest (AES-256-GCM with a key from env/KMS).
- Rate limiting, CSRF protection (if cookies), helmet headers, input validation with Zod on every endpoint.
- Signed, short-lived URLs for documents.
- Audit log for every approval, edit, setting change, impersonation.

**Data protection (UK GDPR):**
- Hosting region configurable (default UK/EU).
- Data retention setting: auto-delete raw emails/attachments after N days (orders and metrics kept).
- Org data export (JSON/CSV zip) and full org deletion.
- No customer data used to train models; LLM calls configured for zero retention where the provider supports it (document this as a setting/note).
- Sub-processor list page content in docs.

**Operations:** health endpoints, structured logs with request IDs, job dashboard (Bull Board, admin-only), seed script for demo data, backup notes in README.

---

## 14. Milestones (build in this order)

**M1 — Foundation:** monorepo, docker-compose, auth, orgs, users/roles, tenant-scoping middleware, base UI shell, CI with lint/typecheck/tests.
*Done when:* I can sign up, invite a user, and log in with roles enforced.

**M2 — Catalogue and customers:** CSV imports with mapping (products, customers, prices, cross-references), list/search pages, MockConnector with sync.
*Done when:* I can import a 5,000-product catalogue and search it quickly.

**M3 — Ingestion:** forwarding-address inbound webhook + manual upload (drag and drop PDFs/emails) first; then Microsoft Graph and Gmail OAuth sync. Storage, dedupe, classification.
*Done when:* emails sent to the forwarding address appear classified in the app.

**M4 — Extraction + eval harness:** LLM provider interface, extraction for PDF/scan/Excel/CSV/body, schema validation, deterministic checks, usage/cost tracking, `pnpm eval` with synthetic fixtures.
*Done when:* eval runs and reports accuracy on 20 fixtures.

**M5 — Matching, validation, routing:** customer identification, line matching with candidates, UoM conversion, validation rules, green/amber/red routing.
*Done when:* a test PO produces a coloured order with correct issues.

**M6 — Review screen + learning:** full review UI with document viewer, editing, keyboard shortcuts, approve/hold/reject, corrections feeding CrossReference.
*Done when:* correcting a line once makes the next PO from that customer match automatically.

**M7 — Push to systems:** CsvExportConnector, then Unleashed, Cin7 Core, QuickBooks Online (verified against docs), idempotency, retries, failure UI.
*Done when:* approved orders reach the mock and CSV connectors reliably with no duplicates on retry.

**M8 — Emails, rules, notifications:** acknowledgment/clarification drafts and sending, auto-approve rules, digests and alerts.

**M9 — Analytics + billing:** dashboard metrics, value report, Stripe plans (Starter £295 up to 600 orders/month, Growth £595 up to 2,000, Pro £995 up to 5,000; usage metering, limits with warnings, customer portal).

**M10 — Hardening:** super-admin panel, data retention/export/deletion, security review checklist, performance pass, README and deployment guide, demo seed data.

---

## 15. Explicitly out of scope for this MVP

- Voice/phone order capture, WhatsApp, fax.
- EDI (X12/EDIFACT).
- Quote/RFQ generation (classify only).
- Native mobile apps.
- Connectors beyond those listed.
- Multi-language UI (English only; documents may be in other languages).

---

## 16. Environment variables (create `.env.example`)

`NODE_ENV, APP_URL, API_URL, MONGO_URI, REDIS_URL, S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, ENCRYPTION_KEY, JWT_SECRET, LLM_PROVIDER, ANTHROPIC_API_KEY, LLM_MODEL_EXTRACTION, LLM_MODEL_CLASSIFY, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, INBOUND_EMAIL_DOMAIN, INBOUND_WEBHOOK_SECRET, EMAIL_PROVIDER_API_KEY, EMAIL_FROM, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SENTRY_DSN`

Plus connector-specific keys once verified from official docs.

---

## 17. First action

Start with M1. Before writing code, reply with: (1) the final folder structure, (2) the list of libraries you will use and why, (3) any questions about this spec. Wait for my "go" before generating M1.
