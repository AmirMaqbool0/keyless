import { Router } from 'express';
import { Types } from 'mongoose';
import {
  ORDER_VIEWS,
  orderListQuerySchema,
  type OrderCounts,
  type OrderDetailDto,
  type OrderListItemDto,
  type OrderView,
  type Paginated,
  type RouteColour,
} from '@keyless/shared';
import { audit } from '@keyless/core/lib/audit';
import { badRequest, notFound, param, validate } from '@keyless/core/lib/http';
import { escapeRegex } from '@keyless/core/lib/normalise';
import type { Storage } from '@keyless/core/lib/storage';
import { REVIEWABLE } from '@keyless/core/matching/route';
import { Attachment } from '@keyless/core/models/Attachment';
import { InboundEmail } from '@keyless/core/models/InboundEmail';
import { Order, type IOrder } from '@keyless/core/models/Order';
import type { JobQueue } from '@keyless/core/queue/types';
import { authed, requireRole } from '../../middleware/auth';
import { objectId } from '../shared';

const ISSUE_RANK = { error: 0, warning: 1, info: 2 } as const;

function listItem(o: IOrder): OrderListItemDto {
  const open = o.issues
    .filter((i) => !i.resolved && i.severity !== 'info')
    .sort(
      (a, b) =>
        Number(b.blocking) - Number(a.blocking) || ISSUE_RANK[a.severity] - ISSUE_RANK[b.severity],
    );
  return {
    id: o._id.toString(),
    status: o.status,
    colour: o.colour,
    confidence: o.confidence,
    poNumber: o.poNumber ?? null,
    customer: {
      id: o.customerId?.toString() ?? null,
      name: o.customerMatch.name ?? null,
      accountCode: o.customerMatch.accountCode ?? null,
    },
    lineCount: o.lines.length,
    value: o.value ?? null,
    currency: o.currency,
    receivedAt: o.receivedAt.toISOString(),
    emailId: o.emailId.toString(),
    issueCount: open.length,
    topIssue: open[0]?.message ?? null,
  };
}

