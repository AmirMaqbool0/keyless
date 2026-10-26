import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  EMAIL_CLASSIFICATIONS,
  listQuerySchema,
  reclassifySchema,
  type ClassificationDto,
  type EmailDetailDto,
  type ExtractionDto,
  type EmailListItemDto,
  type Paginated,
  type ProcessingErrorDto,
} from '@keyless/shared';
import {
  receiveRawEmail,
  receiveUploadedDocument,
  type IngestDeps,
} from '@keyless/core/ingestion/receive';
import { audit } from '@keyless/core/lib/audit';
import { badRequest, notFound, param, validate } from '@keyless/core/lib/http';
import { escapeRegex } from '@keyless/core/lib/normalise';
import { Attachment, attachmentKind } from '@keyless/core/models/Attachment';
import { ErrorLog } from '@keyless/core/models/ErrorLog';
import {
  InboundEmail,
  type Classification,
  type IInboundEmail,
} from '@keyless/core/models/InboundEmail';
import { Mailbox } from '@keyless/core/models/Mailbox';
import { Extraction, type IExtraction } from '@keyless/core/models/Extraction';
import { queueExtraction } from '@keyless/core/ingestion/process';
import type { JobName } from '@keyless/core/queue/types';
import { authed, requireRole } from '../../middleware/auth';
import { objectId } from '../shared';

const MAX_UPLOAD_FILES = 10;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: MAX_UPLOAD_FILES },
});

const listQuery = listQuerySchema.extend({
  view: z.enum(['all', 'orders', 'other', 'failed']).default('all'),
  label: z.enum(EMAIL_CLASSIFICATIONS).optional(),
});

function classificationDto(c: Classification | undefined): ClassificationDto | null {
  if (!c) return null;
  return {
    label: c.label,
    confidence: c.confidence,
    method: c.method,
    reasons: c.reasons,
    model: c.model ?? null,
    classifiedAt: c.classifiedAt.toISOString(),
    classifiedBy: c.classifiedBy?.toString() ?? null,
  };
}

function listItem(e: IInboundEmail): EmailListItemDto {
  return {
    id: e._id.toString(),
    source: e.source,
    status: e.status,
    from: { name: e.from?.name ?? null, address: e.from?.address ?? null },
    subject: e.subject || (e.status === 'received' ? '(processing...)' : '(no subject)'),
    snippet: e.text.replace(/\s+/g, ' ').trim().slice(0, 160),
    receivedAt: e.receivedAt.toISOString(),
    attachmentCount: e.attachmentIds.length,
    classification: classificationDto(e.classification),
    error: e.error ?? null,
    extraction: e.extraction
      ? {
          status: e.extraction.status,
          orderCount: e.extraction.orderCount,
          lineCount: e.extraction.lineCount,
          issueCount: e.extraction.issueCount,
        }
      : null,
  };
}

function extractionDto(x: IExtraction): ExtractionDto {
  return {
    id: x._id.toString(),
    source: x.source,
    status: x.status,
    provider: x.provider,
    model: x.model ?? null,
    promptVersion: x.promptVersion,
    orders: x.orders,
    documentNotes: x.documentNotes ?? null,
    error: x.error ?? null,
    usage: x.usage,
    durationMs: x.durationMs,
    attempts: x.attempts,
    createdAt: x.createdAt.toISOString(),
  };
}

