import { Types } from 'mongoose';
import type { Storage } from '../lib/storage';
import type { LlmProvider } from '../llm/types';
import { Attachment } from '../models/Attachment';
import { Extraction } from '../models/Extraction';
import { InboundEmail, type ExtractionSummary } from '../models/InboundEmail';
import { recordUsage } from '../models/UsageRecord';
import { PermanentJobError, type JobQueue } from '../queue/types';
import { extractEmail, extractionSources, type SourceFile } from './extract';

/** Job: read the order(s) out of an email classified as a new order. Safe to re-run. */
export async function runExtraction(
  deps: { storage: Storage; llm: LlmProvider; queue: JobQueue },
  data: { orgId: string; emailId: string },
): Promise<void> {
  const orgId = new Types.ObjectId(data.orgId);
  const email = await InboundEmail.findOne({ _id: data.emailId, orgId });
  if (!email) throw new PermanentJobError(`Email ${data.emailId} not found`);

  const attachments = await Attachment.find({ orgId, emailId: email._id });
  const files: SourceFile[] = attachments.map((a) => ({
    id: a._id.toString(),
    filename: a.filename,
    kind: a.kind,
    isInline: a.isInline,
    content: Buffer.alloc(0),
  }));
  // Only load the bytes we will actually read.
  const wanted = new Set(extractionSources(files).map((f) => f.id));
  for (const f of files) {
    if (wanted.has(f.id)) {
      const att = attachments.find((a) => a._id.toString() === f.id)!;
      try {
        f.content = await deps.storage.get(att.storageKey);
      } catch (storageErr) {
        if (att.data) {
          f.content = att.data;
        } else {
          throw storageErr;
        }
      }
    }
  }

  email.extraction = { status: 'running', orderCount: 0, lineCount: 0, issueCount: 0, costUsd: 0 };
  await email.save();

  let results;
  try {
    results = await extractEmail(deps.llm, {
      email: {
        subject: email.subject,
        fromName: email.from?.name,
        fromAddress: email.from?.address,
        receivedAt: email.receivedAt,
        text: email.text,
      },
      files,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    email.extraction = {
      status: 'failed',
      orderCount: 0,
      lineCount: 0,
      issueCount: 0,
      costUsd: 0,
      completedAt: new Date(),
    };
    email.status = 'failed';
    email.error = errorMsg;
    await email.save();
    throw err;
  }

  await Extraction.deleteMany({ orgId, emailId: email._id });
  await Extraction.insertMany(
    results.map((r) => ({
      orgId,
      emailId: email._id,
      attachmentId: r.source.attachmentId ? new Types.ObjectId(r.source.attachmentId) : undefined,
      ...r,
      model: r.model ?? undefined,
      documentNotes: r.documentNotes ?? undefined,
      error: r.error ?? undefined,
    })),
  );

  const orders = results.flatMap((r) => r.orders);
  const statuses = results.map((r) => r.status);
  const summary: ExtractionSummary = {
    status: statuses.every((s) => s === 'completed')
      ? 'completed'
      : statuses.some((s) => s === 'completed')
        ? 'partial'
        : statuses.includes('needs_llm')
          ? 'needs_llm'
          : 'failed',
    orderCount: orders.length,
    lineCount: orders.reduce((n, o) => n + o.lines.length, 0),
    issueCount: orders.reduce(
      (n, o) => n + o.issues.filter((i) => i.severity !== 'info').length,
      0,
    ),
    costUsd: results.reduce((c, r) => c + r.usage.costUsd, 0),
    completedAt: new Date(),
  };
  email.extraction = summary;
  if (summary.status === 'failed') {
    email.status = 'failed';
    const firstErr = results.find((r) => r.error)?.error;
    if (firstErr && !email.error) email.error = firstErr;
  }
  await email.save();

  const llmCalls = results.reduce((n, r) => n + r.attempts, 0);
  await recordUsage(orgId, {
    llmCalls: deps.llm.name === 'mock' ? 0 : llmCalls,
    inputTokens: results.reduce((n, r) => n + r.usage.inputTokens, 0),
    outputTokens: results.reduce((n, r) => n + r.usage.outputTokens, 0),
    costUsd: summary.costUsd,
    documentsExtracted: results.filter((r) => r.status === 'completed').length,
    pagesProcessed: results.reduce((n, r) => n + r.pageCount, 0),
    ordersExtracted: orders.length,
  });
  await deps.queue.add('build-orders', data, {
    uniqueKey: `build-orders:${data.emailId}`,
    reset: true,
  });
}
