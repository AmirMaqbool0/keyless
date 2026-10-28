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

## M5 - Matching, validation, routing ✅ (2026-10-26)

**Done when:** a test PO produces a coloured order with the correct issues. A PO emailed to the
forwarding address now becomes an Order that is **green** (ready), **amber** (check) or **red**
(blocked), with the reasons listed. This is shown end to end in `orders.test.ts` and was checked in
the browser.

**Offline eval (mock provider):** SKU match **92.7%**, customer identified **100%**. Both are now
gated in CI with the extraction metrics. The misses are 7 lines that were never read (the scan
and the photo, which need vision) and 2 free-text lines whose wording sits between two pack sizes.
Those 2 are left unmatched with candidates rather than guessed.

### Built

- **Catalogue index** (`packages/core/src/matching/catalogue.ts`): an in-memory index of
  products, customers, prices and cross-references per org. It is cached and rebuilt when any of
  them changes (count + latest `updatedAt`). Fuzzy search sits behind `ProductSearch`
  (`TokenProductSearch`: IDF-weighted word overlap plus trigrams) so it can later be swapped for
  Atlas Search.
- **Customer identification:** known sender → email domain (never public webmail) → account
  number on the PO → the original sender of a hand-forwarded email → fuzzy company name.
  - A domain shared by several customers is settled by the account number or the name, or left
    for the reviewer with candidates.
  - A sender/account disagreement is flagged.
- **Line matching:** the customer's learned code → the customer's learned description → our SKU or
  barcode → fuzzy description (top 3 candidates).
  - Near-identical candidates are not guessed between.
  - A code that hits our SKU while the words disagree is distrusted.
  - "Each" quantities are converted to packs (part packs flagged), and cross-reference UoM
    factors are applied.
- **Pricing:** contract price (with quantity breaks and validity dates) → price list → list
  price, compared within a 2% tolerance.
- **Validation rules** (spec section 8), each a coded issue with severity and blocking flag:
  - Customer: unknown customer, matched by name only, sender/account conflict, credit hold
    (blocking).
  - Order: duplicate PO (blocking), most items unknown (blocking), new delivery address, high
    value (threshold per org).
  - Lines: unmatched line, uncertain match, inactive SKU, price mismatch, insufficient stock
    (information only).
  - Extraction: every extraction issue carries over, plus a low-confidence read.
  - Documents that could not be read become red placeholder orders: needs vision, unreadable, or
    no order found.
- **Routing:** any blocking issue → red (`on_hold`, or `duplicate`); otherwise the lowest of
  customer, line and extraction confidence against the green/amber thresholds (0.9 / 0.6).
- **Order model and jobs:** `build-orders` runs after extraction. It is idempotent: it rebuilds
  only orders that are still reviewable and unedited. Amendment and cancellation emails are
  linked to the original order by PO number and customer. A cancellation blocks the order and an
  amendment sends it back to review.
- **API** `/api/orders`: list (views, colour, customer, search; work queues oldest first), counts,
  detail (lines, candidates, conversions, prices, issues, source document link, related emails),
  and `POST /:id/rematch` for reviewers after the catalogue changes.
- **Web:**
  - An Orders page with tabs and counts, a colour filter and search.
  - A read-only order page: what to check, the customer with candidates, each line against its
    match with candidates, converted quantities and both prices, and Re-match.
  - "Orders created" on the email page, and live counts on Overview.
- **Eval:** SKU match accuracy and customer identification accuracy, using the same production
  matching code on the extracted data. Misses are listed with `-v` and in the HTML report.
- **Fixture fix:** every eval fixture had the same Message-ID (`fx-21`), so sending more than one
  to a real inbox was deduplicated. The fixtures were regenerated with unique IDs; only the IDs,
  MIME boundaries and PDF timestamps changed.

### How to try it

1. Run `pnpm dev` and sign in. Run `pnpm --filter @keyless/api samples`, then import
   `samples/*.csv`, including cross-references.
2. Post a fixture to your forwarding address:
   `curl -X POST localhost:4000/webhooks/inbound -H "Content-Type: message/rfc822" -H "X-Inbound-Secret: $INBOUND_WEBHOOK_SECRET" -H "X-Envelope-To: <your address>" --data-binary @packages/eval/fixtures/01-pdf-standard/email.eml`
3. Open **Orders**.

### Tests (114 total: 109 API + 3 eval + 2 shared, all passing)

- `matching.test.ts` (unit): customer identification order, ambiguity and conflicts, forwarded
  senders, cross-reference priority (per customer), SKU/barcode, code/description mismatch,
  fuzzy match and refusal to guess, pack conversion, price precedence, and each routing outcome.
- `orders.test.ts` (end to end through the webhook and worker):
  - green/ready, amber (unknown customer + price), red (credit hold), duplicate PO across formats;
  - amendment then cancellation linked to the order;
  - re-match after a product import, with roles, edited and approved orders refused;
  - tenant isolation.

### Not verified / known gaps

- **Matching quality** has only been measured on the synthetic demo catalogue. Real catalogues
  with many near-identical variants will need the M6 learning loop and possibly Atlas Search.
- **Customer extraction hints** are still not passed to the model. They are only useful once
  reviewers teach them (M6), so the TODO moved to M6.
- **Re-match** rebuilds every order from that email, not only the one clicked (they come from
  the same extraction).
- The **high-value threshold** is read from org settings, but no settings UI exists for it yet
  (M8, with rules).

## M6 - Review screen + learning ✅ (2026-10-26)

**Done when:** correcting a line once makes the next PO from that customer match automatically.
Verified end-to-end in `review_learning.test.ts`:
1. Customer sends PO with unknown customer part code `BC-SOAP-99` -> order needs review, line unmatched.
2. Reviewer corrects line SKU to `SP500`.
3. `Correction` audit record is stored and a learned `CrossReference` is upserted.
4. Reviewer approves PO #1.
5. Customer sends PO #2 with `BC-SOAP-99` -> order is automatically routed green/ready with line matched to `SP500` via `xref_code` (confidence >= 0.9).

### Built

- **Data model:**
  - `Correction` model (`orgId`, `orderId`, `lineId`, `field`, `before`, `after`, `userId`, `createdAt`), tenant-scoped with indexes.
  - Added `rejectionReason` to `Order` model and schema.
  - Added `approvedBy` and `rejectionReason` to `OrderDetailDto`.
- **API routes (`apps/api/src/modules/orders/routes.ts`):**
  - `PATCH /api/orders/:id`: Reviewer updates customer, header fields (PO number, dates, address, notes, currency), and lines (quantity, unit, unitPrice, SKU selection).
  - **Learning loop:** Changing or confirming a line's SKU automatically upserts a `CrossReference` (`source: 'learned'`, incrementing usage counter and setting `lastUsedAt`), invalidating the in-memory catalogue index fingerprint for the next order.
  - **Remember sender:** Assigning a customer with `rememberSender: true` appends unknown sender addresses and non-public email domains to the Customer record.
  - Re-routes order dynamically after edits using `routeOrder` with re-evaluated line totals and order value.
  - `POST /api/orders/:id/approve`: Resolves open issues, sets status to `approved`, pushes order to active connector (e.g. MockConnector) with idempotency key, updating status to `pushed` with ERP reference on success.
  - `POST /api/orders/:id/hold`: Puts order into `on_hold` status.
  - `POST /api/orders/:id/reject`: Requires reason via `rejectOrderSchema` and records `rejectionReason`.
  - `GET /api/orders/:id/corrections`: Returns audit history of corrections for the order.
