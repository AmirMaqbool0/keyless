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

## M3 - Ingestion ✅ (2026-10-26)

**Done when:** emails sent to the forwarding address appear classified in the app. Verified three
ways:

1. A raw PO email POSTed to `/webhooks/inbound` on the running dev stack was classified
   `new_order` (92%) by the worker within 4 s.
2. In the browser, "Send test email" for body order / amendment / quote / out-of-office each
   landed with the right label, and the PO PDF previews inline.
3. The test suite covers webhook → parse → classify for all 8 sample scenarios.

### Built

- **packages/core** (refactor, separate commit): config, models, storage, connectors and now the
  queue and ingestion pipeline are shared by the API and the new **apps/worker** process.
- **Queue:** a `JobQueue` interface with two drivers.
  - **MongoDB** (default, no install): unique keys, exponential backoff (5 s → 10 min, 5
    attempts), lease-based recovery when a worker dies, completed jobs expire after 7 days.
  - **BullMQ** (`QUEUE_DRIVER=bullmq` + Redis).
  - Both drivers record jobs that fail for good in `ErrorLog`, shown under **Settings →
    Processing errors** with Retry / Dismiss.
- **Storage:** an S3-compatible driver (AWS S3 / R2 / MinIO, presigned URLs) next to local disk.
  Local files are served through **signed, expiring links** (`/api/files/<token>`, HMAC, 5-30
  min). Non-PDF/image files are served under a sandbox CSP.
- **Data model:** Mailbox, InboundEmail (unique per org on a dedupe key, classification plus
  history), Attachment (kind, inline flag, sha256), Job, ErrorLog.
- **Ingestion pipeline:**
  - **Receive:** store the raw MIME and dedupe it, Message-ID first, so the same email arriving
    by two routes is stored once.
  - **process-email:** parse with mailparser; attachments go to storage; tiny inline images
    (signatures/logos) are flagged; re-runs replace earlier records.
  - **classify-email:** heuristics first (auto-replies, bounces, newsletters, order files and
    lines, amend/cancel/quote/delivery wording); below 80% confidence the `LlmProvider` gives a
    second opinion. A reviewer's manual choice is never overwritten.
- **Ways in:**
  - **Forwarding webhook**, provider-agnostic: raw MIME, Postmark-style JSON or SendGrid-style
    multipart. Shared-secret or Basic auth. Routing by the `orders-<slug>-<random>@` alias;
    unknown recipients get 202 and are dropped. A paused address doesn't import.
  - **Manual upload** (reviewer+): `.eml` files or documents (PDF/Excel/CSV/images/Word). A
    document is wrapped in a synthetic email so it takes the same path. The same file twice is
    one email. `.msg` gets a helpful message.
  - **Microsoft 365 and Gmail OAuth** (admin): authorization code + PKCE (verifier in an httpOnly
    cookie, never in the URL), encrypted tokens, refresh on expiry/401, rotated refresh tokens
    kept. Graph delta sync (saves the delta link every page; an expired token restarts the 2-day
    lookback). Gmail history sync (a 404 triggers a full resync). A revoked grant sets the
    mailbox to "reconnect needed". The worker queues due syncs every 30 s.
- **LLM:** `LlmProvider` interface plus `MockLlmProvider` (offline). The Anthropic provider is M4.
- **Web:**
  - **Inbox:** tabs All / Orders / Other emails / Failed with counts, search, drag-and-drop
    upload, live refresh while processing, dev "Send test email".
  - **Email detail:** attachment preview (PDF/image), text or sandboxed HTML body (no scripts,
    no remote images), classification reasons, a correct-it dropdown, activity timeline,
    .eml download, reprocess.
  - **Settings:** Mailboxes (forwarding address with copy, per-provider setup steps, connect /
    sync / pause / folder / disconnect) and Processing errors.
- **Docs:** [docs/inbound-email.md](docs/inbound-email.md), covering the webhook formats, a free
  Cloudflare Email Routing setup ([worker script](docs/cloudflare-email-worker.js)) and Microsoft /
  Google app registration steps.

### Bug fixed from M1

After 15 idle minutes the browser drops the access cookie (it expires with its token). The API
then answered "not signed in" rather than "token expired", so the web client never tried its
30-day refresh cookie and sent users back to the login page. The client now tries one refresh on
any 401 from a non-auth endpoint. Verified in the browser.

### Tests (84 total: 82 API + 2 shared, all passing)

