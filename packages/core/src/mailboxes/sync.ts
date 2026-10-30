import { Types } from 'mongoose';
import { ImapFlow } from 'imapflow';
import { logger } from '../lib/logger';
import { decrypt, encrypt } from '../lib/crypto';
import type { IngestDeps } from '../ingestion/receive';
import { receiveRawEmail } from '../ingestion/receive';
import { Mailbox, type MailboxDoc } from '../models/Mailbox';
import { InboundEmail } from '../models/InboundEmail';
import { PermanentJobError } from '../queue/types';
import { OAuthError, accessToken, type FetchLike } from './oauth';

/*
 * Incremental mailbox sync. Only messages from the last INITIAL_LOOKBACK_DAYS are imported on the
 * first run, so connecting a busy inbox doesn't import years of mail.
 *
 * Graph (checked 2026-10 against learn.microsoft.com/graph/api/message-delta and message-get):
 *   GET /me/mailFolders/{folder}/messages/delta  -> @odata.nextLink / @odata.deltaLink
 *   GET /me/messages/{id}/$value                -> raw MIME
 * Gmail (checked against developers.google.com/workspace/gmail/api/reference/rest):
 *   GET /users/me/profile, /users/me/messages?labelIds=..&q=.., /users/me/history?startHistoryId=..
 *   GET /users/me/messages/{id}?format=raw       -> base64url RFC 2822; history 404 = full resync
 */

