import { Router } from 'express';
import { Types } from 'mongoose';
import {
  ORDER_VIEWS,
  computeOrderValue,
  createDraftSchema,
  orderListQuerySchema,
  rejectOrderSchema,
  updateDraftSchema,
  updateOrderSchema,
  type CorrectionDto,
  type OrderCounts,
  type OrderDetailDto,
  type OrderListItemDto,
  type OrderView,
  type OutboundEmailDto,
  type Paginated,
  type RouteColour,
} from '@keyless/shared';
import { executeOrderPush } from '@keyless/core/connectors/pushJob';
import { generateAcknowledgmentDraft, generateClarificationDraft } from '@keyless/core/emails/generator';
import { queueExtraction } from '@keyless/core/ingestion/process';
import { audit } from '@keyless/core/lib/audit';
import { badRequest, notFound, param, validate } from '@keyless/core/lib/http';
import {
  descriptionKey,
  escapeRegex,
  partCodeKey,
  searchText,
  skuKey,
} from '@keyless/core/lib/normalise';
import type { Storage } from '@keyless/core/lib/storage';
import { loadCatalogueIndex } from '@keyless/core/matching/loader';
import { revalidateOrder } from '@keyless/core/matching/revalidate';
import { DEFAULT_ROUTING, REVIEWABLE } from '@keyless/core/matching/route';
import { Attachment } from '@keyless/core/models/Attachment';
import { Correction } from '@keyless/core/models/Correction';
import { CrossReference } from '@keyless/core/models/CrossReference';
import { Customer } from '@keyless/core/models/Customer';
import { InboundEmail } from '@keyless/core/models/InboundEmail';
import { Order, type IOrder } from '@keyless/core/models/Order';
import { Organization } from '@keyless/core/models/Organization';
import { OutboundEmail } from '@keyless/core/models/OutboundEmail';
import { Product } from '@keyless/core/models/Product';
import { User } from '@keyless/core/models/User';
import type { Mailer } from '@keyless/core/lib/mailer';
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
  const valResult = computeOrderValue(o.lines);
  const orderValue = o.value ?? valResult.value ?? null;
  const isEstimated = o.valueEstimated ?? valResult.isEstimated;
  const expectedValue = o.expectedValue ?? valResult.expectedValue ?? null;

  let confidenceHint = o.confidenceHint ?? null;
  if (!confidenceHint && o.confidence < 0.95) {
    if (!o.customerId && (!o.customerMatch?.name || o.customerMatch?.confidence === 0)) {
      confidenceHint = 'Customer unknown';
    } else if (o.lines.some((l) => !l.sku && !l.productId)) {
      confidenceHint = 'Unmatched lines';
    } else if (o.extractionConfidence < 0.7) {
      confidenceHint = 'Low read confidence';
    } else if ((o.customerMatch?.confidence ?? 0) < 0.75) {
      confidenceHint = 'Customer unverified';
    }
  }

  return {
    id: o._id.toString(),
    status: o.status,
    colour: o.colour,
    confidence: o.confidence,
    confidenceHint,
    poNumber: o.poNumber ?? null,
    customer: {
      id: o.customerId?.toString() ?? null,
      name: o.customerMatch.name ?? null,
      accountCode: o.customerMatch.accountCode ?? null,
    },
    lineCount: o.lines.length,
    value: orderValue,
    valueEstimated: isEstimated,
    expectedValue,
    currency: o.currency,
    receivedAt: o.receivedAt.toISOString(),
    emailId: o.emailId.toString(),
    issueCount: open.length,
    topIssue: open[0]?.message ?? null,
  };
}


async function safeguardStuckPushJobs(orgId: Types.ObjectId): Promise<void> {
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
  await Order.updateMany(
    {
      orgId,
      status: { $in: ['approved', 'pushing'] },
      $or: [
        { updatedAt: { $lt: fifteenMinutesAgo } },
        { approvedAt: { $lt: fifteenMinutesAgo } },
      ],
    },
    {
      $set: {
        status: 'push_failed',
        lastPushError: 'Push timed out after 15 minutes without progress',
      },
    },
  );
}