/** Mounted behind requireAuth + requireVerified. */
export function emailsRouter(deps: IngestDeps): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const { orgId } = authed(req);
    const q = validate(listQuery, req.query);
    const viewFilter = {
      all: {},
      orders: { 'classification.label': 'new_order' },
      other: { 'classification.label': { $exists: true, $ne: 'new_order' } },
      failed: { status: 'failed' },
    }[q.view];
    const search = q.q ? new RegExp(escapeRegex(q.q), 'i') : null;
    const filter = {
      orgId,
      ...viewFilter,
      ...(q.label ? { 'classification.label': q.label } : {}),
      ...(search
        ? { $or: [{ subject: search }, { 'from.address': search }, { 'from.name': search }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      InboundEmail.find(filter, { html: 0, headers: 0 })
        .sort({ receivedAt: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize),
      InboundEmail.countDocuments(filter),
    ]);
    const body: Paginated<EmailListItemDto> = {
      items: rows.map(listItem),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
    res.json(body);
  });

  r.get('/counts', async (req, res) => {
    const { orgId } = authed(req);
    const rows = await InboundEmail.aggregate<{ _id: string | null; n: number }>([
      { $match: { orgId } },
      { $group: { _id: '$classification.label', n: { $sum: 1 } } },
    ]);
    const failed = await InboundEmail.countDocuments({ orgId, status: 'failed' });
    res.json({
      byLabel: Object.fromEntries(rows.map((r) => [r._id ?? 'unclassified', r.n])),
      failed,
    });
  });

  r.get('/:id', async (req, res) => {
    const { orgId } = authed(req);
    const email = await InboundEmail.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!email) throw notFound('Email not found');
    const [attachments, mailbox, extractions] = await Promise.all([
      Attachment.find({ orgId, emailId: email._id }).sort({ isInline: 1, createdAt: 1 }),
      email.mailboxId
        ? Mailbox.findOne({ _id: email.mailboxId, orgId }, { type: 1, address: 1 })
        : null,
      Extraction.find({ orgId, emailId: email._id }).sort({ createdAt: 1 }),
    ]);
    const timeline: EmailDetailDto['timeline'] = [
      { at: email.createdAt.toISOString(), event: 'Received', detail: `via ${email.source}` },
    ];
    if (email.parsedAt)
      timeline.push({
        at: email.parsedAt.toISOString(),
        event: 'Read',
        detail: `${attachments.length} attachment(s)`,
      });
    for (const c of email.classificationHistory) {
      timeline.push({
        at: c.classifiedAt.toISOString(),
        event: c.method === 'manual' ? 'Reclassified by reviewer' : 'Classified',
        detail: `${c.label} (${Math.round(c.confidence * 100)}%, ${c.method})`,
      });
    }
    if (email.error)
      timeline.push({ at: email.updatedAt.toISOString(), event: 'Failed', detail: email.error });
    if (email.extraction?.completedAt) {
      const x = email.extraction;
      timeline.push({
        at: x.completedAt!.toISOString(),
        event: 'Extracted',
        detail: `${x.orderCount} order(s), ${x.lineCount} line(s)${x.issueCount ? `, ${x.issueCount} issue(s)` : ''}`,
      });
    }

    const body: EmailDetailDto = {
      ...listItem(email),
      to: email.to,
      cc: email.cc,
      text: email.text,
      html: email.html ?? null,
      messageId: email.messageId ?? null,
      mailbox: mailbox
        ? { id: mailbox._id.toString(), type: mailbox.type, address: mailbox.address }
        : null,
      attachments: await Promise.all(
        attachments.map(async (a) => ({
          id: a._id.toString(),
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
          kind: a.kind,
          isInline: a.isInline,
          url: await deps.storage.signedUrl(a.storageKey, {
            filename: a.filename,
            contentType: a.mimeType,
            expiresInSec: 1800,
          }),
        })),
      ),
      rawUrl: await deps.storage.signedUrl(email.rawStorageKey, {
        filename: 'message.eml',
        contentType: 'message/rfc822',
        disposition: 'attachment',
      }),
      timeline: timeline.sort((a, b) => a.at.localeCompare(b.at)),
      extractions: extractions.map(extractionDto),
    };
    res.json(body);
  });

  // Reviewers drag and drop .eml files or order documents (PDF, spreadsheet, photo).
  r.post(
    '/upload',
    requireRole('reviewer'),
    upload.array('files', MAX_UPLOAD_FILES),
    async (req, res) => {
      const { orgId, user } = authed(req);
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (!files.length) throw badRequest('Choose at least one file', 'NO_FILE');
      const results = [];
      for (const f of files) {
        if (/\.msg$/i.test(f.originalname)) {
          results.push({
            filename: f.originalname,
            error:
              'Outlook .msg files are not supported yet - save the email as .eml, or forward it',
          });
          continue;
        }
        const isEml = /\.eml$/i.test(f.originalname) || f.mimetype === 'message/rfc822';
        const kind = attachmentKind(f.originalname, f.mimetype);
        if (!isEml && !['pdf', 'image', 'spreadsheet', 'csv', 'document'].includes(kind)) {
          results.push({
            filename: f.originalname,
            error: 'Unsupported file type (use .eml, PDF, Excel, CSV or an image)',
          });
          continue;
        }
        const { email, duplicate } = isEml
          ? await receiveRawEmail(deps, {
              orgId,
              source: 'upload',
              raw: f.buffer,
              uploadedBy: user._id,
            })
          : await receiveUploadedDocument(deps, {
              orgId,
              user,
              filename: f.originalname,
              contentType: f.mimetype,
              content: f.buffer,
            });
        results.push({ filename: f.originalname, emailId: email._id.toString(), duplicate });
      }
      res.status(201).json({ results });
    },
  );

  r.post('/:id/reclassify', requireRole('reviewer'), async (req, res) => {
    const { orgId, user } = authed(req);
    const { label } = validate(reclassifySchema, req.body);
    const email = await InboundEmail.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!email) throw notFound('Email not found');
    const before = email.classification?.label ?? null;
    const c: Classification = {
      label,
      confidence: 1,
      method: 'manual',
      reasons: [`Set by ${user.name}`],
      classifiedAt: new Date(),
      classifiedBy: user._id,
    };
    email.classification = c;
    email.classificationHistory.push(c);
    if (email.status !== 'failed') email.status = 'classified';
    await email.save();
    await audit({
      orgId,
      action: 'email.reclassified',
      entity: { type: 'email', id: email._id.toString() },
      summary: { before, after: label },
      req,
    });
    // A reviewer saying "this is an order" is the "convert to order" action.
    if (label === 'new_order' && before !== 'new_order' && email.status !== 'failed') {
      await queueExtraction(deps.queue, { orgId: orgId.toString(), emailId: email._id.toString() });
    }
    res.json(listItem(email));
  });

  r.post('/:id/extract', requireRole('reviewer'), async (req, res) => {
    const { orgId } = authed(req);
    const email = await InboundEmail.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!email) throw notFound('Email not found');
    if (email.status !== 'classified')
      throw badRequest('This email has not been read yet', 'NOT_READY');
    email.extraction = {
      status: 'running',
      orderCount: 0,
      lineCount: 0,
      issueCount: 0,
      costUsd: 0,
    };
    await email.save();
    await queueExtraction(deps.queue, { orgId: orgId.toString(), emailId: email._id.toString() });
    await audit({
      orgId,
      action: 'email.reextracted',
      entity: { type: 'email', id: email._id.toString() },
      req,
    });
    res.json(listItem(email));
  });

  r.post('/:id/reprocess', requireRole('admin'), async (req, res) => {
    const { orgId } = authed(req);
    const email = await InboundEmail.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!email) throw notFound('Email not found');
    email.status = 'received';
    email.error = undefined;
    await email.save();
    await deps.queue.add(
      'process-email',
      { orgId: orgId.toString(), emailId: email._id.toString() },
      { uniqueKey: `process-email:${email._id}`, reset: true },
    );
    await audit({
      orgId,
      action: 'email.reprocessed',
      entity: { type: 'email', id: email._id.toString() },
      req,
    });
    res.json(listItem(email));
  });

  return r;
}