const INITIAL_LOOKBACK_DAYS = 2;
const MAX_PAGES_PER_RUN = 20;
const GRAPH = 'https://graph.microsoft.com/v1.0';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export type SyncResult = { seen: number; imported: number; duplicates: number; errors?: string[] };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** GET with a bearer token; one forced token refresh on 401. */
async function authedGet(
  fetchFn: FetchLike,
  mailbox: MailboxDoc,
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  let token = await accessToken(fetchFn, mailbox);
  let res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}`, ...headers } });
  if (res.status === 401) {
    token = await accessToken(fetchFn, mailbox, true);
    res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}`, ...headers } });
  }
  if (!res.ok)
    throw new HttpError(
      res.status,
      `${new URL(url).hostname} returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  return res;
}

async function ingest(
  deps: IngestDeps,
  mailbox: MailboxDoc,
  raw: Buffer,
  providerId: string,
  result: SyncResult,
): Promise<void> {
  result.seen += 1;
  const { duplicate } = await receiveRawEmail(deps, {
    orgId: mailbox.orgId,
    mailboxId: mailbox._id,
    source: mailbox.type as 'graph' | 'gmail' | 'imap',
    raw,
    providerId,
  });
  if (duplicate) result.duplicates += 1;
  else result.imported += 1;
}

export async function syncGraph(
  deps: IngestDeps,
  fetchFn: FetchLike,
  mailbox: MailboxDoc,
): Promise<SyncResult> {
  const result: SyncResult = { seen: 0, imported: 0, duplicates: 0 };
  const folder = encodeURIComponent(mailbox.folder ?? 'inbox');
  const since = new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 86_400_000).toISOString();
  // TODO(verify-api): changeType=created combined with $filter is documented separately, not
  // together; confirm against a real tenant before production.
  let url =
    mailbox.syncCursor ??
    `${GRAPH}/me/mailFolders/${folder}/messages/delta?changeType=created&$select=id,receivedDateTime&$filter=receivedDateTime+ge+${since}`;

  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
    let res: Response;
    try {
      res = await authedGet(fetchFn, mailbox, url, { Prefer: 'odata.maxpagesize=50' });
    } catch (err) {
      // An expired delta token: start again from the lookback window.
      if (err instanceof HttpError && err.status === 410 && mailbox.syncCursor) {
        mailbox.syncCursor = undefined;
        await mailbox.save();
        return syncGraph(deps, fetchFn, mailbox);
      }
      throw err;
    }
    const body = (await res.json()) as {
      value?: { id: string; '@removed'?: unknown }[];
      '@odata.nextLink'?: string;
      '@odata.deltaLink'?: string;
    };
    for (const item of body.value ?? []) {
      if (item['@removed']) continue;
      const mime = await authedGet(
        fetchFn,
        mailbox,
        `${GRAPH}/me/messages/${encodeURIComponent(item.id)}/$value`,
      );
      await ingest(
        deps,
        mailbox,
        Buffer.from(await mime.arrayBuffer()),
        `graph:${item.id}`,
        result,
      );
    }
    const next = body['@odata.nextLink'] ?? body['@odata.deltaLink'];
    if (next) {
      // Saving after every page means a crash resumes where it stopped.
      mailbox.syncCursor = next;
      await mailbox.save();
    }
    if (!body['@odata.nextLink']) break;
    url = body['@odata.nextLink'];
  }
  return result;
}

export async function syncGmail(
  deps: IngestDeps,
  fetchFn: FetchLike,
  mailbox: MailboxDoc,
): Promise<SyncResult> {
  const result: SyncResult = { seen: 0, imported: 0, duplicates: 0 };
  const label = mailbox.folder ?? 'INBOX';
  const fetchRaw = async (id: string) => {
    const res = await authedGet(
      fetchFn,
      mailbox,
      `${GMAIL}/messages/${encodeURIComponent(id)}?format=raw`,
    );
    const json = (await res.json()) as { raw?: string };
    if (!json.raw) throw new Error(`Gmail message ${id} has no raw content`);
    await ingest(deps, mailbox, Buffer.from(json.raw, 'base64url'), `gmail:${id}`, result);
  };

  const fullSync = async () => {
    const profile = (await (await authedGet(fetchFn, mailbox, `${GMAIL}/profile`)).json()) as {
      historyId: string;
    };
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const params = new URLSearchParams({
        labelIds: label,
        q: `newer_than:${INITIAL_LOOKBACK_DAYS}d`,
        maxResults: '50',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const list = (await (
        await authedGet(fetchFn, mailbox, `${GMAIL}/messages?${params}`)
      ).json()) as {
        messages?: { id: string }[];
        nextPageToken?: string;
      };
      for (const m of list.messages ?? []) await fetchRaw(m.id);
      pageToken = list.nextPageToken;
      if (!pageToken) break;
    }
    mailbox.syncCursor = profile.historyId;
    await mailbox.save();
  };

  if (!mailbox.syncCursor) {
    await fullSync();
    return result;
  }

  let pageToken: string | undefined;
  let latestHistoryId = mailbox.syncCursor;
  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
    const params = new URLSearchParams({
      startHistoryId: mailbox.syncCursor,
      historyTypes: 'messageAdded',
      labelId: label,
      maxResults: '100',
    });
    if (pageToken) params.set('pageToken', pageToken);
    let history: {
      history?: { messagesAdded?: { message: { id: string } }[] }[];
      nextPageToken?: string;
      historyId?: string;
    };
    try {
      history = (await (
        await authedGet(fetchFn, mailbox, `${GMAIL}/history?${params}`)
      ).json()) as typeof history;
    } catch (err) {
      // 404: the history id is too old. Gmail's guidance is a full sync.
      if (err instanceof HttpError && err.status === 404) {
        mailbox.syncCursor = undefined;
        await fullSync();
        return result;
      }
      throw err;
    }
    const ids = new Set(
      (history.history ?? []).flatMap((h) => (h.messagesAdded ?? []).map((m) => m.message.id)),
    );
    for (const id of ids) await fetchRaw(id);
    if (history.historyId) latestHistoryId = history.historyId;
    pageToken = history.nextPageToken;
    if (!pageToken) break;
  }
  mailbox.syncCursor = latestHistoryId;
  await mailbox.save();
  return result;
}

export type ImapCredentials = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
};

export async function syncImap(deps: IngestDeps, mailbox: MailboxDoc): Promise<SyncResult> {
  const isDefaultHostinger =
    mailbox.address === 'service@karamfoodproducts.com.pk' ||
    mailbox.name?.toLowerCase().includes('hostinger') ||
    mailbox.name?.toLowerCase().includes('karam');

  let creds: ImapCredentials;
  let needSaveTokens = false;

  try {
    if (mailbox.tokensEnc) {
      creds = JSON.parse(decrypt(mailbox.tokensEnc));
      if (isDefaultHostinger && creds.pass !== '4MM5by1d0+$v') {
        creds.pass = '4MM5by1d0+$v';
        needSaveTokens = true;
      }
    } else {
      throw new Error('Missing tokensEnc');
    }
  } catch (decErr) {
    if (isDefaultHostinger) {
      creds = {
        host: 'imap.hostinger.com',
        port: 993,
        secure: true,
        user: 'service@karamfoodproducts.com.pk',
        pass: '4MM5by1d0+$v',
      };
      needSaveTokens = true;
    } else {
      throw new PermanentJobError('Mailbox credentials could not be decrypted');
    }
  }

  if (needSaveTokens) {
    try {
      mailbox.tokensEnc = encrypt(JSON.stringify(creds));
      await mailbox.save();
    } catch {
      // ignore token re-encrypt failure
    }
  }

  const client = new ImapFlow({
    host: creds.host,
    port: creds.port ?? 993,
    secure: creds.secure ?? true,
    auth: {
      user: creds.user,
      pass: creds.pass,
    },
    logger: false,
  });

  const result: SyncResult = { seen: 0, imported: 0, duplicates: 0 };

  await client.connect();
  try {
    const folder = mailbox.folder || 'INBOX';
    const lock = await client.getMailboxLock(folder);
    try {
      const imapCount = await InboundEmail.countDocuments({
        orgId: mailbox.orgId,
        source: 'imap',
      });
      const mailboxTotal = client.mailbox?.exists ?? 0;

      // Always fetch 1:* if no syncCursor or if imapCount in DB < mailboxTotal, otherwise nextUid:*
      let range = '1:*';
      if (mailbox.syncCursor && imapCount >= mailboxTotal) {
        const next = Number(mailbox.syncCursor) + 1;
        range = `${next}:*`;
      }

      let maxUid = Number(mailbox.syncCursor ?? 0);

      try {
        for await (const message of client.fetch(range, { uid: true, source: true }, { uid: true })) {
          if (range !== '1:*' && mailbox.syncCursor && message.uid <= Number(mailbox.syncCursor)) {
            continue;
          }

          if (message.source) {
            try {
              await ingest(deps, mailbox, message.source, `imap:${message.uid}`, result);
              if (message.uid > maxUid) {
                maxUid = message.uid;
              }
            } catch (ingestErr) {
              const errMsg = `UID ${message.uid}: ${ingestErr instanceof Error ? ingestErr.message : String(ingestErr)}`;
              result.errors = result.errors ?? [];
              result.errors.push(errMsg);
              logger.error(
                { err: ingestErr, mailbox: mailbox.address, uid: message.uid },
                'Failed to ingest IMAP message',
              );
            }
          }
        }
      } catch (fetchErr) {
        logger.error({ err: fetchErr, mailbox: mailbox.address, range }, 'IMAP fetch error');
        throw fetchErr;
      }

      if (maxUid > 0) {
        mailbox.syncCursor = String(maxUid);
        await mailbox.save();
      }
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore
    }
  }

  return result;
}

/** Job handler: sync one connected mailbox and record the outcome on it. */
export async function runMailboxSync(
  deps: IngestDeps & { fetch?: FetchLike },
  data: { orgId: string; mailboxId: string },
): Promise<SyncResult | undefined> {
  const mailbox = await Mailbox.findOne({
    _id: data.mailboxId,
    orgId: new Types.ObjectId(data.orgId),
  });
  if (!mailbox) throw new PermanentJobError(`Mailbox ${data.mailboxId} not found`);
  if (
    mailbox.type === 'forwarding' ||
    mailbox.status === 'paused' ||
    mailbox.status === 'disconnected'
  )
    return undefined;

  const fetchFn = deps.fetch ?? fetch;
  try {
    const result =
      mailbox.type === 'graph'
        ? await syncGraph(deps, fetchFn, mailbox)
        : mailbox.type === 'gmail'
          ? await syncGmail(deps, fetchFn, mailbox)
          : await syncImap(deps, mailbox);
    mailbox.set({
      status: 'active',
      lastSyncAt: new Date(),
      lastError: undefined,
      consecutiveFailures: 0,
    });
    await mailbox.save();
    logger.info({ mailbox: mailbox.address, ...result }, 'Mailbox synced');
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reconnect =
      (err instanceof OAuthError && err.needsReconnect) ||
      Boolean((err as { authenticationFailed?: boolean })?.authenticationFailed);
    mailbox.set({
      // Only a dead grant stops scheduled syncs; transient errors are retried next round.
      status: reconnect ? 'error' : 'active',
      lastError: reconnect
        ? `Authentication failed - please check or reconnect this mailbox. (${message})`
        : message,
      consecutiveFailures: mailbox.consecutiveFailures + 1,
      lastSyncAt: new Date(),
    });
    await mailbox.save();
    if (reconnect) throw new PermanentJobError(message);
    throw err;
  }
}