/** Mounted behind requireAuth + requireVerified. */
export function ordersRouter(deps: { storage: Storage; queue: JobQueue; mailer?: Mailer }): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const { orgId } = authed(req);
    await safeguardStuckPushJobs(orgId);
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
    await safeguardStuckPushJobs(orgId);
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
    await safeguardStuckPushJobs(orgId);
    const order = await Order.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!order) throw notFound('Order not found');
    const [email, attachment, related, approver] = await Promise.all([
      InboundEmail.findOne({ _id: order.emailId, orgId }, { subject: 1, from: 1 }),
      order.attachmentId ? Attachment.findOne({ _id: order.attachmentId, orgId }) : null,
      order.relatedEmails.length
        ? InboundEmail.find(
            { orgId, _id: { $in: order.relatedEmails.map((x) => x.emailId) } },
            { subject: 1 },
          )
        : [],
      order.approvedBy ? User.findOne({ _id: order.approvedBy, orgId }, { name: 1 }) : null,
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
        dismissedBy: i.dismissedBy?.toString() ?? null,
        dismissedAt: i.dismissedAt?.toISOString() ?? null,
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
      approvedBy: approver ? { id: approver._id.toString(), name: approver.name } : null,
      rejectionReason: order.rejectionReason ?? null,
      erpReference: order.erpReference ?? null,
      lastPushError: order.lastPushError ?? null,
      autoApproved: order.autoApproved ?? null,
      autoApprovedRuleName: order.autoApprovedRuleName ?? null,
      version: order.version,
    };
    res.json(body);
  });

  // Edit order header and/or line items (M6 review workflow and learning loop).
  r.patch('/:id', requireRole('reviewer'), async (req, res) => {
    const { orgId, user } = authed(req);
    const order = await Order.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!order) throw notFound('Order not found');
    if (!REVIEWABLE.includes(order.status)) {
      throw badRequest('This order has already been finalized', 'NOT_REVIEWABLE');
    }
    const body = validate(updateOrderSchema, req.body);
    const corrections: Array<{
      field: string;
      lineId?: Types.ObjectId;
      before: unknown;
      after: unknown;
    }> = [];

    const [catalogue, orgDoc] = await Promise.all([
      loadCatalogueIndex(orgId),
      Organization.findOne({ _id: orgId }),
    ]);

    // 1. Customer assignment
    let activeCustomer = order.customerId
      ? await Customer.findOne({ _id: order.customerId, orgId })
      : null;

    if (body.customerId !== undefined) {
      if (body.customerId === null) {
        if (order.customerId) {
          corrections.push({
            field: 'customerId',
            before: order.customerId.toString(),
            after: null,
          });
          order.customerId = undefined;
          order.customerMatch = {
            name: null,
            accountCode: null,
            method: 'manual',
            confidence: 0,
            candidates: [],
          };
          activeCustomer = null;
        }
      } else if (Types.ObjectId.isValid(body.customerId)) {
        const newCustId = new Types.ObjectId(body.customerId);
        if (!order.customerId || !order.customerId.equals(newCustId)) {
          const cust = await Customer.findOne({ _id: newCustId, orgId });
          if (!cust) throw badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
          corrections.push({
            field: 'customerId',
            before: order.customerId?.toString() ?? null,
            after: cust._id.toString(),
          });
          order.customerId = cust._id;
          order.customerMatch = {
            customerId: cust._id,
            name: cust.name,
            accountCode: cust.accountCode,
            method: 'manual',
            confidence: 1.0,
            candidates: [],
          };
          activeCustomer = cust;

          // Resolve unknown customer issues
          for (const issue of order.issues) {
            if (issue.code === 'unknown_customer' || issue.code === 'customer_name_only') {
              issue.resolved = true;
            }
          }
        }
      }
    }

    // Remember sender for customer ONLY when requested explicitly (rememberSender === true)
    // Never add domains automatically.
    if (body.rememberSender === true && activeCustomer) {
      const email = await InboundEmail.findOne({ _id: order.emailId, orgId });
      if (email?.from?.address) {
        const addr = email.from.address.toLowerCase().trim();
        let changed = false;
        if (!activeCustomer.senderAddresses.some((s) => s.toLowerCase() === addr)) {
          activeCustomer.senderAddresses.push(addr);
          changed = true;
        }
        if (changed) {
          await activeCustomer.save();
          await audit({
            orgId,
            action: 'customer.sender_learned',
            entity: { type: 'customer', id: activeCustomer._id.toString() },
            req,
          });
        }
      }
    }

    function normalizeCorrectionValue(v: unknown): string | number | null {
      if (v === null || v === undefined || v === '') return null;
      return v as string | number;
    }
    function valuesDiffer(a: unknown, b: unknown): boolean {
      return normalizeCorrectionValue(a) !== normalizeCorrectionValue(b);
    }

    // 2. Header fields
    if (body.poNumber !== undefined && valuesDiffer(order.poNumber, body.poNumber)) {
      corrections.push({
        field: 'poNumber',
        before: normalizeCorrectionValue(order.poNumber),
        after: normalizeCorrectionValue(body.poNumber),
      });
      order.poNumber = body.poNumber ?? undefined;
      order.poKey = body.poNumber ? partCodeKey(body.poNumber) : undefined;
    }
    if (body.orderDate !== undefined && valuesDiffer(order.orderDate, body.orderDate)) {
      corrections.push({
        field: 'orderDate',
        before: normalizeCorrectionValue(order.orderDate),
        after: normalizeCorrectionValue(body.orderDate),
      });
      order.orderDate = body.orderDate ?? undefined;
    }
    if (
      body.requestedDeliveryDate !== undefined &&
      valuesDiffer(order.requestedDeliveryDate, body.requestedDeliveryDate)
    ) {
      corrections.push({
        field: 'requestedDeliveryDate',
        before: normalizeCorrectionValue(order.requestedDeliveryDate),
        after: normalizeCorrectionValue(body.requestedDeliveryDate),
      });
      order.requestedDeliveryDate = body.requestedDeliveryDate ?? undefined;
    }
    if (body.notes !== undefined && valuesDiffer(order.notes, body.notes)) {
      corrections.push({
        field: 'notes',
        before: normalizeCorrectionValue(order.notes),
        after: normalizeCorrectionValue(body.notes),
      });
      order.notes = body.notes ?? undefined;
    }
    if (body.currency !== undefined && valuesDiffer(order.currency, body.currency)) {
      corrections.push({
        field: 'currency',
        before: normalizeCorrectionValue(order.currency),
        after: normalizeCorrectionValue(body.currency),
      });
      order.currency = body.currency;
    }
    if (body.deliveryAddress) {
      for (const [k, v] of Object.entries(body.deliveryAddress)) {
        const key = k as keyof typeof order.deliveryAddress;
        if (v !== undefined && valuesDiffer(order.deliveryAddress[key], v)) {
          corrections.push({
            field: `deliveryAddress.${key}`,
            before: normalizeCorrectionValue(order.deliveryAddress[key]),
            after: normalizeCorrectionValue(v),
          });
          order.deliveryAddress[key] = v ?? undefined;
        }
      }
    }

    // 3. Lines
    if (body.lines && body.lines.length > 0) {
      const catCustomer = activeCustomer
        ? catalogue.customer(activeCustomer._id.toString())
        : undefined;

      for (const lineUpdate of body.lines) {
        const line = order.lines.find((l) => l._id.toString() === lineUpdate.id);
        if (!line) continue;

        // Part code & description
        if (
          lineUpdate.customerPartCode !== undefined &&
          valuesDiffer(line.customerPartCode, lineUpdate.customerPartCode)
        ) {
          corrections.push({
            lineId: line._id,
            field: 'customerPartCode',
            before: normalizeCorrectionValue(line.customerPartCode),
            after: normalizeCorrectionValue(lineUpdate.customerPartCode),
          });
          line.customerPartCode = lineUpdate.customerPartCode ?? undefined;
          line.edited = true;
        }
        if (
          lineUpdate.description !== undefined &&
          valuesDiffer(line.description, lineUpdate.description)
        ) {
          corrections.push({
            lineId: line._id,
            field: 'description',
            before: normalizeCorrectionValue(line.description),
            after: normalizeCorrectionValue(lineUpdate.description),
          });
          line.description = lineUpdate.description ?? undefined;
          line.edited = true;
        }

        // Quantity & Unit
        if (lineUpdate.quantity !== undefined && valuesDiffer(line.quantity, lineUpdate.quantity)) {
          corrections.push({
            lineId: line._id,
            field: 'quantity',
            before: normalizeCorrectionValue(line.quantity),
            after: normalizeCorrectionValue(lineUpdate.quantity),
          });
          line.quantity = lineUpdate.quantity ?? undefined;
          line.edited = true;
        }
        if (lineUpdate.unit !== undefined && valuesDiffer(line.unit, lineUpdate.unit)) {
          corrections.push({
            lineId: line._id,
            field: 'unit',
            before: normalizeCorrectionValue(line.unit),
            after: normalizeCorrectionValue(lineUpdate.unit),
          });
          line.unit = lineUpdate.unit ?? undefined;
          line.edited = true;
        }
        if (
          lineUpdate.conversionFactor !== undefined &&
          valuesDiffer(line.conversionFactor, lineUpdate.conversionFactor)
        ) {
          corrections.push({
            lineId: line._id,
            field: 'conversionFactor',
            before: normalizeCorrectionValue(line.conversionFactor),
            after: normalizeCorrectionValue(lineUpdate.conversionFactor),
          });
          line.conversionFactor = lineUpdate.conversionFactor;
          line.edited = true;
        }
        if (line.quantity !== undefined && line.quantity !== null) {
          line.convertedQuantity = line.quantity * line.conversionFactor;
        }

        // Unit Price
        if (lineUpdate.unitPrice !== undefined && valuesDiffer(line.unitPrice, lineUpdate.unitPrice)) {
          corrections.push({
            lineId: line._id,
            field: 'unitPrice',
            before: normalizeCorrectionValue(line.unitPrice),
            after: normalizeCorrectionValue(lineUpdate.unitPrice),
          });
          line.unitPrice = lineUpdate.unitPrice ?? undefined;
          line.edited = true;
        }
        if (line.quantity !== undefined && line.unitPrice !== undefined) {
          line.lineTotal = Math.round(line.quantity * line.unitPrice * 100) / 100;
        }

        // Product / SKU selection
        let product = null;
        if (lineUpdate.productId) {
          product = catalogue.productById(lineUpdate.productId);
          if (!product && Types.ObjectId.isValid(lineUpdate.productId)) {
            const doc = await Product.findOne({ _id: lineUpdate.productId, orgId });
            if (doc) {
              product = {
                id: doc._id.toString(),
                sku: doc.sku,
                description: doc.description,
                uom: doc.uom,
                packSize: doc.packSize,
                defaultPrice: doc.defaultPrice,
                stockQty: doc.stockQty,
                active: doc.active,
              };
            }
          }
        } else if (lineUpdate.sku) {
          product = catalogue.productBySku(lineUpdate.sku);
          if (!product) {
            const doc = await Product.findOne({ skuKey: skuKey(lineUpdate.sku), orgId });
            if (doc) {
              product = {
                id: doc._id.toString(),
                sku: doc.sku,
                description: doc.description,
                uom: doc.uom,
                packSize: doc.packSize,
                defaultPrice: doc.defaultPrice,
                stockQty: doc.stockQty,
                active: doc.active,
              };
            }
          }
        }

        if (product) {
          const oldSku = line.sku;
          const oldMethod = line.matchMethod;
          if (oldSku !== product.sku || oldMethod !== 'manual') {
            corrections.push({
              lineId: line._id,
              field: 'sku',
              before: oldSku ? `${oldSku} (${oldMethod})` : null,
              after: product.sku,
            });
          }
          line.productId = new Types.ObjectId(product.id);
          line.sku = product.sku;
          line.productDescription = product.description;
          line.uom = product.uom;
          line.stockQty = product.stockQty;
          line.matchMethod = 'manual';
          line.matchConfidence = 1.0;
          line.edited = true;

          // Expected price
          const priceResult = catalogue.expectedPrice(
            catCustomer,
            product,
            line.convertedQuantity ?? line.quantity ?? 1,
            order.orderDate ? new Date(order.orderDate) : new Date(),
          );
          if (priceResult) {
            line.expectedPrice = priceResult.price;
            line.priceSource = priceResult.source;
          }

          // Resolve line-level unmatched issues
          for (const issue of order.issues) {
            if (
              issue.lineNo === line.lineNo &&
              (issue.code === 'unmatched_sku' ||
                issue.code === 'uncertain_match' ||
                issue.code === 'inactive_sku')
            ) {
              issue.resolved = true;
            }
          }

          // LEARNING LOOP (spec section 7):
          // When a reviewer confirms or corrects a match, upsert CrossReference with source 'learned'.
          if (order.customerId && (line.customerPartCode || line.description)) {
            if (line.customerPartCode) {
              const pKey = partCodeKey(line.customerPartCode);
              const mKey = `code:${pKey}`;
              await CrossReference.findOneAndUpdate(
                { orgId, customerId: order.customerId, matchKey: mKey },
                {
                  $set: {
                    customerPartCode: line.customerPartCode,
                    partCodeKey: pKey,
                    productId: line.productId,
                    sku: line.sku,
                    skuKey: skuKey(line.sku),
                    customerUom: line.unit,
                    uomFactor: line.conversionFactor || 1,
                    source: 'learned',
                    confidence: 1.0,
                    lastUsedAt: new Date(),
                    searchText: searchText(line.customerPartCode, line.description, line.sku),
                  },
                  $inc: { timesUsed: 1 },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true },
              );
            }
            if (line.description) {
              const dKey = descriptionKey(line.description);
              if (dKey.length >= 3) {
                const mKey = `desc:${dKey}`;
                await CrossReference.findOneAndUpdate(
                  { orgId, customerId: order.customerId, matchKey: mKey },
                  {
                    $set: {
                      customerDescription: line.description,
                      descriptionKey: dKey,
                      productId: line.productId,
                      sku: line.sku,
                      skuKey: skuKey(line.sku),
                      customerUom: line.unit,
                      uomFactor: line.conversionFactor || 1,
                      source: 'learned',
                      confidence: 1.0,
                      lastUsedAt: new Date(),
                      searchText: searchText(line.customerPartCode, line.description, line.sku),
                    },
                    $inc: { timesUsed: 1 },
                  },
                  { upsert: true, new: true, setDefaultsOnInsert: true },
                );
              }
            }
          }
        }
      }
    }

    // P1-2: Re-evaluate validation issues, prices, colours, and routing after edits
    revalidateOrder(order, {
      catalogue,
      settings: {
        ...DEFAULT_ROUTING,
        codeDescriptionMismatchThreshold:
          orgDoc?.settings.codeDescriptionMismatchThreshold ??
          DEFAULT_ROUTING.codeDescriptionMismatchThreshold,
        priceTolerancePct:
          orgDoc?.settings.priceTolerancePct ?? DEFAULT_ROUTING.priceTolerancePct,
        highValueThreshold:
          orgDoc?.settings.highValueThreshold ?? DEFAULT_ROUTING.highValueThreshold,
        greenConfidenceThreshold:
          orgDoc?.settings.greenConfidenceThreshold ?? DEFAULT_ROUTING.greenConfidenceThreshold,
        amberConfidenceThreshold:
          orgDoc?.settings.amberConfidenceThreshold ?? DEFAULT_ROUTING.amberConfidenceThreshold,
      },
      now: order.orderDate ? new Date(order.orderDate) : new Date(),
    });
    order.version += 1;

    await order.save();

    // Save corrections
    if (corrections.length > 0) {
      await Correction.insertMany(
        corrections.map((c) => ({
          orgId,
          orderId: order._id,
          lineId: c.lineId,
          field: c.field,
          before: c.before,
          after: c.after,
          userId: user._id,
        })),
      );
      await audit({
        orgId,
        action: 'order.edited',
        entity: { type: 'order', id: order._id.toString() },
        req,
      });
    }

    res.json({ ok: true, version: order.version, status: order.status, colour: order.colour });
  });

  // Dismiss a validation issue on an order (P1-2).
  r.post('/:id/issues/:issueId/dismiss', requireRole('reviewer'), async (req, res) => {
    const { orgId, user } = authed(req);
    const order = await Order.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!order) throw notFound('Order not found');
    if (!REVIEWABLE.includes(order.status)) {
      throw badRequest('Order is not in a reviewable state', 'NOT_REVIEWABLE');
    }
    const issueId = param(req, 'issueId');
    const target = order.issues.find((i) => i._id.toString() === issueId);
    if (!target) throw notFound('Issue not found');
    if (target.blocking) {
      throw badRequest(
        'Blocking issues cannot be dismissed without resolving the underlying problem',
        'CANNOT_DISMISS_BLOCKING',
      );
    }

    const [catalogue, orgDoc] = await Promise.all([
      loadCatalogueIndex(orgId),
      Organization.findOne({ _id: orgId }),
    ]);

    revalidateOrder(order, {
      catalogue,
      settings: {
        ...DEFAULT_ROUTING,
        codeDescriptionMismatchThreshold:
          orgDoc?.settings.codeDescriptionMismatchThreshold ??
          DEFAULT_ROUTING.codeDescriptionMismatchThreshold,
        priceTolerancePct:
          orgDoc?.settings.priceTolerancePct ?? DEFAULT_ROUTING.priceTolerancePct,
        highValueThreshold:
          orgDoc?.settings.highValueThreshold ?? DEFAULT_ROUTING.highValueThreshold,
        greenConfidenceThreshold:
          orgDoc?.settings.greenConfidenceThreshold ?? DEFAULT_ROUTING.greenConfidenceThreshold,
        amberConfidenceThreshold:
          orgDoc?.settings.amberConfidenceThreshold ?? DEFAULT_ROUTING.amberConfidenceThreshold,
      },
      now: order.orderDate ? new Date(order.orderDate) : new Date(),
      dismissedByUserId: user._id,
      dismissIssueId: issueId,
    });

    order.version += 1;
    await order.save();

    await audit({
      orgId,
      action: 'order.issue_dismissed',
      entity: { type: 'order', id: order._id.toString() },
      summary: { issueId, code: target.code },
      req,
    });

    res.json({ ok: true, version: order.version, status: order.status, colour: order.colour });
  });

  // Approve order and push to active ERP connector (M6/M7).
  r.post('/:id/approve', requireRole('reviewer'), async (req, res) => {
    const { orgId, user } = authed(req);
    const order = await Order.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!order) throw notFound('Order not found');
    if (!REVIEWABLE.includes(order.status)) {
      throw badRequest('Order is not in a reviewable state', 'NOT_REVIEWABLE');
    }
    if (!order.customerId) {
      throw badRequest('Please assign a customer before approving', 'NO_CUSTOMER');
    }

    const customer = await Customer.findOne({ _id: order.customerId, orgId });
    if (!customer) throw notFound('Customer not found');

    // Mark remaining issues resolved upon reviewer approval
    for (const issue of order.issues) {
      issue.resolved = true;
    }

    order.approvedAt = new Date();
    order.approvedBy = user._id;
    order.status = 'approved';
    order.version += 1;
    await order.save();

    await audit({
      orgId,
      action: 'order.approved',
      entity: { type: 'order', id: order._id.toString() },
      req,
    });

    // Execute push to active connector
    await executeOrderPush(deps, {
      orgId: orgId.toString(),
      orderId: order._id.toString(),
    });

    const updated = await Order.findOne({ _id: order._id, orgId });
    res.json({
      ok: true,
      status: updated?.status ?? order.status,
      erpReference: updated?.erpReference ?? null,
      lastPushError: updated?.lastPushError ?? null,
    });
  });

  // Retry pushing an approved or push_failed order to ERP (M7).
  r.post('/:id/retry-push', requireRole('reviewer'), async (req, res) => {
    const { orgId } = authed(req);
    const order = await Order.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!order) throw notFound('Order not found');
    if (!['approved', 'pushed', 'push_failed'].includes(order.status)) {
      throw badRequest('Only approved, pushed or push_failed orders can be pushed', 'INVALID_STATUS');
    }
    const result = await executeOrderPush(deps, {
      orgId: orgId.toString(),
      orderId: order._id.toString(),
    });
    const updated = await Order.findOne({ _id: order._id, orgId });
    res.json({
      ok: result.ok,
      status: updated?.status ?? order.status,
      erpReference: updated?.erpReference ?? null,
      lastPushError: updated?.lastPushError ?? null,
    });
  });

  // Put order on hold.
  r.post('/:id/hold', requireRole('reviewer'), async (req, res) => {
    const { orgId } = authed(req);
    const order = await Order.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!order) throw notFound('Order not found');
    order.status = 'on_hold';
    order.version += 1;
    await order.save();
    await audit({
      orgId,
      action: 'order.held',
      entity: { type: 'order', id: order._id.toString() },
      req,
    });
    res.json({ ok: true, status: order.status });
  });

  // Reject order with a mandatory reason.
  r.post('/:id/reject', requireRole('reviewer'), async (req, res) => {
    const { orgId } = authed(req);
    const order = await Order.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!order) throw notFound('Order not found');
    const { reason } = validate(rejectOrderSchema, req.body);
    order.status = 'rejected';
    order.rejectionReason = reason;
    order.version += 1;
    await order.save();
    await audit({
      orgId,
      action: 'order.rejected',
      entity: { type: 'order', id: order._id.toString() },
      req,
    });
    res.json({ ok: true, status: order.status });
  });

  // Return history of human corrections made to this order.
  r.get('/:id/corrections', async (req, res) => {
    const { orgId } = authed(req);
    const orderId = objectId(param(req, 'id'));
    const rows = await Correction.find({ orgId, orderId }).sort({ createdAt: -1 });
    const userIds = [...new Set(rows.map((r) => r.userId.toString()))];
    const users = await User.find(
      { orgId, _id: { $in: userIds.map((uid) => new Types.ObjectId(uid)) } },
      { name: 1, email: 1 },
    ).lean();
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    const dtos: CorrectionDto[] = rows.map((c) => {
      const u = userMap.get(c.userId.toString());
      return {
        id: c._id.toString(),
        orderId: c.orderId.toString(),
        lineId: c.lineId?.toString() ?? null,
        field: c.field,
        before: c.before,
        after: c.after,
        userId: c.userId.toString(),
        userName: u?.name ?? 'User',
        createdAt: c.createdAt.toISOString(),
      };
    });
    res.json(dtos);
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

  // Re-run extraction for a held order, e.g. after model improvements or unreadable documents.
  r.post('/:id/re-extract', requireRole('reviewer'), async (req, res) => {
    const { orgId } = authed(req);
    const order = await Order.findOne(
      { _id: objectId(param(req, 'id')), orgId },
      { status: 1, emailId: 1 },
    );
    if (!order) throw notFound('Order not found');
    if (!REVIEWABLE.includes(order.status))
      throw badRequest('This order has already been approved', 'NOT_REVIEWABLE');

    await queueExtraction(deps.queue, {
      orgId: orgId.toString(),
      emailId: order.emailId.toString(),
    });

    await audit({
      orgId,
      action: 'order.re_extracted',
      entity: { type: 'order', id: order._id.toString() },
      req,
    });
    res.json({ queued: true, emailId: order.emailId.toString() });
  });

  // Outbound email history and drafts for an order (M8)
  r.get('/:id/emails', async (req, res) => {
    const { orgId } = authed(req);
    const orderId = objectId(param(req, 'id'));
    const rows = await OutboundEmail.find({ orgId, orderId }).sort({ createdAt: -1 });
    const userIds = [...new Set(rows.map((x) => x.sentBy?.toString()).filter(Boolean))];
    const users = userIds.length
      ? await User.find(
          { orgId, _id: { $in: userIds.map((u) => new Types.ObjectId(u!)) } },
          { name: 1 },
        ).lean()
      : [];
    const userMap = new Map(users.map((u) => [u._id.toString(), u.name]));

    const dtos: OutboundEmailDto[] = rows.map((e) => ({
      id: e._id.toString(),
      orderId: e.orderId.toString(),
      type: e.type,
      to: e.to,
      subject: e.subject,
      body: e.body,
      status: e.status,
      sentAt: e.sentAt?.toISOString() ?? null,
      sentBy: e.sentBy ? { id: e.sentBy.toString(), name: userMap.get(e.sentBy.toString()) ?? 'User' } : null,
      error: e.error ?? null,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    }));
    res.json({ items: dtos });
  });

  // Draft an acknowledgment or clarification email (M8)
  r.post('/:id/emails/draft', requireRole('reviewer'), async (req, res) => {
    const { orgId } = authed(req);
    const order = await Order.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!order) throw notFound('Order not found');

    const input = validate(createDraftSchema, req.body);
    const customer = order.customerId ? await Customer.findOne({ _id: order.customerId, orgId }) : null;
    const org = await Organization.findOne({ _id: orgId });
    const inbound = await InboundEmail.findOne({ _id: order.emailId, orgId });

    let to = input.to;
    let subject = input.subject;
    let body = input.body;

    if (input.type === 'acknowledgment') {
      const gen = generateAcknowledgmentDraft(order, customer, org, inbound?.from?.address);
      to = to || gen.to;
      subject = subject || gen.subject;
      body = body || gen.body;
    } else if (input.type === 'clarification') {
      const gen = generateClarificationDraft(order, customer, org, inbound?.from?.address);
      to = to || gen.to;
      subject = subject || gen.subject;
      body = body || gen.body;
    }

    if (!to) to = inbound?.from?.address || 'customer@example.com';
    if (!subject) subject = `PO ${order.poNumber || 'Order'}`;
    if (!body) body = '';

    const outbound = await OutboundEmail.create({
      orgId,
      orderId: order._id,
      type: input.type,
      to,
      subject,
      body,
      status: 'draft',
    });

    await audit({
      orgId,
      action: 'order.email_drafted',
      entity: { type: 'order', id: order._id.toString() },
      summary: { emailId: outbound._id.toString(), type: input.type },
      req,
    });

    res.status(201).json({
      email: {
        id: outbound._id.toString(),
        orderId: outbound.orderId.toString(),
        type: outbound.type,
        to: outbound.to,
        subject: outbound.subject,
        body: outbound.body,
        status: outbound.status,
        sentAt: null,
        sentBy: null,
        error: null,
        createdAt: outbound.createdAt.toISOString(),
        updatedAt: outbound.updatedAt.toISOString(),
      },
    });
  });

  // Edit an email draft (M8)
  r.patch('/:id/emails/:emailId', requireRole('reviewer'), async (req, res) => {
    const { orgId } = authed(req);
    const orderId = objectId(param(req, 'id'));
    const emailId = objectId(param(req, 'emailId'));
    const email = await OutboundEmail.findOne({ _id: emailId, orderId, orgId });
    if (!email) throw notFound('Email draft not found');
    if (email.status === 'sent') {
      throw badRequest('Sent emails cannot be edited', 'ALREADY_SENT');
    }

    const input = validate(updateDraftSchema, req.body);
    if (input.to) email.to = input.to;
    if (input.subject) email.subject = input.subject;
    if (input.body) email.body = input.body;
    await email.save();

    res.json({
      email: {
        id: email._id.toString(),
        orderId: email.orderId.toString(),
        type: email.type,
        to: email.to,
        subject: email.subject,
        body: email.body,
        status: email.status,
        sentAt: email.sentAt?.toISOString() ?? null,
        sentBy: null,
        error: email.error ?? null,
        createdAt: email.createdAt.toISOString(),
        updatedAt: email.updatedAt.toISOString(),
      },
    });
  });

  // Send an outbound email (M8)
  r.post('/:id/emails/:emailId/send', requireRole('reviewer'), async (req, res) => {
    const { orgId, user } = authed(req);
    const orderId = objectId(param(req, 'id'));
    const emailId = objectId(param(req, 'emailId'));
    const email = await OutboundEmail.findOne({ _id: emailId, orderId, orgId });
    if (!email) throw notFound('Email not found');
    if (email.status === 'sent') {
      throw badRequest('Email has already been sent', 'ALREADY_SENT');
    }

    if (!deps.mailer) {
      throw badRequest('Email sending is not configured on this server', 'NO_MAILER');
    }

    try {
      email.status = 'sending';
      await email.save();

      await deps.mailer.send({
        to: email.to,
        subject: email.subject,
        text: email.body,
      });

      email.status = 'sent';
      email.sentAt = new Date();
      email.sentBy = user._id;
      email.error = undefined;
      await email.save();

      await audit({
        orgId,
        action: 'order.email_sent',
        entity: { type: 'order', id: orderId.toString() },
        summary: { emailId: email._id.toString(), to: email.to, type: email.type },
        req,
      });

      res.json({
        ok: true,
        email: {
          id: email._id.toString(),
          orderId: email.orderId.toString(),
          type: email.type,
          to: email.to,
          subject: email.subject,
          body: email.body,
          status: email.status,
          sentAt: email.sentAt.toISOString(),
          sentBy: { id: user._id.toString(), name: user.name },
          error: null,
          createdAt: email.createdAt.toISOString(),
          updatedAt: email.updatedAt.toISOString(),
        },
      });
    } catch (sendErr: unknown) {
      email.status = 'failed';
      email.error = (sendErr as Error)?.message || 'Send failed';
      await email.save();
      throw badRequest(`Failed to send email: ${email.error}`, 'SEND_FAILED');
    }
  });

  return r;
}
