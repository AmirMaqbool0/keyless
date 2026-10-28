<USER_REQUEST>
# Keyless — Bug-Fix Sprint (prompt for Antigravity)

> Paste this whole file into Antigravity as one task, or save it in the repo root as `FIXES.md` and tell the agent: "Read FIXES.md and fix every issue in order. Do not add new features."

---

## 0. Context and rules for you (the agent)

You are working on **Keyless**, a multi-tenant SaaS that reads purchase-order emails for wholesale distributors, extracts line items with an LLM, matches them to the distributor's SKUs, validates them, and pushes approved orders to an ERP.

- Repo: `D:\AMIR 2.o\sales-order-processor` — a pnpm monorepo with `apps/api`, `apps/worker`, `apps/web`, `packages/shared` (Zod schemas/types) and `packages/eval`.
- Stack: Node + TypeScript (strict), Express/Fastify, MongoDB/Mongoose, BullMQ + Redis, React + Vite + Tailwind + TanStack Query.
- The web app runs at `http://localhost:5173` and proxies `/api` to the API.

A manual QA pass found the bugs below. The evidence (order IDs, values, API responses) is real, taken from the local dev database.

**Working rules:**

1. **Fix bugs only. Do not add new features, pages, connectors or refactors** beyond what each fix needs.
2. Work through the issues **in the order given** (P0 first). After each issue: run typecheck, lint and tests, and make sure everything passes before moving on.
3. **Before changing code for an issue, find the root cause** by reading the relevant code. The "likely cause" notes below are hypotheses from black-box testing, not facts — confirm or correct them, and briefly state the real cause in `PROGRESS.md`.
4. **Every fix needs a regression test** (unit or integration) that fails before the fix and passes after. Use the exact scenario from the evidence.
5. Never silently swallow errors. Log with context (orgId, orderId, jobId) via the existing logger.
6. Keep tenant isolation intact: every query stays scoped by `orgId`.
7. At the end, update `PROGRESS.md` with a "Bug-fix sprint" section: issue → root cause → fix → test name.
8. If something is genuinely ambiguous, pick the safest behaviour (the one that prevents a wrong order reaching the ERP) and note the decision in `PROGRESS.md`.

**The guiding principle for every decision:** a wrong order reaching the distributor's ERP (wrong product, wrong quantity) is far worse than an order that needs human review. When unsure, lower confidence and route to review.

---

## P0 — Critical (can cause wrong orders or broken trust)

### P0-1. Unit-of-measure conversion multiplies quantity by pack size (100× orders)

**Evidence:** Order `6ae0a4b7f4135e71641be756` (PO-884920), line 1. Customer ordered **10** of "Nitrile Gloves Powder Free Blue Medium (Box 100)". Reviewer changed the matched SKU to `GL1459` "Caterpak Nitrile Gloves Powder Free Blue Medium (Box 100)" (unit `BOX`, pack 100). After saving: `convertedQuantity = 1000`, `conversionFactor = 100`, UI shows "Our qty 1000 box ×100". Correct result: **10 boxes, factor 1.** The wrong factor 100 was then saved into two learned CrossReference records (`uomFactor: 100`), so every future order from this customer for this item would also be 100×.

**Likely cause:** when the SKU changes, conversion uses the product's pack size as the factor, without checking that the customer's unit is already the same selling unit (box = box). Or the extracted `unit` is `null`, and null is treated as "each".

**Required behaviour:**
- Define conversion explicitly: `ourQty = customerQty × factor`, where `factor` = how many of **our selling units** one **customer unit** equals.
- If the customer's unit matches our unit of measure (case-insensitive, with synonyms: box/bx, case/cs/ctn/carton, each/ea/pc/pcs/unit), factor = 1.
- If the customer's description contains the same pack size as our product (e.g. both "(Box 100)"), factor = 1.
- If the customer unit is `null`/unknown: **default factor = 1** and do not multiply by pack size. Only apply pack-size conversion when there is positive evidence the customer ordered in "each" (e.g. unit says each/pcs, or quantity is an exact multiple of pack size and much larger than typical).
- Any factor ≠ 1 that was not taken from an existing CrossReference must create a **warning** ValidationIssue ("Quantity converted from X customer units to Y of our units — please confirm") and make the line amber.
- Reviewer must be able to see and edit the factor on the line; the edited factor is what gets learned.
- Never write a factor into a learned CrossReference unless the reviewer saw it (i.e. it is part of the saved line they confirmed).

