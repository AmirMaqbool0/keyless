import crypto from 'node:crypto';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { Types } from 'mongoose';
import { logger } from '../lib/logger';
import { storageKey, type Storage } from '../lib/storage';
import type { LlmProvider } from '../llm/types';
import { Attachment, attachmentKind } from '../models/Attachment';
import { InboundEmail, type Classification } from '../models/InboundEmail';
import { recordUsage } from '../models/UsageRecord';
import { linkChangeEmail } from '../matching/job';
import { PermanentJobError, type JobQueue } from '../queue/types';
import { HEURISTIC_CONFIDENT, classifyHeuristically } from './classify';

const MAX_TEXT = 200_000;
const MAX_HTML = 500_000;
/** Tiny inline images are signatures/logos, never order documents. */
const SIGNATURE_IMAGE_BYTES = 20 * 1024;

/** Headers kept on the record: the ones classification and routing look at. */
const KEPT_HEADERS = [
  'auto-submitted',
  'x-autoreply',
  'x-autorespond',
  'x-auto-response-suppress',
  'precedence',
  'list-unsubscribe',
  'list-id',
  'reply-to',
  'in-reply-to',
  'references',
  'delivered-to',
  'x-original-to',
  'x-forwarded-to',
  'x-keyless-source',
  'content-type',
];

function addresses(field: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(field) ? field : field ? [field] : [];
  return list.flatMap((a) =>
    a.value.map((v) => v.address?.toLowerCase()).filter((x): x is string => Boolean(x)),
  );
}

function headerRecord(parsed: ParsedMail): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = parsed.headers.get(name);
    if (value === undefined) continue;
    out[name] = (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 2000);
  }
  return out;
}

export type PipelineDeps = { storage: Storage; queue: JobQueue; llm: LlmProvider };

/** Job: parse a stored raw email into fields and attachment records. Safe to re-run. */
export async function processEmail(
  deps: PipelineDeps,
  data: { orgId: string; emailId: string },
): Promise<void> {
  const orgId = new Types.ObjectId(data.orgId);
  const email = await InboundEmail.findOne({ _id: data.emailId, orgId });
  if (!email) throw new PermanentJobError(`Email ${data.emailId} not found`);

  let parsed: ParsedMail;
  try {
    parsed = await simpleParser(await deps.storage.get(email.rawStorageKey));
  } catch (err) {
    email.status = 'failed';
    email.error = `Could not read this email: ${err instanceof Error ? err.message : String(err)}`;
    await email.save();
    throw new PermanentJobError(email.error);
  }

  // Re-processing replaces earlier attachment records and files.
  const old = await Attachment.find({ orgId, emailId: email._id });
  await Promise.all(old.map((a) => deps.storage.delete(a.storageKey)));
  await Attachment.deleteMany({ orgId, emailId: email._id });

  const attachmentIds: Types.ObjectId[] = [];
  for (const [i, att] of parsed.attachments.entries()) {
    const filename = att.filename || `attachment-${i + 1}`;
    const kind = attachmentKind(filename, att.contentType);
    const isInline = Boolean(
      att.related ||
      (att.contentDisposition === 'inline' &&
        att.cid &&
        kind === 'image' &&
        att.size < SIGNATURE_IMAGE_BYTES),
    );
    const key = storageKey(data.orgId, 'attachments', filename);
    await deps.storage.put(key, att.content, att.contentType);
    const doc = await Attachment.create({
      orgId,
      emailId: email._id,
      filename,
      mimeType: att.contentType || 'application/octet-stream',
      size: att.size,
      sha256: crypto.createHash('sha256').update(att.content).digest('hex'),
      storageKey: key,
      kind,
      isInline,
      contentId: att.cid,
    });
    attachmentIds.push(doc._id);
  }

  const from = parsed.from?.value[0];
  email.set({
    from: { name: from?.name || undefined, address: from?.address?.toLowerCase() },
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    subject: (parsed.subject ?? '').slice(0, 500),
    text: (parsed.text ?? '').slice(0, MAX_TEXT),
    html: typeof parsed.html === 'string' ? parsed.html.slice(0, MAX_HTML) : undefined,
    headers: headerRecord(parsed),
    messageId: parsed.messageId?.replace(/^<|>$/g, '').toLowerCase() ?? email.messageId,
    attachmentIds,
    status: 'parsed',
    error: undefined,
    parsedAt: new Date(),
  });
  // An uploaded .eml was received when the customer sent it, not when it was uploaded.
  if (
    email.source === 'upload' &&
    parsed.date &&
    email.headers['x-keyless-source'] !== 'upload-document'
  ) {
    email.receivedAt = parsed.date;
  }
  await email.save();

  await deps.queue.add('classify-email', data, {
    uniqueKey: `classify-email:${email._id}`,
    reset: true,
  });
}

/** Job: classify a parsed email. Heuristics first; the LLM only when they are unsure. */
export async function classifyEmail(
  deps: PipelineDeps,
  data: { orgId: string; emailId: string },
): Promise<void> {
  const orgId = new Types.ObjectId(data.orgId);
  const email = await InboundEmail.findOne({ _id: data.emailId, orgId });
  if (!email) throw new PermanentJobError(`Email ${data.emailId} not found`);
  // Never overwrite a reviewer's decision with an automatic one.
  if (email.classification?.method === 'manual') return;

  const attachments = await Attachment.find(
    { orgId, emailId: email._id },
    { filename: 1, kind: 1, isInline: 1 },
  ).lean();
  const input = {
    subject: email.subject,
    text: email.text,
    from: email.from?.address,
    headers: email.headers,
    attachments: attachments.map((a) => ({
      filename: a.filename,
      kind: a.kind,
      isInline: a.isInline,
    })),
  };

  const heuristic = classifyHeuristically(input);
  let result: Classification = { ...heuristic, method: 'heuristic', classifiedAt: new Date() };
  if (heuristic.confidence < HEURISTIC_CONFIDENT) {
    try {
      const llm = await deps.llm.classifyEmail(input);
      result = {
        label: llm.label,
        confidence: llm.confidence,
        reasons: [llm.reason, ...heuristic.reasons.map((r) => `Heuristic: ${r}`)],
        method: 'llm',
        model: llm.model,
        usage: llm.usage,
        classifiedAt: new Date(),
      };
    } catch (err) {
      // The heuristic answer is still useful; a reviewer can correct it.
      logger.warn(
        { err, emailId: data.emailId },
        'LLM classification failed; keeping heuristic result',
      );
    }
  }

  email.classification = result;
  email.classificationHistory.push(result);
  email.status = 'classified';
  await email.save();
  if (result.usage?.inputTokens) {
    await recordUsage(orgId, {
      llmCalls: 1,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.usage.costUsd,
    });
  }
  if (result.label === 'new_order') await queueExtraction(deps.queue, data);
  if (result.label === 'amendment' || result.label === 'cancellation')
    await linkChangeEmail(email, result.label);
}

/** Queue (or re-run) extraction for an email. */
export function queueExtraction(
  queue: JobQueue,
  data: { orgId: string; emailId: string },
): Promise<void> {
  return queue.add('extract-email', data, {
    uniqueKey: `extract-email:${data.emailId}`,
    reset: true,
  });
}