/** Mounted behind requireAuth + requireVerified. */
export function ordersRouter(deps: { storage: Storage; queue: JobQueue }): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const { orgId } = authed(req);
    const q = validate(orderListQuerySchema, req.query);
    const search = q.q ? new RegExp(escapeRegex(q.q), 'i') : null;
    const filter = {
      orgId,
      status: { $in: [...ORDER_VIEWS[q.view]] },
      ...(q.colour ? { colour: q.colour } : {}),
      ...(q.customerId && Types.ObjectId.isValid(q.customerId)
        ? { customerId: new Types.ObjectId(q.customerId) }
        : {}),
      ...(search
        ? {
            $or: [
              { poNumber: search },
              { 'customerMatch.name': search },
              { 'customerMatch.accountCode': search },
            ],
          }
        : {}),
    };
    // Oldest first in the work queues (first in, first out); newest first elsewhere.
    const oldestFirst = q.view === 'needs_review' || q.view === 'ready' || q.view === 'on_hold';
    const [rows, total] = await Promise.all([
      Order.find(filter, { 'lines.candidates': 0 })
        .sort({ receivedAt: oldestFirst ? 1 : -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize),
      Order.countDocuments(filter),
    ]);
    const body: Paginated<OrderListItemDto> = {
      items: rows.map(listItem),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
    res.json(body);
  });

  r.get('/counts', async (req, res) => {
    const { orgId } = authed(req);
    const rows = await Order.aggregate<{ _id: { status: string; colour: RouteColour }; n: number }>(
      [
        { $match: { orgId } },
        { $group: { _id: { status: '$status', colour: '$colour' }, n: { $sum: 1 } } },
      ],
    );
    const counts: OrderCounts = {
      needs_review: 0,
      ready: 0,
      on_hold: 0,
      pushed: 0,
      failed: 0,
      all: 0,
      byColour: { green: 0, amber: 0, red: 0 },
    };
    for (const row of rows) {
      for (const [view, statuses] of Object.entries(ORDER_VIEWS) as [
        OrderView,
        readonly string[],
      ][]) {
        if (statuses.includes(row._id.status)) counts[view] += row.n;
      }
      if ((REVIEWABLE as string[]).includes(row._id.status))
        counts.byColour[row._id.colour] += row.n;
    }
    res.json(counts);
  });

  r.get('/:id', async (req, res) => {
    const { orgId } = authed(req);
    const order = await Order.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!order) throw notFound('Order not found');
    const [email, attachment, related] = await Promise.all([
      InboundEmail.findOne({ _id: order.emailId, orgId }, { subject: 1, from: 1 }),
      order.attachmentId ? Attachment.findOne({ _id: order.attachmentId, orgId }) : null,
      order.relatedEmails.length
        ? InboundEmail.find(
            { orgId, _id: { $in: order.relatedEmails.map((x) => x.emailId) } },
            { subject: 1 },
          )
        : [],
    ]);
    const subjects = new Map(related.map((e) => [e._id.toString(), e.subject]));
    const a = order.deliveryAddress;
    const body: OrderDetailDto = {
      ...listItem(order),
      orderDate: order.orderDate ?? null,
      requestedDeliveryDate: order.requestedDeliveryDate ?? null,
      deliveryAddress: {
        line1: a.line1 ?? null,
        line2: a.line2 ?? null,
        city: a.city ?? null,
        postcode: a.postcode ?? null,
        country: a.country ?? null,
      },
      notes: order.notes ?? null,
      customerMatch: {
        customerId: order.customerMatch.customerId?.toString() ?? null,
        name: order.customerMatch.name ?? null,
        accountCode: order.customerMatch.accountCode ?? null,
        method: order.customerMatch.method,
        confidence: order.customerMatch.confidence,
        candidates: order.customerMatch.candidates.map((c) => ({
          customerId: c.customerId.toString(),
          name: c.name,
          accountCode: c.accountCode,
          score: c.score,
        })),
      },
      documentTotals: {
        subtotal: order.documentTotals.subtotal ?? null,
        tax: order.documentTotals.tax ?? null,
        total: order.documentTotals.total ?? null,
      },
      lines: order.lines.map((l) => ({
        id: l._id.toString(),
        lineNo: l.lineNo,
        customerPartCode: l.customerPartCode ?? null,
        description: l.description ?? null,
        quantity: l.quantity ?? null,
        unit: l.unit ?? null,
        unitPrice: l.unitPrice ?? null,
        lineTotal: l.lineTotal ?? null,
        match: {
          productId: l.productId?.toString() ?? null,
          sku: l.sku ?? null,
          description: l.productDescription ?? null,
          method: l.matchMethod,
          confidence: l.matchConfidence,
          candidates: l.candidates.map((c) => ({
            productId: c.productId.toString(),
            sku: c.sku,
            description: c.description,
            score: c.score,
          })),
        },
        convertedQuantity: l.convertedQuantity ?? null,
        uom: l.uom ?? null,
        conversionFactor: l.conversionFactor,
        expectedPrice: l.expectedPrice ?? null,
        priceSource: l.priceSource ?? null,
        stockQty: l.stockQty ?? null,
        colour: l.colour,
        extractionConfidence: l.extractionConfidence,
        edited: l.edited,
      })),
      issues: order.issues.map((i) => ({
        id: i._id.toString(),
        code: i.code,
        severity: i.severity,
        blocking: i.blocking,
        message: i.message,
        lineNo: i.lineNo ?? null,
        resolved: i.resolved,
      })),
      source: {
        label: order.sourceLabel,
        extractionId: order.extractionId?.toString() ?? null,
        attachmentId: order.attachmentId?.toString() ?? null,
        attachmentUrl: attachment
          ? await deps.storage.signedUrl(attachment.storageKey, {
              filename: attachment.filename,
              contentType: attachment.mimeType,
              expiresInSec: 1800,
            })
          : null,
        mimeType: attachment?.mimeType ?? null,
      },
      email: {
        id: order.emailId.toString(),
        subject: email?.subject ?? '',
        from: email?.from?.address ?? null,
      },
      relatedEmails: order.relatedEmails.map((x) => ({
        emailId: x.emailId.toString(),
        kind: x.kind,
        receivedAt: x.receivedAt.toISOString(),
        subject: subjects.get(x.emailId.toString()) ?? '',
      })),
      timings: {
        receivedAt: order.receivedAt.toISOString(),
        extractedAt: order.extractedAt?.toISOString() ?? null,
        routedAt: order.routedAt?.toISOString() ?? null,
        approvedAt: order.approvedAt?.toISOString() ?? null,
        pushedAt: order.pushedAt?.toISOString() ?? null,
      },
      version: order.version,
    };
    res.json(body);
  });

  // Re-run matching and routing from the stored extraction, e.g. after importing more products.
  r.post('/:id/rematch', requireRole('reviewer'), async (req, res) => {
    const { orgId } = authed(req);
    const order = await Order.findOne(
      { _id: objectId(param(req, 'id')), orgId },
      { status: 1, emailId: 1, 'lines.edited': 1 },
    );
    if (!order) throw notFound('Order not found');
    if (!REVIEWABLE.includes(order.status))
      throw badRequest('This order has already been approved', 'NOT_REVIEWABLE');
    if (order.lines.some((l) => l.edited))
      throw badRequest('This order has been edited; re-matching would lose the edits', 'EDITED');
    await deps.queue.add(
      'build-orders',
      { orgId: orgId.toString(), emailId: order.emailId.toString() },
      { uniqueKey: `build-orders:${order.emailId}`, reset: true },
    );
    await audit({
      orgId,
      action: 'order.rematched',
      entity: { type: 'order', id: order._id.toString() },
      req,
    });
    res.json({ queued: true, emailId: order.emailId.toString() });
  });

  return r;
}