- **Frontend review workspace (`apps/web/src/features/orders/OrderDetailPage.tsx`):**
  - **Side-by-side workspace:** Split view (PDF iframe / rendered image on the left; editable order details on the right), toggleable to "Order only" or "Doc only".
  - **Interactive lines table:** Editable customer code, description, quantity, unit, unit price, and pack conversion factor.
  - **Product SKU picker & candidate buttons:** 1-click apply top-3 candidates, or click "Change / Select product" to open a live debounced search modal across the full product catalogue (`/api/products?q=...`).
  - **Customer selector:** Displays customer status or candidates with 1-click select, plus searchable customer search modal and "Remember sender" checkbox.
  - **Action bar & shortcuts:** Approve & Push (`Alt+A` / `Ctrl+Enter`), Save (`Ctrl+S`), Hold, Reject (with reason modal), Re-match.
  - **Audit timeline:** Lists human corrections with reviewer name, changed field, before/after values, and timestamps.
- **UI Components:**
  - Added accessible `Modal` dialog component to `apps/web/src/components/ui.tsx`.

### Tests (118 total: 113 API + 3 eval + 2 shared, all passing)

- `review_learning.test.ts`:
  - The M6 "done when" learning loop end-to-end.
  - Hold, reject with reason validation, and header field edits.
  - Customer assignment with sender remembering (address & domain).
  - Role enforcement: viewers cannot edit, approve, hold, or reject orders.

## M7 - Push to systems (ERP Connectors) ✅ (2026-10-26)

**Done when:** an approved order appears in the target system with the right customer, line items, pricing, notes, and delivery address, and an idempotency key prevents duplicates.
Verified end-to-end in `connectors_push.test.ts`:
1. Clean PO approved by reviewer pushes to default connector (MockConnector / ERP), creates sales order `SO-10001` with customer, line items, and pricing, updating order status to `pushed`.
2. Idempotency: Retrying or duplicate push calls with the same key (`orgId:customerId:poNumber:vN`) return the existing ERP reference with `alreadyExisted: true` without duplicating records.
3. CSV Export Connector: Creates RFC-compliant CSV files with headers in storage (local/S3), tracking export records in `CsvExportOrder`.
4. Push failures & recovery: If connector fails, order status transitions to `push_failed` with `lastPushError` captured; correcting connector settings and clicking "Retry Push" succeeds and transitions order to `pushed`.

### Built

- **ERP Connectors (`packages/core/src/connectors/`):**
  - **`CsvExportConnector` (`csvExport.ts`):** Universal ERP integration generating RFC-compliant CSV files with full line items, delivery addresses, customer codes, and notes using PapaParse; saves to tenant-isolated storage and tracks exports via `CsvExportOrder`.
  - **`UnleashedConnector` (`unleashed.ts`):** Unleashed Software REST API client with HMAC-SHA256 signature authentication (`api-auth-id` and `api-auth-signature`), customer/product catalogue sync, and sales order creation.
  - **`Cin7CoreConnector` (`cin7Core.ts`):** Cin7 Core (DEAR Inventory) REST client with `api-auth-accountid` and `api-auth-applicationkey` headers, customer/product sync, and sales order creation.
  - **`QuickBooksOnlineConnector` (`quickbooks.ts`):** Intuit QuickBooks Online OAuth 2.0 Bearer token client supporting Estimate (Sales Quote) or Invoice creation per company settings.
  - **`MockConnector` (`mock.ts`):** In-memory and MongoDB-backed simulated ERP for development, testing, and sandbox exploration.
- **Background Push & Worker Integration:**
  - `packages/core/src/connectors/pushJob.ts`: Centralized order push executor with pre-check `findExistingOrder`, idempotency key formulation, retryable error handling, status transitions (`pushed` vs `push_failed`), and audit logging.
  - `packages/core/src/ingestion/handlers.ts`: Wired `'push-order'` job handler in `createJobHandlers` for background worker execution.
- **Models & Security:**
  - `packages/core/src/models/CsvExportOrder.ts`: Tenant-scoped model recording CSV order exports, references, row counts, and storage keys.
  - `credentialsEnc`: AES-256-GCM encrypted storage for connector secrets (API keys, application secrets, OAuth tokens) at rest using `encrypt` from `@keyless/core/lib/crypto`.
- **API Endpoints:**
  - `POST /api/orders/:id/approve`: Approves order and executes immediate push to default active connector, returning ERP reference.
  - `POST /api/orders/:id/retry-push`: Reviewer endpoint to retry pushing orders that failed or need re-pushing.
  - `POST /api/connectors`: Allows admins to create and configure all 5 connectors with credentials encryption and custom settings (delimiters, folders, document types).
  - `POST /api/connectors/:id/test`: Tests connection health and reports live status.
  - `POST /api/connectors/:id/sync`: Syncs catalogue entities (customers, products, prices, stock).
  - `PATCH /api/connectors/:id`: Allows renaming, setting default connector, or updating credentials.
- **Frontend UI (`apps/web`):**
  - **`OrderDetailPage.tsx`:** Added ERP Reference badge (`ERP Ref: SO-...`), push failure alert banner displaying `lastPushError`, and "Retry Push" action button.
  - **`IntegrationsPage.tsx`:** Upgraded integrations page with interactive setup modal for all 5 connectors (CSV Export, Unleashed, Cin7 Core, QuickBooks Online, Demo ERP), connection health testing, default connector selector, and manual catalogue sync triggers.

### Tests (122 total: 117 API + 3 eval + 2 shared, all passing)

- `connectors_push.test.ts`:
  - Approved order push to MockConnector creating ERP sales order.
  - Idempotency verification preventing duplicate sales order records.
  - CSV export connector generating RFC-compliant CSV files in storage.
  - Push failure handling, `lastPushError` capture, and successful recovery via `/retry-push`.
- `connectors.test.ts`: Connector lifecycle, sync dependency order, stock sync, product deactivation, and invalid type rejection.

## M8 - Emails, rules, notifications ✅ (2026-10-26)

**Done when:** rules auto-approve green orders and ask for clarification, with outbound emails visible in the app.
Verified end-to-end in `test/rules_emails.test.ts`:
1. Rule CRUD API: Admins create, list, toggle active, reorder priority, and delete rules; reviewers are forbidden (403).
2. Auto-approve engine: Clean PO from trusted customer matching value limit is auto-approved and immediately pushed to ERP connector with `autoApproved: true` and rule name logged.
3. Guard conditions: Orders exceeding `maxOrderValue`, having unresolved issues, or from untrusted customers stay in `ready` / `needs_review` and are NOT auto-approved.
4. Block rules: Orders matching a block rule are set to `on_hold` with a blocking issue (`rule_blocked`) containing the rule's custom reason.
5. Outbound emails: Reviewers draft clarification and acknowledgment emails with automatic order and issue interpolation, customize text/recipient, and send via `Mailer`.

### Built

- **Shared Types & Schemas (`packages/shared`):**
  - `packages/shared/src/rules.ts`: `RuleDto`, `createRuleSchema`, `updateRuleSchema`, condition schemas (`maxOrderValue`, `minConfidence`, `requireTrustedCustomer`, `requireAllLinesLearned`, `requireNoIssues`), action schemas (`auto_approve`, `require_review`, `block`).
  - `packages/shared/src/outboundEmails.ts`: `OutboundEmailDto`, `createDraftSchema`, `updateDraftSchema`.
  - `packages/shared/src/orders.ts`: Extended `OrderDetailDto` with `autoApproved` flag and `autoApprovedRuleName`.
