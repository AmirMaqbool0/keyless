import crypto from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Types } from 'mongoose';
import type { EmailSource } from '@keyless/shared';
import { env } from '../config/env';
import { badRequest } from '../lib/http';
import { storageKey, type Storage } from '../lib/storage';
import { InboundEmail, type InboundEmailDoc } from '../models/InboundEmail';
import { Mailbox, type MailboxDoc } from '../models/Mailbox';
import type { OrganizationDoc } from '../models/Organization';
import type { JobQueue } from '../queue/types';

export const MAX_RAW_EMAIL_BYTES = 30 * 1024 * 1024;

export type IngestDeps = { queue: JobQueue; storage: Storage };

/** The Message-ID header, read from the raw header block without a full MIME parse. */
export function messageIdFromRaw(raw: Buffer): string | undefined {
  const head = raw.subarray(0, Math.min(raw.length, 64 * 1024)).toString('latin1');
  const end = head.search(/\r?\n\r?\n/);
  const headers = (end === -1 ? head : head.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
  const match = /^message-id:\s*<?([^>\s]+)>?/im.exec(headers);
  return match?.[1]?.toLowerCase();
}

/**
 * Dedupe key. The Message-ID header comes first, so the same email arriving by two routes
 * (forwarded and synced, say) is stored once. Then the provider's own id, then a content hash.
 */
export function dedupeKey(raw: Buffer, providerId?: string): string {
  const mid = messageIdFromRaw(raw);
  if (mid) return `mid:${mid}`;
  if (providerId) return providerId;
  return `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

export type ReceiveInput = {
  orgId: Types.ObjectId;
  mailboxId?: Types.ObjectId;
  source: EmailSource;
  raw: Buffer;
  /** e.g. "graph:<id>"; used only when the email has no Message-ID. */
  providerId?: string;
  receivedAt?: Date;
  uploadedBy?: Types.ObjectId;
};

/**
 * Store a raw RFC 822 email and queue it for processing. Idempotent: a second delivery of the
 * same email returns the existing record with `duplicate: true`.
 */
export async function receiveRawEmail(
  deps: IngestDeps,
  input: ReceiveInput,
): Promise<{ email: InboundEmailDoc; duplicate: boolean }> {
  if (input.raw.length > MAX_RAW_EMAIL_BYTES)
    throw badRequest('Email is larger than 30 MB', 'EMAIL_TOO_LARGE');
  if (input.raw.length === 0) throw badRequest('Empty email', 'EMPTY_EMAIL');

  const key = dedupeKey(input.raw, input.providerId);
  const existing = await InboundEmail.findOne({ orgId: input.orgId, providerMessageId: key });
  if (existing) return { email: existing, duplicate: true };

  const rawKey = storageKey(input.orgId.toString(), 'emails', 'message.eml');
  await deps.storage.put(rawKey, input.raw, 'message/rfc822');
  let email: InboundEmailDoc;
  try {
    email = await InboundEmail.create({
      orgId: input.orgId,
      mailboxId: input.mailboxId,
      source: input.source,
      providerMessageId: key,
      messageId: messageIdFromRaw(input.raw),
      receivedAt: input.receivedAt ?? new Date(),
      rawStorageKey: rawKey,
      rawSize: input.raw.length,
      uploadedBy: input.uploadedBy,
    });
  } catch (err) {
    // Lost a race with a concurrent delivery of the same email.
    await deps.storage.delete(rawKey);
    const winner = await InboundEmail.findOne({ orgId: input.orgId, providerMessageId: key });
    if (winner) return { email: winner, duplicate: true };
    throw err;
  }
  await deps.queue.add(
    'process-email',
    { orgId: input.orgId.toString(), emailId: email._id.toString() },
    { uniqueKey: `process-email:${email._id}` },
  );
  return { email, duplicate: false };
}

export const UPLOAD_SOURCE_HEADER = 'X-Keyless-Source';

/**
 * A document uploaded by a user (PDF, spreadsheet, photo) is wrapped in a synthetic email so it
 * goes through exactly the same pipeline as a real one.
 */
export async function receiveUploadedDocument(
  deps: IngestDeps,
  input: {
    orgId: Types.ObjectId;
    user: { _id: Types.ObjectId; email: string; name: string };
    filename: string;
    contentType: string;
    content: Buffer;
  },
): Promise<{ email: InboundEmailDoc; duplicate: boolean }> {
  const hash = crypto.createHash('sha256').update(input.content).digest('hex');
  const raw = await new MailComposer({
    from: { name: input.user.name, address: input.user.email },
    to: 'upload@keyless.local',
    subject: `Uploaded: ${input.filename}`,
    text: `Uploaded to Keyless by ${input.user.name} (${input.user.email}).`,
    messageId: `<upload-${hash}@keyless.local>`,
    headers: { [UPLOAD_SOURCE_HEADER]: 'upload-document' },
    attachments: [
      { filename: input.filename, content: input.content, contentType: input.contentType },
    ],
  })
    .compile()
    .build();
  return receiveRawEmail(deps, {
    orgId: input.orgId,
    source: 'upload',
    raw,
    uploadedBy: input.user._id,
  });
}

/** Each org gets one forwarding address, created the first time it is needed. */
export async function ensureForwardingMailbox(org: OrganizationDoc): Promise<MailboxDoc> {
  const existing = await Mailbox.findOne({ orgId: org._id, type: 'forwarding' });
  if (existing) return existing;
  // The random suffix stops anyone guessing another company's address from its name.
  const alias = `orders-${org.slug.slice(0, 30)}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    return await Mailbox.create({
      orgId: org._id,
      type: 'forwarding',
      name: 'Forwarding address',
      address: `${alias}@${env.INBOUND_EMAIL_DOMAIN}`,
      inboundAlias: alias,
    });
  } catch (err) {
    const raced = await Mailbox.findOne({ orgId: org._id, type: 'forwarding' });
    if (raced) return raced;
    throw err;
  }
}

/** Find the forwarding mailbox an inbound address belongs to (any org). */
export async function mailboxForRecipient(addresses: string[]): Promise<MailboxDoc | null> {
  const domain = env.INBOUND_EMAIL_DOMAIN.toLowerCase();
  for (const address of addresses) {
    const [local, host] = address
      .trim()
      .toLowerCase()
      .replace(/^.*</, '')
      .replace(/>.*$/, '')
      .split('@');
    if (!local || host !== domain) continue;
    const mailbox = await Mailbox.findOne({ inboundAlias: local, type: 'forwarding' }).setOptions({
      skipTenant: true,
    });
    if (mailbox) return mailbox;
  }
  return null;
}

/** Recipient addresses from the raw headers, for routing when the provider gives no envelope. */
export function recipientsFromRaw(raw: Buffer): string[] {
  const head = raw.subarray(0, Math.min(raw.length, 64 * 1024)).toString('latin1');
  const end = head.search(/\r?\n\r?\n/);
  const headers = (end === -1 ? head : head.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
  const out: string[] = [];
  for (const name of [
    'delivered-to',
    'x-original-to',
    'x-forwarded-to',
    'envelope-to',
    'to',
    'cc',
  ]) {
    for (const m of headers.matchAll(new RegExp(`^${name}:\\s*(.+)$`, 'gim'))) {
      out.push(...(m[1]!.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? []));
    }
  }
  return [...new Set(out.map((a) => a.toLowerCase()))];
}