/** "Processing errors": jobs that failed for good. Admin only. */
export function processingErrorsRouter(deps: IngestDeps): Router {
  const r = Router();
  r.use(requireRole('admin'));

  r.get('/', async (req, res) => {
    const { orgId } = authed(req);
    const rows = await ErrorLog.find({ orgId, status: 'open' }).sort({ createdAt: -1 }).limit(100);
    const items: ProcessingErrorDto[] = rows.map((e) => ({
      id: e._id.toString(),
      jobName: e.jobName,
      entity: e.entity?.id ? { type: e.entity.type, id: e.entity.id } : null,
      message: e.message,
      attempts: e.attempts,
      status: e.status,
      createdAt: e.createdAt.toISOString(),
    }));
    res.json({ items });
  });

  r.post('/:id/retry', async (req, res) => {
    const { orgId } = authed(req);
    const entry = await ErrorLog.findOne({
      _id: objectId(param(req, 'id')),
      orgId,
      status: 'open',
    });
    if (!entry) throw notFound('Error not found');
    const data = { ...entry.data, orgId: orgId.toString() } as never;
    const key = entry.entity?.id ? `${entry.jobName}:${entry.entity.id}` : undefined;
    await deps.queue.add(entry.jobName as JobName, data, { uniqueKey: key, reset: true });
    entry.status = 'retried';
    entry.resolvedAt = new Date();
    await entry.save();
    await audit({
      orgId,
      action: 'job.retried',
      entity: { type: 'job', id: entry._id.toString() },
      summary: { jobName: entry.jobName },
      req,
    });
    res.json({ ok: true });
  });

  r.post('/:id/dismiss', async (req, res) => {
    const { orgId } = authed(req);
    const entry = await ErrorLog.findOneAndUpdate(
      { _id: objectId(param(req, 'id')), orgId, status: 'open' },
      { status: 'dismissed', resolvedAt: new Date() },
    );
    if (!entry) throw notFound('Error not found');
    res.json({ ok: true });
  });

  return r;
}