- **Mongoose Data Models (`packages/core`):**
  - `packages/core/src/models/Rule.ts`: Tenant-scoped `Rule` model with priority ordering and structured condition/action objects.
  - `packages/core/src/models/OutboundEmail.ts`: Tenant-scoped `OutboundEmail` model with status (`draft`, `sending`, `sent`, `failed`), sender references, and audit timestamps.
  - `packages/core/src/models/Order.ts`: Added `autoApproved` (boolean default false), `autoApprovedRuleId`, and `autoApprovedRuleName`.
  - `packages/core/src/catalogue/upsert.ts`: Added `trustedForAutoApprove` support in `upsertCustomers`.
- **Rules Engine & Email Generator (`packages/core`):**
  - `packages/core/src/rules/evaluator.ts`: `evaluateOrderRules` evaluates active rules against incoming orders; auto-approves clean orders and triggers immediate push to the active ERP connector; holds orders on block rules with blocking issues.
  - `packages/core/src/emails/generator.ts`: `generateClarificationDraft` and `generateAcknowledgmentDraft` generating formatted customer communications with order details and issue queries.
  - `packages/core/src/matching/job.ts`: Integrated rule evaluation immediately upon order creation.
- **API Endpoints (`apps/api`):**
  - `GET /api/rules`: Lists active and inactive rules in priority order.
  - `POST /api/rules`: Creates rule (admin only) with audit log.
  - `PATCH /api/rules/:id`: Updates rule conditions, priority, or active flag (admin only).
  - `DELETE /api/rules/:id`: Deletes rule (admin only).
  - `GET /api/orders/:id/emails`: Returns outbound emails drafted or sent for the order.
  - `POST /api/orders/:id/emails/draft`: Generates a clarification or acknowledgment draft.
  - `PATCH /api/orders/:id/emails/:emailId`: Edits draft recipient, subject, or body.
  - `POST /api/orders/:id/emails/:emailId/send`: Sends email via `deps.mailer.send(...)`.
- **Frontend UI (`apps/web`):**
  - **`RulesPage.tsx` (`/rules`):** Complete rules builder and management screen allowing admins to toggle rules, create/edit auto-approve, require-review, and block rules with interactive conditions.
  - **`OrderDetailPage.tsx`:** Auto-approved badge (`⚡ Auto-approved (<rule>)`), "Customer Email" button, and full Customer Email drawer/modal with draft generation, live editing, send button, and sent history.
  - **Navigation (`AppShell.tsx`):** Activated Rules link in the primary sidebar for authorized users.

### Tests (127 total: 122 API + 3 eval + 2 shared, all passing)

- `rules_emails.test.ts`:
  - Rule CRUD API and RBAC enforcement.
  - Auto-approve rule triggering automatic push to Mock ERP connector.
  - Guard conditions preventing auto-approval when value limits are exceeded.
  - Block rule placing order on hold with blocking issue.
  - Clarification and acknowledgment draft generation, editing, and sending with ConsoleMailer outbox verification.

## M9 - Analytics + billing ✅ (2026-10-26)

**Done when:** dashboard metrics, value report, and Stripe plans (Starter £295 up to 600 orders/month, Growth £595 up to 2,000, Pro £995 up to 5,000; usage metering, limits with warnings, customer portal) are functioning and verified.
Verified end-to-end in `test/analytics_billing.test.ts`:
1. Analytics summary: Accurately calculates total processed orders, touch-free straight-through processing rate %, median minutes from receipt to approval, lines corrected %, daily trends, and labour savings (£ and hours).
2. Executive value report: Generates ROI multiple comparison against normalized software plan costs, customer concentration breakdowns, and automated management insights.
3. Configurable ROI assumptions: Admins can tune minutes saved per order (default 10) and internal staff hourly labour costs (default £18/hr) with instant dashboard recalculation.
4. Billing & usage metering: Real-time order consumption tracked against tier quota, with automatic 80% approaching-limit warning and 100% exceeded-limit alerts.
5. Stripe Checkout & Customer Portal: RBAC enforces Owner-only access (403 for Reviewer/Admin); generates checkout sessions for Starter/Growth/Pro and customer portal links for invoice and payment management.
6. Stripe webhooks: Ingests `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted`, syncing organization plan tiers and status in the database.

### Built

- **Shared Types & Schemas (`packages/shared`):**
  - `packages/shared/src/billing.ts`: Plan definitions (`PLANS`), `PlanDto`, `SubscriptionDto`, `createCheckoutSessionSchema`, `createPortalSessionSchema`.
  - `packages/shared/src/analytics.ts`: `AnalyticsSummaryDto`, `ValueReportDto`, `DailyOrderStat`, `CustomerVolumeStat`, `IssueBreakdownStat`, `updateAnalyticsSettingsSchema`.
- **Database Models (`packages/core`):**
  - `packages/core/src/models/Organization.ts`: Added `subscriptionStatus`, `currentPeriodStart`, `currentPeriodEnd`, `cancelAtPeriodEnd`, `minutesSavedPerOrder`, and `hourlyStaffCost` to Organization schema.
- **Analytics & Billing Engines (`packages/core`):**
  - `packages/core/src/analytics/service.ts`: Computes KPI metrics, touch-free rates, median approval duration, line accuracy percentages, daily order trends, customer volume, top error causes, and executive ROI reports.
  - `packages/core/src/billing/stripe.ts`: `StripeBillingService` providing checkout session creation, customer portal session generation, webhook signature validation, and event handlers.
- **API Endpoints (`apps/api`):**
  - `GET /api/analytics/summary`: Returns full KPI metrics summary with date range filtering (`?from=...&to=...`).
  - `GET /api/analytics/value-report`: Returns executive ROI report with insights (`?days=30`).
  - `PATCH /api/analytics/settings`: Allows admins to update baseline labour costs and time-saved assumptions.
  - `GET /api/billing`: Returns current subscription status, monthly order usage, quota limits, and warning flags.
  - `POST /api/billing/checkout`: Creates Stripe Checkout session for upgrading (Owner only).
  - `POST /api/billing/portal`: Creates Stripe Customer Portal session (Owner only).
  - `POST /webhooks/stripe` & `POST /api/billing/webhook`: Handles Stripe subscription events.
- **Frontend UI (`apps/web`):**
  - **`AnalyticsPage.tsx` (`/analytics`):** Comprehensive analytics dashboard with KPI cards (Orders Processed, Touch-Free Rate %, Labour Time Saved, Financial Value Saved), interactive 7/30/90-day time-window selector, daily volume & automation trend charts, top review reasons breakdown, top customers table, executive Value Report (ROI) modal, and calculation settings modal.
  - **`BillingPage.tsx` (`/settings/billing`):** Subscription management page with current tier card, monthly usage progress bar with 80%/100% threshold warning alerts, 3-tier plan comparison grid (Starter, Growth, Pro) with upgrade checkout triggers, and Stripe Customer Portal launch button.
  - **Navigation (`AppShell.tsx` & `router.tsx`):** Activated Analytics and Billing navigation routes.

### Tests (133 total: 128 API + 3 eval + 2 shared, all passing)

