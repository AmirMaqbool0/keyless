# Getting email into Keyless

There are three ways in. All of them end in the same pipeline: store raw → parse → classify.

| Way in                                                                    | Setup                                                              | Speed                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| **Forwarding address** (`orders-<company>-<random>@INBOUND_EMAIL_DOMAIN`) | A domain whose incoming mail is posted to `POST /webhooks/inbound` | Seconds                                           |
| **Connected mailbox** (Microsoft 365 or Gmail, read-only OAuth)           | An app registration with Microsoft or Google                       | Every `MAILBOX_SYNC_INTERVAL_SEC` (default 2 min) |
| **Manual upload** (drag `.eml`, PDF, Excel, CSV or photos onto the inbox) | Nothing                                                            | Immediate                                         |

In development, the inbox has a **Send test email** button that posts realistic sample emails
through the same path as the webhook.

## 1. Forwarding address (inbound webhook)

`POST /webhooks/inbound` accepts any of these shapes. It authenticates with
`INBOUND_WEBHOOK_SECRET`, sent either as the `X-Inbound-Secret` header or as the password of
HTTP Basic auth (`https://inbound:<secret>@your-api/webhooks/inbound`).

1. **Raw MIME** (`Content-Type: message/rfc822`). Optional `X-Envelope-To` header with the
   recipient. Used by Cloudflare Email Workers (below) and the test tools.
2. **JSON** `{ "RawEmail": "<raw MIME>", "OriginalRecipient": "..." }` for Postmark inbound with
   "Include raw email" turned on, or `{ "raw": "...", "encoding": "base64", "to": "..." }`.
   _Postmark field names are TODO(verify-api) until a Postmark account is wired up._
3. **multipart/form-data** with `email` (raw MIME) and `envelope` (JSON) fields, for SendGrid
   Inbound Parse with "POST the raw, full MIME message" ticked.

Each email is routed to an org by its recipient's local part, so the email has to reach the
`orders-…` address itself. Unknown recipients get `202 { accepted: false }` (so providers don't
retry) and are logged. Deliveries are deduplicated on the `Message-ID` header.

### Free option: Cloudflare Email Routing + an Email Worker

Cloudflare Email Routing and Workers are free for this volume. You need a domain on Cloudflare
(for example `in.yourdomain.co.uk`) and an API URL that Cloudflare can reach. In development,
a free `cloudflared` quick tunnel works: `cloudflared tunnel --url http://localhost:4000`.

1. Cloudflare dashboard → your domain → **Email → Email Routing** → enable it (it adds the MX records).
2. **Workers** → create a Worker from [`cloudflare-email-worker.js`](cloudflare-email-worker.js).
   Set the secrets `KEYLESS_WEBHOOK_URL` (`https://<api>/webhooks/inbound`) and `KEYLESS_SECRET`.
3. Email Routing → **Routing rules** → **Catch-all** → action "Send to a Worker" → that Worker.
4. Set `INBOUND_EMAIL_DOMAIN=in.yourdomain.co.uk` and the same `INBOUND_WEBHOOK_SECRET` in `.env`.

> Checked against Cloudflare's Email Workers runtime API (`message.raw` is a ReadableStream, and
> `message.to` is the envelope recipient). Not yet run end to end against a real Cloudflare
> account: try it once with a real domain before relying on it.

### Telling customers' mail to go there

The Mailboxes settings page shows the address and step-by-step instructions for Microsoft 365
(an admin transport rule, which keeps the original sender), Outlook rules and Gmail forwarding.
Gmail's forwarding confirmation email lands in the Keyless inbox, where you can read the code.

## 2. Connected mailboxes (OAuth)

Keyless asks for read-only access (`Mail.Read` for Microsoft, `gmail.readonly` for Google). It
uses the authorization-code flow with PKCE, stores the tokens encrypted (AES-256-GCM), refreshes
them automatically, and on the first sync imports only the last 2 days of mail.

**Redirect URIs** (register exactly these; they sit on the web app's origin so session cookies flow):

- `${APP_URL}/api/mailboxes/oauth/graph/callback`
- `${APP_URL}/api/mailboxes/oauth/gmail/callback`

### Microsoft 365 (free with any Microsoft Entra / Azure account)

1. Entra admin centre → **App registrations** → New registration. Choose "Accounts in any
   organizational directory" (multi-tenant), plus personal accounts if you want them.
2. Redirect URI: platform **Web**, the Graph URI above.
3. **Certificates & secrets** → New client secret.
4. **API permissions** → Microsoft Graph → Delegated: `Mail.Read`, `User.Read`, `offline_access`,
   `openid`, `email`.
5. `.env`: `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT=common` (or your tenant id).

Sync uses `GET /me/mailFolders/{folder}/messages/delta` (default folder `inbox`) and
`GET /me/messages/{id}/$value` for the raw MIME. The delta link is saved after every page.

### Gmail / Google Workspace (free Google Cloud project)

1. Google Cloud console → new project → **APIs & Services → Library** → enable **Gmail API**.
2. **OAuth consent screen**: External (or Internal for Workspace), add the scope
   `https://www.googleapis.com/auth/gmail.readonly`, and add yourself as a test user while the
   app is in testing.
3. **Credentials** → Create OAuth client ID → Web application → the Gmail redirect URI above.
4. `.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

Sync uses `users.history.list` (label `INBOX` by default) after a first `messages.list`
lookback. A `404` on an old history id triggers a full resync, as Google recommends.

> Note: `gmail.readonly` is a "restricted" scope. Public production use needs Google's OAuth
> verification (and a security assessment). Testing mode allows up to 100 test users.

## 3. Jobs, retries and errors

Each step is a background job: `process-email` → `classify-email`, plus `mailbox-sync`. Failed
steps are retried with exponential backoff (5 s, 10 s, 20 s…, 5 attempts). After that the failure
appears under **Settings → Processing errors** with Retry and Dismiss buttons.

- `QUEUE_DRIVER=mongo` (default): jobs live in MongoDB, so nothing extra is needed. Good for
  one worker or a few.
- `QUEUE_DRIVER=bullmq` with `REDIS_URL`: BullMQ on Redis. Free options are Upstash (hosted) or
  Memurai Developer (Windows). _Not yet exercised against a real Redis; see PROGRESS.md._

## Classification

Heuristics run first: auto-replies, bounces and newsletters, order documents and order-like
lines, and wording for amendments, cancellations, quotes and delivery queries. Anything they
are less than 80% sure about goes to the LLM (`LLM_PROVIDER`; `mock` until M4). A reviewer can
correct any email's type, and automatic re-runs never overwrite a reviewer's choice.