- `classify.test.ts`: 14 heuristic cases.
- `ingestion.test.ts`: the done-when flow end to end, all 8 scenarios, dedupe, cross-org
  routing, envelope recipients, JSON/multipart/Basic auth, bad secret, paused address,
  uploads + roles + duplicate files, manual reclassify survives reprocess, unreadable email →
  failed + processing error, tenant isolation, dev test email.
- `queue.test.ts`: backoff and permanent failure → ErrorLog, no retry on permanent errors,
  unique keys and reset, dead-worker lease recovery, retry endpoint and roles.
- `mailboxes.test.ts` (Microsoft/Google faked at the HTTP layer): forwarding address, OAuth start
  (PKCE, scopes, redirect URI), state check, code exchange and encrypted tokens; Graph delta
  pages → deltaLink → incremental run; token refresh with rotation; revoked grant; Gmail
  lookback → history → dedupe → 404 resync.

### Not verified / known gaps

- **Not run against real services:** Microsoft Graph, Gmail, Cloudflare/Postmark/SendGrid, S3
  and BullMQ+Redis are untested here because no accounts or Redis are available on this machine.
  The HTTP shapes follow the official docs and are covered by faked-HTTP tests. Two
  `TODO(verify-api)` notes mark the least certain spots: Graph's `changeType` + `$filter`
  combination, and Postmark's JSON field names.
- **Still to come:** amendments/cancellations are only labelled; linking them to orders is M5.
  "Convert to order" in Other emails becomes useful in M4/M5 (reclassifying already works).
- **Formats:** Outlook `.msg` uploads are not supported. Emails _manually_ forwarded by staff
  show the staff member as sender; customer detection inside forwarded content is M5.
- **Scale:** the Mongo queue suits one worker or a few. Use BullMQ for more.
- **No web unit tests yet;** the UI was checked by hand in the browser.

## M4 - Extraction + eval harness ✅ (2026-10-26)

**Done when:** the eval runs and reports accuracy on 20 fixtures. `pnpm eval` runs all 20 and prints
field-level and line-level accuracy, cost per document and latency. It writes an HTML report that
highlights every mismatch, and CI fails if accuracy drops below `packages/eval/baseline.json`.

**Offline results (mock provider, no API key):**

| Metric                    | Result  |
| ------------------------- | ------- |
| Header fields             | 82.7%   |
| Line fields               | 95.6%   |
| Lines found               | 94.4%   |
| Lines correct (no extras) | 100%    |
| Orders found              | 91.3%   |
| Perfect documents         | 18 / 20 |
| Cost                      | $0      |
| Median latency            | ~20 ms  |

The two misses are the scanned PDF and the phone photo. They are correctly reported as "needs an
AI model with vision" rather than guessed.

> **Read these numbers carefully.** The offline reader was improved against these same fixtures,
> so treat its score as a regression gate for the pipeline, not as real-world accuracy. Claude has
> not been run against the fixtures because no Anthropic key is available here.
> `pnpm eval --provider anthropic` produces that report as soon as a key is set (roughly
> $0.02-0.10 per document on claude-opus-5-5, to be confirmed by the report).

### Built

- **Extraction schema** (`packages/shared/src/extraction.ts`): the spec's JSON shape as Zod, with
  `orders: []` so one document can hold several POs. Every value is nullable ("never invent").
  There is a confidence per field and per line.
- **Document preparation:**
  - **PDFs:** text layer via pdf.js, with line and column layout rebuilt so tables survive.
    Wrapped cells and repeated page headers are handled.
  - **Scanned PDFs** (under 80 characters per page) go to the model as the PDF itself, for vision.
  - **Photos** are EXIF-rotated, resized and converted with sharp.
  - **Excel and CSV** become pipe-separated tables.
  - **Email bodies** have quoted replies trimmed but forwarded content kept.
- **LLM providers** behind `LlmProvider`:
  - **AnthropicProvider** (official SDK 0.135):
    - Structured output via `output_config.format` + `betaZodOutputFormat`.
    - PDFs as `document` blocks and images as `image` blocks for vision.
    - Prompt-cached system prompt.
    - Server-side refusal fallbacks (`fallbacks: "default"`): if Claude's safety filters decline a
      document, it is retried on another model within the same call. A refusal that survives
      that is recorded as failed, not retried.
    - Default model `claude-opus-5-5` (effort `medium` for extraction, `low` for
      classification), configurable through `LLM_MODEL_EXTRACTION` / `LLM_MODEL_CLASSIFY`.
  - **MockLlmProvider:** a deterministic offline reader (`ruleExtractor.ts`) for tables, wrapped
    rows, multi-page and multi-PO documents, PO numbers in subjects, signatures, "10 x CODE",
    "CODE - desc - qty" and free text such as "5 cases of …". It never claims to read scans.