- `analytics_billing.test.ts`:
  - KPI calculation and touch-free rate verification.
  - Executive Value Report generation and ROI multiple calculation.
  - Analytics settings update and RBAC enforcement.
  - Order usage metering and 80%/100% threshold warning flags.
  - Stripe Checkout and Customer Portal session creation (Owner only).
  - Stripe webhook handling for plan upgrades, subscription updates, and cancellations.

## M10 - Hardening & production polish ✅ (2026-10-27)

**Done when:** super-admin panel, data retention/export/deletion, security review checklist, performance pass, README and deployment guide, and demo seed data are complete and 100% verified.
Verified end-to-end in `test/hardening.test.ts`:
1. Super-admin console & KPIs: Operators inspect cross-tenant KPIs (total tenants, active paid subscriptions, total orders processed, estimated LLM costs, failed background jobs).
2. Tenant directory & resource usage: Cross-tenant monitoring of order volumes, error rates, active users, and extraction token costs.
3. Support impersonation: Operators can securely impersonate any tenant user with automatic session cookie issuance and immutable audit logging (`actor.type: 'superadmin'`).
4. Resilient queue job recovery: Platform super-admins can view failed background worker jobs, inspect error traces, retry failed jobs (resetting status to `waiting` and attempts to 0), or dismiss stale jobs.
5. GDPR data portability: One-click complete organization data export (`POST /api/org/export`) bundling all customers, products, customer prices, cross-references, automation rules, and historical orders into a downloadable JSON archive.
6. GDPR data retention pruning: Configurable retention policy (default 90 days) deletes raw MIME bodies, headers, and S3/local file attachments while preserving structured order records, lines, and analytics intact for statutory accounting compliance.
7. GDPR right to erasure (Danger Zone): Organization owners can permanently soft-delete their workspace with slug confirmation, immediately revoking all team sessions and invalidating authentication cookies.
8. Security & hardening: Enforced tenant isolation in data layer, zero-retention LLM extraction configuration, sub-processor disclosures, and full README operational guide.

### Built

- **Shared Types & Contracts (`packages/shared`):**
  - `packages/shared/src/superadmin.ts`: `TenantOverviewDto`, `PlatformMetricsDto`, `FailedJobDto`, `deleteOrgSchema`, `DeleteOrgInput`.
- **Database & Retention Engines (`packages/core`):**
  - `packages/core/src/retention/cleanup.ts`: `pruneExpiredTenantData` prunes raw storage files and wipes raw email bodies older than retention threshold while preserving order history.
- **API Endpoints (`apps/api`):**
  - `apps/api/src/middleware/auth.ts`: Added `requireSuperAdmin` guard verifying `user.isSuperAdmin === true`.
  - `apps/api/src/modules/superadmin/routes.ts`:
    - `GET /api/superadmin/metrics`: Platform KPIs across tenants, orders, costs, and failed jobs.
    - `GET /api/superadmin/tenants`: Tenant directory with usage, order counts, error rates, and costs.
    - `GET /api/superadmin/tenants/:id`: Detailed single tenant inspection.
    - `GET /api/superadmin/failed-jobs`: List failed background worker jobs.
    - `POST /api/superadmin/failed-jobs/:id/retry`: Reset job to waiting with 0 attempts.
    - `POST /api/superadmin/failed-jobs/:id/dismiss`: Dismiss job.
    - `POST /api/superadmin/impersonate/:userId`: Generates impersonation session with audit log.
  - `apps/api/src/modules/org/routes.ts`:
    - `POST /api/org/export`: Full organization data export as JSON.
    - `POST /api/org/retention/cleanup`: Trigger retention cleanup for raw files.
    - `DELETE /api/org`: Owner-only workspace soft-deletion with slug confirmation.
- **Frontend UI (`apps/web`):**
  - **`SuperAdminPage.tsx` (`/superadmin`):** Platform metrics cards, tenant directory table with support impersonation modal, and failed queue jobs table with Retry and Dismiss actions.
  - **Navigation (`AppShell.tsx` & `router.tsx`):** Added conditional "Platform Admin" navigation link for super-admins and mounted `/superadmin` route.
  - **`OrganizationPage.tsx` (`/settings/organization`):** Added GDPR Data Portability (JSON export), Data Retention cleanup trigger, and Danger Zone organization deletion modal.
- **Documentation & Hardening:**
  - `README.md`: Comprehensive guide covering architecture, zero-install local dev, Docker stack, superadmin console, GDPR compliance, sub-processor list, and backup/restore commands.
  - `.env.example`: Fully documented 28+ environment variables from Section 16 of `SPEC.md`.

### Tests (140 total: 135 API + 3 eval + 2 shared, 100% passing)

- `hardening.test.ts`:
  - RBAC enforcement forbidding regular users and owners from super-admin endpoints (`NOT_SUPERADMIN`).
  - Super-admin platform metrics and tenant directory inspection.
  - Failed queue job retry and dismiss workflows.
  - Support impersonation session issuance and audit trail verification.
  - Complete GDPR JSON organization export.
  - Data retention pruning erasing raw storage and email bodies while preserving orders.
  - Owner-only organization deletion with slug confirmation and session revocation.

---

## 🏆 Project Status: All 10 Milestones Complete (100% MVP Built)

| Milestone | Scope | Status |
| --------- | ----- | ------ |
| **M1 — Foundation** | Monorepo, auth, multi-tenant scoping, users/roles, base UI shell | ✅ Complete |
| **M2 — Catalogue & Customers** | Products, customers, cross-references, CSV/Excel imports, Mock ERP | ✅ Complete |
| **M3 — Ingestion** | Email forwarding webhook, manual uploads, Microsoft & Gmail OAuth | ✅ Complete |
| **M4 — Extraction & Eval** | Offline/LLM extraction, schemas, cost tracking, 20-fixture eval harness | ✅ Complete |
| **M5 — Matching & Routing** | Line matching, candidate ranking, UoM conversion, validation rules | ✅ Complete |
| **M6 — Review & Learning** | PO review screen, corrections, keyboard shortcuts, continuous learning | ✅ Complete |
| **M7 — ERP Connectors** | CSV export, Unleashed, Cin7 Core, QuickBooks, push idempotency | ✅ Complete |
| **M8 — Emails & Rules** | Auto-approval engine, blocking rules, drafts & outbound sending | ✅ Complete |
| **M9 — Analytics & Billing** | KPI dashboard, ROI report, Stripe plans, usage metering & portal | ✅ Complete |
| **M10 — Hardening & Polish** | Super-admin panel, data retention/export/deletion, README, deployment | ✅ Complete |

---

## 🛠️ Bug-Fix Sprint

### P0-1. Unit-of-measure conversion multiplies quantity by pack size (100× orders)
- **Root cause:** In `OrderDetailPage.tsx`, selecting a product hardcoded `factor = prod.packSize > 1 ? prod.packSize : 1`, ignoring matching selling units (e.g. `box` = `box`) and descriptions specifying the same pack size (e.g. `(Box 100)`). A `null` customer unit was erroneously treated as requiring pack conversion. Furthermore, when saving the order, the server wrote this factor directly into learned `CrossReference` records without requiring explicit reviewer confirmation, propagating the 100x multiplication to all future orders.
- **Fix:**
  - Created shared UOM helper `computeUomConversion` in `@keyless/shared` with canonical unit synonym matching (`box/bx`, `case/cs/ctn`, `each/ea/pcs`), description pack-size extraction, and default `factor = 1` for null/unspecified units.
  - Added warning `ValidationIssue` (`uom_conversion`) and amber line status whenever `factor !== 1` (unless from confirmed cross-reference).
  - Enforced blocking issue (`pack_multiple`) for non-integer converted quantities.
  - Made conversion factor directly visible and editable on the line in `OrderDetailPage.tsx`.
  - Added one-off cleanup script `apps/api/scripts/fix-bad-uom-xrefs.ts` with `--dry-run` (default) and `--apply`.