**Tests:**
- 10 × "(Box 100)" matched to a Box 100 SKU, unit null → ourQty 10, factor 1, no conversion warning.
- 10 "boxes" matched to a SKU sold "each" with pack 100 → ourQty 1000, factor 100, conversion warning present.
- 500 "each" matched to a Box 100 SKU → ourQty 5, factor 0.01 (or the code's equivalent), warning present; non-integer result → blocking issue.
- Learned CrossReference stores the factor the reviewer saved, not a computed default.

**Data cleanup:** write a one-off script (`apps/api/scripts/fix-bad-uom-xrefs.ts`) that lists learned CrossReferences where `uomFactor ≠ 1` and the customer description and our product description contain the same pack size, and resets them to 1. Run it in dry-run mode by default; apply with `--apply`. (In the local DB, Abbey Cafe has two such records for SKU `GL1459`.)

---

### P0-2. Exact SKU-code match ignores a completely different description

**Evidence:** Same order, line 1: customer part code `GL1001`, description "Nitrile Gloves Powder Free Blue Medium (Box 100)". Our SKU `GL1001` is "ProClean Polythene Gloves Powder Free Black Large (Box 200)". The matcher returned method `sku`, confidence **0.95**, and picked the wrong product. Better candidates `GL1459`/`GL1697` (score 0.769) were only suggestions. The same happened on order `PO-771204`.

**Required behaviour:**
- When a line matches by exact SKU or barcode (matching step 3 — customer is using our code), also compute description similarity between the customer description and our product description, using the same similarity function as fuzzy search.
- If there is a customer description and similarity is below a configurable threshold (default 0.5), **do not trust the code match**:
  - confidence ≤ 0.4, line colour amber,
  - add a warning ValidationIssue: `code_description_mismatch` — "Code GL1001 matches our product 'ProClean Polythene Gloves…' but the description says 'Nitrile Gloves…Blue Medium'. Please confirm.",
  - put the best description-based candidates first in the suggestions list.
- Key attributes that must agree when present in both texts: colour, size (S/M/L/XL), material (nitrile/vinyl/latex/polythene), pack size, volume (ml/L). A conflict on any of them counts as a mismatch even if overall similarity is high.
- CrossReference hits (steps 1–2) stay trusted, because a human confirmed them.
- Make the threshold an org setting with a sensible default (add it to the existing thresholds settings; no new page).

**Tests:**
- Code GL1001 + "Nitrile Gloves Blue Medium" vs catalogue GL1001 "Polythene Gloves Black Large" → amber, confidence ≤ 0.4, `code_description_mismatch` issue.
- Code CH1825 + "Hygenix Thick Bleach 750ml Original (Case 2)" vs identical catalogue description → green, confidence ≥ 0.95, no issue (this is order PO-471855, which must keep working).
- Code match with no customer description at all → keep current behaviour but cap confidence at 0.85.

---

### P0-3. Extraction fails on half of the forwarded POs (schema validation)

**Evidence:** Orders for Thistle Catering Ltd and Willow Catering Ltd (received 27/10 17:31) are `on_hold` with issue `unreadable_document`: "The model's answer did not match the expected format twice". The Zod errors show the model omitted: `documentTotals.tax`, `fieldConfidence.customer`, `fieldConfidence.deliveryAddress`, and for every line `lineNo`, `customerPartCode`, `confidence`. Two out of four similar forwarded POs failed this way.

**Required behaviour:**
1. **Make the schema tolerant of omissions that are not errors.** In `packages/shared` extraction schema:
   - Fields the document may legitimately not have must be `.nullable().optional()` and normalised to `null` after parsing: `documentTotals.tax/subtotal/total`, `customerPartCode`, `unit`, `unitPrice`, `lineTotal`, all `fieldConfidence.*` entries.
   - `lineNo`: if missing, fill it from array position (1-based) after parsing.
   - Per-line `confidence`: if missing, default to a low value (e.g. 0.5) so the line goes to review rather than failing the whole document.
   - Only truly essential data should cause failure: at least one line with a description or part code, and a numeric quantity.
2. **Use the provider's structured-output mechanism** (e.g. tool/function calling with a JSON schema generated from the Zod schema) instead of free-text JSON, if the current LLM provider implementation does not already. Check the provider SDK's official docs for the exact API; do not guess parameter names.
3. **The retry prompt** must include the specific missing/invalid fields and tell the model to use `null` when a value is absent.
4. **Partial success beats total failure:** if validation still fails after retry, salvage whatever lines are valid, create the order with those lines, add a warning issue "Some fields could not be read — please check against the document", and route amber. Only use `unreadable_document` (red) when nothing usable was extracted.
5. **Never show raw Zod errors to users.** Store the technical error on the extraction record (for debugging / super-admin), and show users a plain message: "We couldn't read this document fully. Please check the lines against the original."
6. Add a **"Re-extract"** action on held orders with `unreadable_document` (an API endpoint + button on the existing review screen; this is a fix for a dead end, not a new feature) that re-queues the extraction job.

**Tests:**
- A recorded model response with the omissions above parses successfully, lineNo filled 1..N, null tax.
- A response with zero valid lines → `unreadable_document`.
- A response with 3 valid and 1 invalid line → order with 3 lines, amber, warning issue.
- Add both failing POs (Thistle, Willow — find the attachments in storage via their InboundEmail records) as fixtures in `packages/eval/fixtures` with ground truth, and confirm `pnpm eval` extracts them.

---

### P0-4. Approved orders never push, but the UI says "Sent to ERP"

**Evidence:** Order PO-728269 (Castle Leisure Centre) was approved on 27/10 at 07:33. Since then: `status: approved`, `pushedAt: null`, `erpReference: null`, `lastPushError: null`. The Settings → Integrations page shows **no connector connected**. Yet the dashboard shows "SENT TO ERP: 1", the "Sent" tab of the queue lists it, and the dashboard pipeline card says "ERP & Storage — Ready" and "All Services Operational".

**Required behaviour:**
1. Trace the approve → push flow. Find why no push job ran or why it ended silently (no connector? job never enqueued? worker not consuming that queue?). Fix the actual cause.
2. **No active connector:** approving must still work (status `approved`), but the UI must clearly say "Approved — not sent. No ERP connector is set up." with a link to Settings → Integrations. The push job, if enqueued, must fail loudly with `push_failed` and `lastPushError = "No active connector"`, never sit forever in `approved`.
3. **Counts and tabs must use real statuses:**
   - "Sent to ERP" / "Sent" tab = only `pushed` (with `erpReference` or a CSV file reference).
   - Add `approved` (waiting / not sent) to the appropriate tab (e.g. Ready or a visible "Approved, not sent" filter), and `pushing` must be visible too.
   - "Failed" = `push_failed`.
4. **Dashboard "Live Integration Pipeline" card must reflect real state**, not hardcoded text:
   - ERP card: name of the active connector and its last test/sync status, or "Not connected" in amber.
   - Email ingestion: real mailbox/forwarding status and last received time.
   - AI extraction: show the configured model name from env/config (not a hardcoded "GPT-5.6"), and last success/failure.
   - Outbound mailer: real provider status, or "Not configured".
   - "All Services Operational" only when all of the above are actually healthy.
5. Add a stuck-job safeguard: any order in `approved` or `pushing` for more than 15 minutes with no active job is marked `push_failed` with a clear error, and shows the existing Retry button.

**Tests:**
- Approve with no connector → status ends `push_failed` (or stays `approved` with an explicit not-sent flag — pick one, document it), error message set, dashboard "Sent" count unchanged.
- Approve with MockConnector active → status `pushed`, `erpReference` set, "Sent" count +1.
- Retry after failure with the same idempotency key does not create a duplicate in the mock ERP.

---

### P0-5. Sign-up returns 500

**Evidence:** `POST /api/auth/signup` from the signup page (name, company name, work email, password ≥10 chars) returns `500 {"error":{"code":"INTERNAL","message":"Something went wrong"}}` for any new email (tried `@example.com` and `@example.test`). Login for an existing user works. `/health` returns ok.

**Required behaviour:**
1. Reproduce, read the API log for the stack trace, and fix the root cause (check: org creation/slug uniqueness, forwarding-address generation, default settings, verification email sending via the dev in-memory mailbox, missing env such as `ENCRYPTION_KEY`/`JWT_SECRET`, transaction usage on a non-replica-set Mongo).
2. Sign-up must be atomic: if any step fails, no half-created org or user remains (use a transaction if Mongo is a replica set; otherwise explicit cleanup).
3. Expected client errors return 4xx with a clear message: email already registered → 409, invalid input → 400 with field errors. Only true server faults return 500.
4. A failing verification email must not fail sign-up; log it and let the user resend.

**Tests:** integration test for successful sign-up (org, owner user, forwarding address created; verification email appears in the dev mailbox), duplicate email → 409, short password → 400.

---

## P1 — Wrong numbers and stale state

### P1-1. Order value uses our list price instead of the PO price

**Evidence:** PO-771204: document subtotal £102.50, but the queue shows **£247.50** (= 20 × £10.75 list + 10 × £3.25). PO-884920: document subtotal £64.50, queue showed £127.00. After the customer was set it changed to £64.50 — so value is computed inconsistently.

**Required behaviour:** order value = sum of the PO's line totals (or qty × PO unit price). If any PO price is missing, use expected price for that line and mark the value as "estimated" in the UI. Show expected (our) value separately only where useful (review screen). Use the same function everywhere: queue, review screen, analytics, top customers.

**Test:** both orders above produce £102.50 and £64.50.

### P1-2. Validation issues are not re-evaluated after edits

**Evidence:** After setting the customer to Abbey Cafe and changing line 1 to GL1459 and saving: the issue "Could not tell which customer sent this" is still unresolved, and the price issue still says "list price £10.75" although the new expected price is £6.80.

**Required behaviour:** after every save (and after Re-match), re-run validation and routing for the order: resolve issues that no longer apply, regenerate messages with current values, recompute line colours, order colour, confidence and status (`needs_review` → `ready` when everything is clean). Do it server-side in one function used by extraction, save and re-match. Manual "dismiss" of a warning by a reviewer must be preserved across re-validation (store who dismissed it).

**Test:** the exact sequence above leaves only the issues that still apply, with updated text.

### P1-3. Order confidence shows 0% when extraction was fine

**Evidence:** PO-884920 and PO-771204: line extraction confidence 1.0, but order confidence 0 and the queue shows "0%" because the customer was unknown.

**Required behaviour:** compute overall confidence as a documented combination (e.g. minimum or weighted average of customer-match, header and line confidences). An unknown customer should make the order amber, not zero out the score. Document the formula in code comments. In the queue, show the weakest area as a hint (e.g. "Customer unknown").

### P1-4. Uploaded documents: customer identified from uploader instead of the document

**Evidence:** PDFs uploaded manually by the user get sender = the user's own email, so the customer is always "Unknown", even though the PDF contains the customer name and delivery address ("Example Cafe Ltd, 1 High Street, Leeds").

**Required behaviour:** for uploads (and for emails sent from the org's own domain, e.g. internal forwards), skip sender-based identification and use document data: account number on the PO → customer name from extraction → delivery address/postcode vs known customer addresses → fuzzy name. Show which signal was used ("Identified by: account number on PO"). Fix the label bug where the UI says "Identified by not identified".

### P1-5. Analytics show wrong values

**Evidence:**
- "Line items requiring edits: 0% — Perfect 100% catalogue match rate", while two lines are unmatched and one was corrected.
- Touch-free rate 14.3% while "0 orders auto-approved".
- "Median time to approve 54.4 mins — from email receipt to ERP push" while no order has been pushed.
- "Top review reasons" shows the full raw Zod error text.

**Required behaviour:** define each metric precisely in code (comment above each calculation) and compute from real data:
- Touch-free rate = orders pushed with zero edits and no manual approval (auto-approved) ÷ orders processed.
- Lines requiring edits = lines with `edited = true` or unmatched at extraction ÷ total lines.
- Match rate = lines auto-matched above threshold ÷ total lines.
- Median email→approved and email→pushed as two separate metrics; show "—" when there is no data.
- Issue reasons grouped by issue `code` with a short human label, never the raw message.

**Tests:** seed a small fixed dataset and assert each metric.

### P1-6. Inbox "Failed" tab count disagrees with rows

**Evidence:** Inbox shows two rows with read status "failed" (Thistle, Willow), but the "Failed" tab count is 0. Use one definition of "failed" for both the row badge and the tab filter/count.

---

## P2 — UI polish (quick fixes)

1. Inbox subject concatenates with the attachment count: "Purchase Order PO-4718551 file" → render the count as a separate badge ("PO-471855" + "1 file").
2. "Identified by not identified" label → human labels for each identification method, or "Picked by reviewer".
3. Edit history logs no-op changes ("unit from (none) to (none)", "requestedDeliveryDate from (none) to (none)"). Only record a Correction when before ≠ after (normalise null/undefined/"" as equal).
4. Cross-references empty state says "(M6)" — remove internal milestone references from all user-facing text (search the web app for `M1`…`M10`).
5. Icon-only buttons have no accessible name (order header buttons, product picker buttons). Add `aria-label` and a tooltip to every icon-only button.
6. A non-PO document ("CASE STUDY … Transport.pdf") was treated as a new order with 0 lines. When extraction finds no order lines, the email should go to "Other emails" (not_order), not create an on-hold order. Keep the existing "convert to order" action for the reviewer.
7. The order list "Needs review" default tab: make the default tab obvious and the tab counts consistent with the filters (verify all six tabs after P0-4).

---

## Definition of done

- All P0 and P1 items fixed, each with a regression test; P2 items fixed.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass. `pnpm eval` runs and includes the two previously failing POs.
- Manual check in the browser at `http://localhost:5173`:
  1. Create a brand-new account via sign-up — works.
  2. Upload the PO-884920 PDF: line 1 is **amber** with a code/description mismatch warning (not a confident GL1001 match); picking GL1459 gives **our qty 10**, factor 1.
  3. Save: issues update immediately; order value equals the PO subtotal.
  4. A second PO from the same customer with code GL1001 and the same description now matches GL1459 automatically with factor 1.
  5. Approve with no connector: UI clearly says not sent; dashboard "Sent to ERP" does not increase.
  6. Connect the Demo ERP (mock), retry: order becomes `pushed` with an ERP reference; retrying again creates no duplicate.
  7. Analytics numbers match the data you can count by hand.
- `PROGRESS.md` updated with root cause, fix and test for each item.

Start with P0-1. Before writing code, reply with the root cause you found for P0-1 and your planned change.
</USER_REQUEST>
<ADDITIONAL_METADATA>
The current local time is: 2026-10-28T10:40:39+05:00.

The user's current state is as follows:
Active Document: d:\AMIR 2.o\sales-order-processor\.env (LANGUAGE_UNSPECIFIED)
Cursor is on line: 1
Other open documents:
- d:\AMIR 2.o\sales-order-processor\apps\web\src\features\settings\IntegrationsPage.tsx (LANGUAGE_TSX)
- d:\AMIR 2.o\sales-order-processor\packages\core\src\matching\job.ts (LANGUAGE_TYPESCRIPT)
- d:\AMIR 2.o\sales-order-processor\packages\shared\src\outboundEmails.ts (LANGUAGE_TYPESCRIPT)
- d:\AMIR 2.o\sales-order-processor\apps\api\src\app.ts (LANGUAGE_TYPESCRIPT)
- d:\AMIR 2.o\sales-order-processor\packages\core\src\queue\types.ts (LANGUAGE_TYPESCRIPT)
Running terminal commands:
- pnpm dev
 (in d:\AMIR 2.o\sales-order-processor, running for 1h12m26s)
</ADDITIONAL_METADATA>