- **Pipeline** (`extractEmail`, no database, so the eval runs exactly the production code):
  - It reads order documents, or the body when there are none.
  - Model output is validated against the schema; on failure it **retries once with the
    validation error**, then marks the source failed.
  - **Deterministic checks:** no lines, missing PO, missing/non-positive quantities, line total ≠
    qty × price, lines ≠ subtotal, subtotal + VAT ≠ total, invalid/future/old dates, delivery
    before order or in the past, a line count different from the document's own table rows, and
    the same PO twice in one email. Each issue lowers the order's confidence.
- **Storage and cost:** an `Extraction` record per source (prompt version, provider, model,
  tokens, cost, duration, attempts) and an email-level summary. `UsageRecord` adds up LLM calls,
  tokens, cost, pages, documents and orders per org per month (classification calls included).
- **Triggers:** classified `new_order` → `extract-email` job. A reviewer reclassifying an email as
  "New order" (the spec's "convert to order") queues extraction too, and there is a
  **Re-extract** button.
- **Web:**
  - **Inbox:** a "Read" column ("4 lines", "2 orders", "needs AI key", "3 to check").
  - **Email page:** an "Extracted orders" card with header fields, issues, and a lines table
    where values the model was unsure of are amber, plus the model, prompt version and cost.
- **Eval harness** (`packages/eval`):
  - `generate` builds 20 deterministic fixtures from the demo catalogue: standard, reordered
    columns with a wrapped header, no prices, 38-line multi-page, 2 POs in one PDF, 2 PDFs,
    customer codes with delivery date and notes, a scanned PDF (image only, skewed), a phone
    photo, Excel with title rows, bare Excel, CSV, CSV holding 2 POs, four email-body styles,
    a forwarded order, VAT/account/long dates, and wrapped descriptions with units.
  - The ground truth includes the expected SKU for M5.
  - `eval` scores with these rules: null vs null is not counted, an invented value is wrong,
    codes ignore separators, descriptions are compared by word overlap, numbers within 0.01.
  - It prints a summary (`-v` lists every mismatch), writes `reports/report-<provider>.html`
    and `latest-<provider>.json`, and supports `--ci` (2-point tolerance) and
    `--update-baseline`.
- **M2 gap closed:** catalogue/customer imports now accept **.xlsx** (first sheet), not only CSV.

### Tests (96 total, all passing)

- `extraction.test.ts`: checks (clean order, and every issue type), UK/long dates, a PDF read end
  to end, retry-once-then-fail with usage summed, refusal (no retry), photo without vision →
  `needs_llm`, automatic extraction with the email summary/timeline/usage, reclassify →
  extraction, re-extract replaces results, viewer cannot re-extract.
- `packages/eval/src/score.test.ts`: the scoring rules.
- Excel import end to end; the earlier M1-M3 suites updated for the new extraction step.
- CI gate verified both ways: the full run passes, and a scan-only subset fails with exit 1.

### Not verified / known gaps

- **Claude itself has not been run** (no key on this machine). The provider follows the bundled
  SDK documentation and typechecks against SDK 0.135, but its first real run should be
  `pnpm eval --provider anthropic` to measure accuracy and cost before trusting it.
- **Visual highlighting:** the spec's "highlight the area for the selected line" needs positions
  from the model or OCR. It is M6 work with the review screen.
- **Document types:** Word (.docx) attachments and old .xls files are not read (the email body is
  still used). Embedded/forwarded `.eml` attachments are not opened yet.
- **Customer hints** are plumbed into the prompt but not filled until customer identification
  exists (M5).
- **Orders:** extractions are stored but not yet turned into Orders. That is M5 (matching,
  validation, routing).

## Next: M5 - Matching, validation, routing

Customer identification (sender → domain → account number → fuzzy name), line matching
(cross-reference → description → SKU/barcode → fuzzy search via `ProductSearch`, top-3
candidates), UoM conversion, the validation rules from spec section 8, and green/amber/red routing
into real Order records. The eval gains SKU match accuracy using the `expectedSku` already in
every fixture.