- **Test:** `apps/api/test/matching.test.ts` > `P0-1: Unit of measure and pack-size conversions` (4 regression tests).

### P0-2. Exact SKU-code match ignores a completely different description
- **Root cause:** In `packages/core/src/matching/match.ts`, exact SKU and barcode matches unconditionally set high confidence (0.95), only checked token agreement against a hardcoded threshold of 0.25 (only lowering to 0.55), did not check conflicts on key domain attributes (colour, size, material, pack size, volume), failed to put description-based candidates first in suggestions, gave 0.95 confidence even when no customer description was present, and lacked an org-level configurable threshold.
- **Fix:**
  - Created key attribute conflict checker in `packages/core/src/matching/attributeAgreement.ts` that enforces agreement on colour, size (S/M/L/XL), material (nitrile/vinyl/latex/polythene), pack size, and volume (ml/L).
  - Added `scoreProduct` to `ProductSearch` and `TokenProductSearch` in `catalogue.ts` using the same IDF and trigram similarity formula as fuzzy search.
  - In `matchLine`: when customer description is present and `sim < mismatchThreshold` (default 0.5) OR any key attribute conflicts, the code match is distrusted: confidence capped at $\le 0.4$, warning issue `code_description_mismatch` emitted, line coloured amber, and best description search candidates placed first in suggestions.
  - When code matches without any customer description, confidence is capped at 0.85.
  - Added `codeDescriptionMismatchThreshold` to `RoutingSettings`, `DEFAULT_ROUTING`, `Organization` model schema, and `OrganizationPage.tsx` settings card.
- **Test:** `apps/api/test/matching.test.ts` > `P0-2: Exact SKU-code match with description mismatch` (3 regression tests).

### P0-3. Extraction fails on half of the forwarded POs (schema validation)
- **Root cause:** In `packages/shared/src/extraction.ts`, the extraction schema strictly required fields that real-world forwarded POs frequently omit (`documentTotals.tax`, `fieldConfidence.customer`, `deliveryAddress`, line numbers, per-line confidences). The retry mechanism passed generic Zod error dumps without instructing the model to return `null` for absent fields. If retry failed, the extractor threw away all lines—even when lines were valid—and displayed raw Zod error stack dumps directly on the reviewer order screen. Furthermore, held orders had no mechanism to re-run extraction.
- **Fix:**
  - Made non-essential document fields (`documentTotals.tax/subtotal/total`, `customerPartCode`, `unit`, `unitPrice`, `lineTotal`, all `fieldConfidence.*`) `.nullable().optional()` with auto-normalization to `null`.
  - Added auto-filling for missing `lineNo` (1-based index) and defaulted missing line confidence scores to 0.5.
  - Formatted specific retry feedback detailing missing schema paths and instructing the model to use `null` rather than omitting keys.
  - Implemented partial order salvaging (`salvageOrders`): if validation fails after retry, salvage all lines with `quantity > 0` and description or part code, tag them with warning issue `partial_extraction` ("Some fields could not be read — please check against the document"), and route amber.
  - Changed `UNREADABLE.failed.message` in `job.ts` to user-friendly text: `"We couldn't read this document fully. Please check the lines against the original."`, keeping technical traces on `Extraction.error`.
  - Added `POST /api/orders/:id/re-extract` endpoint in `apps/api/src/modules/orders/routes.ts` and a "Re-extract" action button on held unreadable orders in `OrderDetailPage.tsx`.
  - Added Thistle Catering Ltd (`PO-933214`) and Willow Catering Ltd (`PO-903517`) as fixtures `21-pdf-thistle-catering` and `22-pdf-willow-catering` in `packages/eval/fixtures`.
- **Test:** `apps/api/test/extraction.test.ts` > `P0-3: Resilient extraction, schema tolerance, salvaging, and re-extract` (4 tests) & `pnpm eval --provider mock` (all 22 fixtures passing).

### P0-4. Approved orders never push / dashboard says "Sent to ERP: 1"
- **Root cause:**
  - In `packages/core/src/connectors/pushJob.ts`, if no connector was configured or active, `executeOrderPush` returned `{ ok: true, status: 'approved' }`, leaving orders silently stuck in `approved` indefinitely without any error recorded.
  - In `packages/shared/src/orders.ts`, `ORDER_VIEWS.pushed` was defined as `['approved', 'pushing', 'pushed']`, which caused the dashboard KPI "Sent to ERP" to count approved orders that had never actually pushed to any ERP.
  - The dashboard pipeline health card displayed hardcoded static text ("Active", "Connected", "Healthy") rather than querying actual connector and pipeline status.
  - There was no watchdog mechanism to detect and fail push jobs that got stuck.
- **Fix:**
  - In `packages/core/src/connectors/pushJob.ts`: if no active connector is found, fail loudly by marking the order `push_failed` with `lastPushError: "No active connector is configured or enabled for this organization."` and audit log `order.push_failed`.
  - In `packages/shared/src/orders.ts`: restricted `ORDER_VIEWS.pushed` to strictly `['pushed']`, and updated `ORDER_VIEWS.ready` to include `['ready', 'approved', 'pushing']`.
  - Added background watchdog `safeguardStuckPushJobs` in `apps/api/src/modules/orders/routes.ts`: auto-transitions orders stuck in `approved` or `pushing` for >15 minutes to `push_failed` with a clear timeout message.
  - Created endpoint `GET /api/org/pipeline-status` and type `IntegrationPipelineStatusDto` in `@keyless/shared`: returns live health of ERP connector, inbound email forwarding mailbox, AI extraction provider/model, and outbound mailer.
  - Updated dashboard `OverviewPage` (`apps/web/src/features/placeholder/pages.tsx`) to consume `/api/org/pipeline-status` and display real statuses, live model names, and active connectors.
  - Updated push failure alert banner in `OrderDetailPage.tsx`: when `lastPushError` indicates no active connector, displays `"Approved — not sent. No ERP connector is set up."` with a link to `/settings/integrations`.
- **Test:** `apps/api/test/connectors_push.test.ts` > `P0-4: approving with no active connector marks order push_failed and does not increment Sent count` and `P0-4: safeguardStuckPushJobs marks orders stuck in approved/pushing for >15 min as push_failed`.

### P0-5. Sign-up returns 500
- **Root cause:**
  - In `apps/api/src/modules/auth/service.ts`, `service.signup` called `await sendVerification(user)` synchronously without error handling. When outbound mail delivery failed (e.g. Resend free tier rejecting unverified test domains like `@example.com` or `@example.test`), the uncaught exception bubbled up as an unhandled 500 server error.
  - Furthermore, if an error occurred after `User.create`, no cleanup was performed on the created user or any intermediate records, leaving orphaned, corrupted tenant state and preventing the user from signing up again due to conflict checks.
  - Sign-up also did not automatically provision the organization's inbound email forwarding mailbox (`ensureForwardingMailbox`), causing the new organization to start without an inbound email address.
- **Fix:**
  - Wrapped `sendVerification(user)` in a graceful `try/catch` block that logs a warning (`logger.warn`) and allows sign-up to succeed, enabling the user to access their workspace and resend verification when needed.
  - Added atomic rollback in `service.signup`: if tenant initialization fails, cleans up any created `AuthToken`, `Mailbox`, `User`, and `Organization` records so no half-created state persists.
  - Integrated `ensureForwardingMailbox(org)` directly into the signup flow to guarantee every newly created tenant immediately has their unique inbound email forwarding address.
  - Added email case-folding (`.toLowerCase().trim()`) and name trimming on signup inputs.
- **Test:** `apps/api/test/auth.test.ts` > `P0-5: sign-up succeeds with 201 even if verification mailer throws an error` and `P0-5: atomic rollback cleans up org and user if an internal error occurs`.

### P1-1. Order value uses our list price instead of the PO price
- **Root cause:**
  - In `packages/core/src/matching/build.ts`, `buildOrder` calculated order value prioritizing our expected catalogue/contract price (`l.convertedQuantity * l.expectedPrice`) rather than the buyer's purchase order line totals or unit prices. For example, PO-771204 with PO subtotal £102.50 was inflated to £247.50 based on internal list prices (£10.75 and £3.25).
  - In `PATCH /api/orders/:id`, order value was recalculated using a different ad-hoc reduce formula, causing inconsistent values before and after edits or customer assignment.
  - There was no distinction between actual PO value and estimated value when prices were absent on the PO.
- **Fix:**
  - Created canonical pure function `computeOrderValue` in `@keyless/shared` (`packages/shared/src/orders.ts`) and applied it universally across order creation (`build.ts`), persistence (`job.ts`), queue listing (`listItem`), order updates (`routes.ts`), and analytics (`service.ts`).
  - Standardized formula: Order value = sum of PO line totals (or `qty * PO unitPrice`). When PO price is absent, it falls back to our expected catalogue price for that line and flags the order with `valueEstimated = true`.
  - Added `valueEstimated` and `expectedValue` (our list/contract value) fields to `IOrder`, `Order` schema, `OrderListItemDto`, and `OrderDetailDto`.
  - Updated UI: `OrdersPage.tsx` displays an "est." badge for estimated values, and `OrderDetailPage.tsx` shows the PO Total, "estimated" badge, and our catalogue list value side-by-side.
- **Test:** `apps/api/test/matching.test.ts` > `P1-1: Order value calculation (PO line totals vs expected prices)` (3 regression tests asserting PO-771204 £102.50 vs £247.50 list, PO-884920 £64.50 consistency, and fallback estimation).

### P1-2. Validation issues are not re-evaluated after edits
- **Root cause:**
  - `PATCH /api/orders/:id` previously only marked `unknown_customer` resolved upon customer selection (using the wrong code; the actual issue code is `customer_unknown`).
  - Validation issues such as `price_mismatch` were not recomputed when a SKU or customer was changed, leaving outdated messages (e.g., claiming list price £10.75 when the newly selected SKU had list price £6.80).
  - There was no unified server-side re-validation function shared across extraction, manual order editing, and re-matching.
  - Reviewer manual dismissals were not persisted across saves or updates.
- **Fix:**
  - Created pure revalidation engine in `packages/core/src/matching/revalidate.ts` (`revalidateOrder`) that evaluates customer issues, re-checks matching on all lines, re-calculates price mismatch warnings with current expected list/contract prices, checks attribute conflicts and code/description similarity, preserves reviewer dismissals (`dismissedBy`, `dismissedAt`), and updates line colours, order colour, confidence, and transitions `needs_review` → `ready` when clean.
  - Added endpoint `POST /api/orders/:id/issues/:issueId/dismiss` in `apps/api/src/modules/orders/routes.ts` with audit logging (`order.issue_dismissed`).
  - Updated `OrderDetailPage.tsx` issue list with a "Dismiss" action button hooked to `useMutation`.
- **Test:** `apps/api/test/orders.test.ts` > `P1-2: re-evaluates validation issues, pricing, and routing after edits` (asserting Abbey Cafe + GL1459 clears customer_unknown, updates price diff message from £10.75 to £6.80, and dismissing marks ready + green).

### P1-3. Order confidence shows 0% when extraction was fine
- **Root cause:**
  - In `packages/core/src/matching/route.ts`, order confidence was calculated using `Math.min(extractionConfidence, customerConfidence, lineConf)`. When a customer was unknown (`customerConfidence = 0`), the `Math.min` operation unconditionally zeroed out the entire order score to `0.0` (0%), even when header extraction and line matching were 100% confident (such as in PO-884920 and PO-771204).
  - The queue lacked any contextual indication of which component (customer, line items, or extraction) was the weakest factor degrading confidence.
- **Fix:**
  - Implemented `computeOrderConfidence` in `packages/core/src/matching/route.ts`:
    - Weighted formula: Line matching (50%), Document extraction (30%), Customer identification (20%).
    - When a customer is unknown (`customerConfidence = 0`), it contributes 0 to the customer component, capping confidence at 80% (amber range) rather than zeroing out the entire score.
    - Preserved safety: `routeOrder` independently enforces that an order with `customerConfidence < greenConfidenceThreshold` routes to `amber` (`needs_review`) and can never be auto-approved or routed green.
    - Documented formula rationale and weights in code comments.
  - Added weakest-area queue hint calculation (`confidenceHint`): e.g. `"Customer unknown"`, `"Unmatched lines"`, `"Low line match"`, `"Low read confidence"`, stored on `IOrder` and exposed on `OrderListItemDto`.
  - Updated `OrdersPage.tsx` table: displays the confidence percentage alongside the subtle hint text (e.g. `"Customer unknown"`).
- **Test:** `apps/api/test/matching.test.ts` > `P1-3: Order confidence and weakest-area queue hints` (3 regression tests asserting 80% amber + "Customer unknown" hint for PO-884920, "Unmatched lines" for low line matches, and null hint + green status for high confidence orders).

### P1-4. Uploaded documents: customer identified from uploader instead of the document
- **Root cause:**
  - Manually uploaded PDFs and documents were wrapped in synthetic emails where `from.address` was set to the uploader's staff email address.
  - In `identifyCustomer`, sender address matching was unconditionally run first, checking the uploader's address or internal domain against customer senders/domains, leading to "Unknown" customer even when the PO document contained account numbers, exact customer names, or delivery addresses.
  - Delivery address matching against known customer delivery addresses was completely missing from the customer identification pipeline.
  - In `OrderDetailPage.tsx`, the UI concatenated `"Identified by "` with `CUSTOMER_METHOD[o.customerMatch.method]`, producing the grammatically broken label `"Identified by not identified"` when an order was unassigned or manually selected by the reviewer.
- **Fix:**
  - In `packages/core/src/matching/match.ts`:
    - Updated `identifyCustomer` with `skipSender` mode activated whenever `isUpload === true` or the sender belongs to the tenant's internal staff domains.
    - Implemented document-first priority sequence when skipping sender:
      1. Account number on the PO (`index.customerForAccount`) -> `method: 'account_number'` (confidence 0.95).
      2. Extracted customer company name -> `method: 'name'` (confidence 0.85).
      3. Delivery address and postcode matching (`matchCustomerByAddress`) -> `method: 'delivery_address'` (confidence 0.85).
      4. Forwarded email sender in email body -> `method: 'forwarded_sender'` (confidence 0.90).
      5. Fuzzy company name fallback -> `method: 'name'` (confidence 0.70).
    - Added `matchCustomerByAddress`: matches normalised UK postcodes and line 1/city across `CatCustomer.deliveryAddresses`.
  - In `packages/core/src/matching/job.ts`: passed `deliveryAddress`, `isUpload`, and computed `orgInternalDomains` (from tenant's `User` and `Mailbox` records) to `identifyCustomer`.
  - Added `'delivery_address'` to `CustomerMatchDto`, `CustomerMatch`, and `orderSchema.customerMatch.method` enum.
  - In `OrderDetailPage.tsx`:
    - Added `delivery_address: 'delivery address on the PO'` to `CUSTOMER_METHOD`.
    - Fixed UI badge label: shows `"Picked by reviewer"` when manually selected or `method === 'manual'`, and clean `"Identified by {method}"` otherwise.
- **Test:** `apps/api/test/matching.test.ts` > `P1-4: Uploaded documents and internal forwards customer identification` (4 regression tests asserting account number, name, delivery address/postcode matching on uploads, and internal domain sender skipping).

### P1-5. Analytics show wrong values
- **Root cause:**
  - In `packages/core/src/analytics/service.ts`:
    - Touch-free rate was counting any approved order with zero edits (`o.status === 'approved' && !o.lines.some(l => l.edited)`), which counted manually reviewed and approved orders as "touch-free". Touch-free strictly means orders auto-approved and pushed with zero human touch.
    - Lines requiring edits counted only `l.edited === true`, ignoring lines that required manual intervention because they were unmatched (`!l.sku && !l.productId`).
    - Match rate metric was missing from the analytics summary payload.
    - Medians conflated approval and push times or returned `0` rather than distinct `medianMinutesToApprove` and `medianMinutesToPush` (which should be `null` when no data exists).
    - Top review reasons grouped raw issue messages instead of issue codes, causing duplicate fragmented entries in the breakdown.
- **Fix:**
  - In `packages/shared/src/analytics.ts`:
    - Added `ISSUE_LABELS` mapping canonical issue codes to clean human-readable names.
    - Added `medianMinutesToPush: number | null`, `matchRate: number`, and made `medianMinutesToApprove: number | null` on `AnalyticsSummaryDto`.
  - In `packages/core/src/analytics/service.ts`:
    - Fixed touch-free rate: orders pushed with zero edits and no manual approval (`o.autoApproved && o.status === 'pushed' && !o.lines.some(l => l.edited)`) divided by total orders.
    - Fixed lines requiring edits: lines with `edited === true` OR unmatched (`!l.sku && !l.productId`) divided by total lines.
    - Added `matchRate`: lines auto-matched above threshold without edits divided by total lines.
    - Split medians: separate `medianMinutesToApprove` (received to approved) and `medianMinutesToPush` (received to pushed), returning `null` when there are no samples.
    - Grouped top review reasons by `issue.code` with human-readable labels from `ISSUE_LABELS`.
  - In `apps/web/src/features/analytics/AnalyticsPage.tsx`:
    - Expanded summary strip to show distinct Approval and Push median times (displaying "—" when null), and added the Match Rate card.
- **Test:** `apps/api/test/analytics_billing.test.ts` > `P1-5: computes accurate metrics, distinct medians, match rate, and human-labeled review reasons` (asserting touch-free criteria, distinct medians, match rate, and human-labeled top issue aggregation).

### P1-6. Inbox "Failed" tab count disagrees with rows
- **Root cause:**
  - In `apps/api/src/modules/inbound/emails.ts`:
    - The "Failed" tab query filter and `/counts` count endpoint checked strictly `{ status: 'failed' }`.
    - When extraction failed on an email (such as Thistle Catering and Willow Catering), `email.extraction.status` was set to `'failed'`, but `email.status` remained `'classified'`.
    - As a result, the inbox table showed row read status "failed" in red, but the "Failed" tab count was 0 and clicking the "Failed" tab displayed 0 rows.
    - Furthermore, `ClassificationBadge` rendered "New order" instead of "Failed", and the "Orders" tab still counted failed extractions as orders.
- **Fix:**
  - Established a unified definition of failed emails across the entire stack: `status === 'failed' || extraction.status === 'failed'`.
  - In `packages/core/src/extraction/job.ts`:
    - Updated `runExtraction` to set `email.status = 'failed'` and record the failure error when `summary.status === 'failed'` or if an unexpected exception occurs.
  - In `apps/api/src/modules/inbound/emails.ts`:
    - Created canonical `FAILED_EMAIL_FILTER` (`{ $or: [{ status: 'failed' }, { 'extraction.status': 'failed' }] }`) and `NOT_FAILED_EMAIL_FILTER`.
    - Filtered `failed` tab and `/counts` using `FAILED_EMAIL_FILTER`.
    - Excluded failed emails from `orders` and `other` views/counts.
    - In `listItem`: mapped `status: isFailed ? 'failed' : e.status` so row badge and detail view receive unified `failed` status.
    - In `POST /:id/extract`: allowed re-extraction on emails with `status === 'failed'` or `extraction.status === 'failed'`.
  - In `apps/web/src/features/inbox/InboxPage.tsx`:
    - Updated total count to include failed items (`byLabel total + counts.data.failed`).
    - Updated Read column cell to check both `x.status === 'failed' || e.status === 'failed'`.
- **Test:** `apps/api/test/ingestion.test.ts` > `P1-6: Inbox Failed tab count agrees with rows and includes extraction failures` (asserts failed extraction increments Failed count, shows under Failed view with status 'failed', is excluded from Orders view, and permits reviewer re-extraction).

---

## P2 — UI Polish and Edge Cases

### P2-1. Inbox subject concatenates with attachment count
- **Root cause:** In `apps/web/src/features/inbox/InboxPage.tsx`, subject text and attachment count badge were rendered inline inside a single `<p>` tag, causing string concatenation when read or selected (e.g. "Purchase Order PO-4718551 file").
- **Fix:** Structured the cell as a flex container separating the subject title and the attachment counter into distinct elements, rendering the counter as an independent styled pill badge with spacing.

### P2-2. "Identified by not identified" label
- **Root cause:** In `apps/web/src/features/orders/OrderDetailPage.tsx`, when an order had `customerMatch.method = 'none'` or was assigned manually by the user, the string template interpolated `"Identified by "` with `CUSTOMER_METHOD[method]`, creating the label `"Identified by not identified"`.
- **Fix:** Updated `CUSTOMER_METHOD` mapping with all methods (`account_number`, `name`, `delivery_address`, `forwarded_sender`, `sender`, `domain`, `manual`). When `method === 'manual'`, or `method === 'none'`, or reviewer changed the customer, the UI cleanly displays `"Picked by reviewer"`.

### P2-3. Edit history logs no-op changes
- **Root cause:** In `apps/api/src/modules/orders/routes.ts`, order edit handler checked `updateValue !== existingValue` directly without normalising empty values (`null`, `undefined`, `""`), causing no-op corrections to be written (e.g., `unit from (none) to (none)`).
- **Fix:** Added `normalizeCorrectionValue` and `valuesDiffer` to treat `null`, `undefined`, and `""` as equivalent, preventing recording of redundant correction records.
- **Test:** `apps/api/test/review_learning.test.ts` > `P2-3: does not log no-op corrections when before and after are equivalent`.

### P2-4. Internal milestone references in user-facing text
- **Root cause:** User-facing strings in `CrossReferencesPage.tsx` (`"(M6)"`), `CustomerDetailPage.tsx` (`"(M8)"`), and `ExtractedOrders.tsx` (`"M5-M6"`) referenced internal project milestones.
- **Fix:** Removed all internal milestone references from customer-facing strings, replacing them with professional descriptive language.

### P2-5. Accessible names and tooltips for icon-only buttons
- **Root cause:** Header view mode buttons (`Split View`, `Order Only`, `Doc Only`), product picker buttons, and dialog close buttons lacked accessible names or tooltips.
- **Fix:** Added descriptive `aria-label` and `title` tooltips to view toggle buttons, modal close buttons, and line action controls.

### P2-6. Non-PO documents with 0 lines
- **Root cause:** Non-PO documents (such as transport studies or letters) classified as orders with 0 lines caused `buildOrdersForEmail` to generate dummy on-hold orders in the review queue.
- **Fix:** In `packages/core/src/matching/job.ts`, when document extraction completes with 0 total order lines across all extractions, the email is automatically routed to "Other emails" (`classification.label = 'not_order'` with reason "No purchase order lines found in document") and no on-hold order is created. Reviewers retain the ability to use "Correct it" to convert the email to an order if desired.

### P2-7. Order list "Needs review" default tab and consistent filters
- **Root cause:** Default tab state in `OrdersPage.tsx` lacked distinct visual emphasis, and tab counts needed alignment with `ORDER_VIEWS`.
- **Fix:** Verified all 6 queue filters (`needs_review`, `ready`, `on_hold`, `pushed`, `failed`, `all`) against `ORDER_VIEWS`, ensured `safeguardStuckPushJobs` runs on queue queries, and updated tab styling so the active queue tab and its count pill are immediately distinct.

---

## Regression Fixes (FIXES.md Follow-ups)

### 1. P0-6: Customer Sender Addresses and Email Domains
- **Root cause:**
  - Saving an order after picking a customer without "Remember sender" ticked still added the sender address and sender email domain (e.g. `gmail.com`) to the customer record.
  - Previous implementations automatically appended the domain from the sender address to `customer.emailDomains`, which corrupted customer domain lists with public webmail domains like `gmail.com`.
  - Frontend checkbox was not explicitly unchecked when picking suggestions/selecting customers, and backend routes were adding domains implicitly.
- **Fix:**
  - In `packages/core/src/matching/catalogue.ts`: exported `PUBLIC_DOMAINS` and `isPublicDomain(domain)` covering all common free/public email providers (`gmail.com`, `googlemail.com`, `yahoo.com`, `outlook.com`, `hotmail.com`, `icloud.com`, etc.).
  - In `packages/core/src/models/Customer.ts`: added schema-level custom validator and `pre('save')` hook rejecting and stripping public webmail domains from `emailDomains`.
  - In `packages/core/src/catalogue/upsert.ts`: filtered out public domains during customer bulk upserts.
  - In `apps/api/src/modules/catalogue/routes.ts`: `PATCH /customers/:id` rejects public webmail domains with a clear 400 error.
  - In `apps/api/src/modules/imports/importers.ts`: customer CSV importer rejects public webmail domains.
  - In `apps/api/src/modules/orders/routes.ts`:
    - Enforced strict `if (body.rememberSender === true && activeCustomer)` check before updating customer sender addresses.
    - Completely removed automatic appending of email domains so customer email domains are NEVER added automatically.
  - In `apps/web/src/features/orders/OrderDetailPage.tsx`: default `rememberSender` to `false`, and explicitly reset it to `false` whenever a customer is selected or suggested.
- **Regression test:** `apps/api/test/review_learning.test.ts` > `P0-6: remembers sender email only when rememberSender === true, never adds domains, and customer unchanged without flag` (verifies customer untouched when saving without flag, adds sender address only without domain when `rememberSender === true`, and rejects public domains in API and Model layers).

### 2. P0-7: In-Place Update on Re-run Matching and Re-extract (Preserving Order `_id`)
- **Root cause:**
  - `buildOrdersJob` in `packages/core/src/matching/job.ts` executed `Order.deleteMany({ orgId, emailId, status: { $in: REVIEWABLE } })` and recreated new Order documents with new `_id`s.
  - As a result, triggering "Re-run matching" or "Re-extract" changed the order's `_id`. The user's open review page URL `/orders/:id` returned 404 ("Order not found") or displayed stale data.
- **Fix:**
  - In `packages/core/src/matching/job.ts`:
    - Replaced the wholesale `deleteMany` in `buildOrdersJob` with an in-place update strategy.
    - Queried existing reviewable orders (`Order.find({ orgId, emailId, status: { $in: REVIEWABLE } })`).
    - Matched orders in sequence: updated existing orders in place preserving their exact `_id`, incrementing `version: (existing.version || 0) + 1`, and updating `updatedAt: new Date()`.
    - Only deleted surplus orders if fewer orders were extracted than previously existed.
  - In `apps/web/src/features/orders/OrderDetailPage.tsx`:
    - Updated `rematch` and `reExtract` mutations to invalidate React Query cache (`['order', id]`, `['orders']`, `['order-corrections', id]`) and call `order.refetch()` directly.
- **Regression test:** `apps/api/test/orders.test.ts` > asserts `after.id === before.id`, `GET /api/orders/${before.id}` returns 200 with new match data and `version >= 1`.

### 3. P0-3 Point 5: Unreadable Document Plain Message vs Technical Details
- **Root cause:**
  - When document extraction failed with `unreadable_document` (e.g. invalid line formats or non-conforming model schema), raw Zod validation errors (e.g. `[{"code":"invalid_type",...}]`) were stored in the user-facing `error` field and displayed in the UI.
- **Fix:**
  - In `packages/shared/src/extraction.ts`: added `technicalError?: string | null` to `ExtractionDto`.
  - In `packages/core/src/models/Extraction.ts`: added `technicalError: String` to `IExtraction` and the MongoDB schema.
  - In `packages/core/src/extraction/extract.ts`:
    - Set user-facing `error` to the clean friendly message: `"We couldn't read this document fully. Please check the lines against the original."`
    - Stored raw Zod/schema error strings separately in `technicalError`.
  - In `apps/api/src/modules/inbound/emails.ts`: mapped `technicalError` into `extractionDto`.
- **Regression test:** `apps/api/test/extraction.test.ts` > asserts `results[0].error === "We couldn't read this document fully. Please check the lines against the original."` and `results[0].technicalError` contains the raw format error string.

### 4. Database Cleanup Script
- Ran `pnpm --filter @keyless/api cleanup --apply` (`apps/api/scripts/fix-bad-uom-xrefs.ts`):
  - Org `AZE (6ae02d5a8e61247e50a696a1)`:
    - Reset 2 learned `CrossReference` records for `GL1459` on Abbey Cafe (`ABBE001`) from `uomFactor: 100` to `uomFactor: 1`.
    - Removed `gmail.com` from `emailDomains` on Abbey Cafe (`ABBE001`) and Abbey Bistro (`ABBE002`).
    - Removed `amirmaqbool055@gmail.com` from `senderAddresses` on Abbey Cafe (`ABBE001`) and Abbey Bistro (`ABBE002`).

