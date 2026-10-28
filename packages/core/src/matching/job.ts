import { Types } from 'mongoose';
import type { EmailClassification } from '@keyless/shared';
import { logger } from '../lib/logger';
import { partCodeKey } from '../lib/normalise';
import { findPoNumber } from '../llm/ruleExtractor';
import { Extraction } from '../models/Extraction';
import { InboundEmail, type InboundEmailDoc } from '../models/InboundEmail';
import { Order, type IOrder, type OrderDoc } from '../models/Order';
import { Organization, type IOrganization } from '../models/Organization';
import { User } from '../models/User';
import { Mailbox } from '../models/Mailbox';
import { isPublicDomain } from './catalogue';
import { PermanentJobError } from '../queue/types';
import type { Storage } from '../lib/storage';
import type { FetchLike } from '../mailboxes/oauth';
import { evaluateOrderRules } from '../rules/evaluator';
import { buildOrderDraft, type IssueDraft } from './build';
import { loadCatalogueIndex } from './loader';
import { identifyCustomer, type CustomerMatch } from './match';
import { DEFAULT_ROUTING, REVIEWABLE, routeOrder, type RoutingSettings } from './route';

export const poKey = (po: string | null | undefined) =>
  po ? partCodeKey(po) || undefined : undefined;

export function routingSettings(org: Pick<IOrganization, 'settings'> | null): RoutingSettings {
  const s = org?.settings;
  return {
    greenConfidenceThreshold:
      s?.greenConfidenceThreshold ?? DEFAULT_ROUTING.greenConfidenceThreshold,
    amberConfidenceThreshold:
      s?.amberConfidenceThreshold ?? DEFAULT_ROUTING.amberConfidenceThreshold,
    priceTolerancePct: s?.priceTolerancePct ?? DEFAULT_ROUTING.priceTolerancePct,
    highValueThreshold: s?.highValueThreshold ?? DEFAULT_ROUTING.highValueThreshold,
    codeDescriptionMismatchThreshold:
      s?.codeDescriptionMismatchThreshold ?? DEFAULT_ROUTING.codeDescriptionMismatchThreshold,
  };
}

function customerFields(cm: CustomerMatch): Pick<IOrder, 'customerId' | 'customerMatch'> {
  const id = cm.customer ? new Types.ObjectId(cm.customer.id) : undefined;
  return {
    customerId: id,
    customerMatch: {
      customerId: id,
      name: cm.customer?.name ?? null,
      accountCode: cm.customer?.accountCode ?? null,
      method: cm.method,
      confidence: cm.confidence,
      candidates: cm.candidates.map((c) => ({
        customerId: new Types.ObjectId(c.customer.id),
        name: c.customer.name,
        accountCode: c.customer.accountCode,
        score: Math.round(c.score * 100) / 100,
      })),
    },
  };
}

const UNREADABLE: Record<string, { code: string; message: (error?: string) => string }> = {
  needs_llm: {
    code: 'needs_vision',
    message: () =>
      'This is a scan or photo. Reading it needs an AI model with vision (set LLM_PROVIDER=anthropic), or enter the order by hand.',
  },
  failed: {
    code: 'unreadable_document',
    message: () =>
      "We couldn't read this document fully. Please check the lines against the original.",
  },
  empty: { code: 'no_order_found', message: () => 'No purchase order was found in this document' },
};

/** Job: build routed orders from an email's extractions. Never touches orders past review. */
export async function buildOrdersForEmail(
  data: { orgId: string; emailId: string },
  deps?: { storage?: Storage; fetch?: FetchLike },
): Promise<void> {
  const orgId = new Types.ObjectId(data.orgId);
  const email = await InboundEmail.findOne({ _id: data.emailId, orgId });
  if (!email) throw new PermanentJobError(`Email ${data.emailId} not found`);

  const existing = await Order.find(
    { orgId, emailId: email._id },
    { status: 1, 'lines.edited': 1 },
  );
  if (existing.some((o) => !REVIEWABLE.includes(o.status) || o.lines.some((l) => l.edited))) {
    logger.info({ emailId: data.emailId }, 'Orders already approved or edited; not rebuilding');
    return;
  }
  const existingReviewable = await Order.find({
    orgId,
    emailId: email._id,
    status: { $in: REVIEWABLE },
  }).sort({ sourceIndex: 1, createdAt: 1 });
  let existingOrderIdx = 0;

  const persistOrder = async (
    orderData: Record<string, unknown>,
  ): Promise<OrderDoc> => {
    if (existingOrderIdx < existingReviewable.length) {
      const existingDoc = existingReviewable[existingOrderIdx++]!;
      const nextVersion = (existingDoc.version || 0) + 1;
      existingDoc.set({
        ...orderData,
        version: nextVersion,
        updatedAt: new Date(),
      });
      await existingDoc.save();
      return existingDoc;
    } else {
      const newDoc = await Order.create({
        ...orderData,
        version: 1,
      });
      return newDoc;
    }
  };

  const [org, extractions, index, users, mailboxes] = await Promise.all([
    Organization.findOne({ _id: orgId }),
    Extraction.find({ orgId, emailId: email._id }).sort({ createdAt: 1 }),
    loadCatalogueIndex(orgId),
    User.find({ orgId }, { email: 1 }),
    Mailbox.find({ orgId }, { address: 1 }),
  ]);
  const internalDomains = new Set<string>();
  for (const u of users) {
    const d = u.email.split('@')[1]?.toLowerCase();
    if (d && !isPublicDomain(d)) internalDomains.add(d);
  }
  for (const m of mailboxes) {
    const d = m.address.split('@')[1]?.toLowerCase();
    if (d) internalDomains.add(d);
  }
  internalDomains.add('keyless.local');

  const settings = routingSettings(org);
  const now = new Date();
  const created: Types.ObjectId[] = [];
  const base = (
    sourceLabel: string,
    extractionId: Types.ObjectId,
    attachmentId?: Types.ObjectId,
  ) => ({
    orgId,
    emailId: email._id,
    extractionId,
    attachmentId,
    sourceLabel,
    receivedAt: email.receivedAt,
    extractedAt: email.extraction?.completedAt,
    routedAt: now,
    currency: org?.currency ?? 'GBP',
  });

  // P2-6: Non-PO document with 0 lines. When extraction finds no order lines, the email
  // should go to "Other emails" (not_order), not create an on-hold order.
  const totalCompletedLines = extractions
    .filter((x) => x.status === 'completed')
    .flatMap((x) => x.orders)
    .reduce((sum, o) => sum + (o.lines?.length ?? 0), 0);

  if (extractions.length > 0 && extractions.every((x) => x.status === 'completed') && totalCompletedLines === 0) {
    if (email.classification?.label === 'new_order') {
      const notOrderClassification = {
        label: 'not_order' as const,
        confidence: 0.9,
        method: 'heuristic' as const,
        reasons: ['No purchase order lines found in document'],
        classifiedAt: new Date(),
      };
      email.classification = notOrderClassification;
      email.classificationHistory.push(notOrderClassification);
      await email.save();
    }
    await Order.deleteMany({ orgId, emailId: email._id, status: { $in: REVIEWABLE } });
    return;
  }

  for (const x of extractions) {
    if (x.status === 'completed' && (!x.orders.length || x.orders.every((o) => !o.lines || o.lines.length === 0))) {
      // Skip creating 0-line empty orders for non-order documents
      continue;
    }

    if (x.status !== 'completed' || !x.orders.length) {
      // Unreadable documents (e.g. needs_llm / vision) still go in the queue (red), so nobody loses an order.
      const kind = UNREADABLE[x.status] ?? UNREADABLE.failed!;
      const cm = identifyCustomer(index, {
        fromAddress: email.from?.address,
        emailText: email.text,
        extracted: { name: null, accountNumber: null, email: null },
        isUpload: email.source === 'upload',
        orgInternalDomains: internalDomains,
      });
      const order = await persistOrder({
        ...base(x.source.label, x._id, x.attachmentId),
        ...customerFields(cm),
        status: 'on_hold',
        colour: 'red',
        confidence: 0,
        extractionConfidence: 0,
        issues: [
          { code: kind.code, severity: 'error', blocking: true, message: kind.message(x.error) },
        ],
      });
      created.push(order._id);
      continue;
    }

    for (const [i, extracted] of x.orders.entries()) {
      const cm = identifyCustomer(index, {
        fromAddress: email.from?.address,
        emailText: email.text,
        extracted: extracted.customer,
        deliveryAddress: extracted.deliveryAddress,
        isUpload: email.source === 'upload',
        orgInternalDomains: internalDomains,
      });
      const key = poKey(extracted.poNumber);
      const isDuplicate = Boolean(
        cm.customer &&
        key &&
        (await Order.exists({
          orgId,
          customerId: new Types.ObjectId(cm.customer.id),
          poKey: key,
          emailId: { $ne: email._id },
          status: { $ne: 'rejected' },
        })),
      );
      const draft = buildOrderDraft(index, {
        extracted,
        customerMatch: cm,
        isDuplicate,
        settings,
        now,
      });
      const order = await persistOrder({
        ...base(x.source.label, x._id, x.attachmentId),
        sourceIndex: i,
        ...customerFields(cm),
        poNumber: extracted.poNumber ?? undefined,
        poKey: key,
        orderDate: extracted.orderDate ?? undefined,
        requestedDeliveryDate: extracted.requestedDeliveryDate ?? undefined,
        deliveryAddress: Object.fromEntries(
          Object.entries(extracted.deliveryAddress).filter(([, v]) => v !== null),
        ),
        notes: extracted.notes ?? undefined,
        currency: extracted.currency ?? org?.currency ?? 'GBP',
        documentTotals: Object.fromEntries(
          Object.entries(extracted.documentTotals).filter(([, v]) => v !== null),
        ),
        value: draft.value,
        valueEstimated: draft.valueEstimated,
        expectedValue: draft.expectedValue,
        status: draft.status,
        colour: draft.colour,
        confidence: draft.confidence,
        confidenceHint: draft.confidenceHint ?? undefined,
        extractionConfidence: extracted.confidence,
        lines: draft.lines.map((l) => ({
          ...l,
          productId: l.productId ? new Types.ObjectId(l.productId) : undefined,
          candidates: l.candidates.map((c) => ({
            ...c,
            productId: new Types.ObjectId(c.productId),
          })),
        })),
        issues: draft.issues,
        idempotencyKey: cm.customer && key ? `${orgId}:${cm.customer.id}:${key}` : undefined,
      });
      created.push(order._id);
      await evaluateOrderRules(deps ?? {}, order, orgId);
    }
  }

  if (existingOrderIdx < existingReviewable.length) {
    const surplusIds = existingReviewable.slice(existingOrderIdx).map((o) => o._id);
    await Order.deleteMany({ orgId, _id: { $in: surplusIds } });
  }

  email.orderIds = created;
  await email.save();
}

/** Re-apply routing to a stored order (after an issue was added or resolved, or a line edited). */
export function rerouteOrder(order: OrderDoc, settings: RoutingSettings): void {
  if (!REVIEWABLE.includes(order.status)) return;
  const r = routeOrder({
    lines: order.lines.map((l) => ({
      lineNo: l.lineNo,
      matchConfidence: l.matchConfidence,
      quantity: l.quantity,
      sku: l.sku,
    })),
    issues: order.issues,
    customerConfidence: order.customerMatch.confidence,
    extractionConfidence: order.extractionConfidence,
    settings,
  });
  r.lineColours.forEach((c, i) => (order.lines[i]!.colour = c));
  order.colour = r.colour;
  order.status = r.status;
  order.confidence = r.confidence;
  order.confidenceHint = r.confidenceHint ?? undefined;
  order.routedAt = new Date();
}

/**
 * An amendment or cancellation: find the order it refers to (PO number, then the sender's
 * customer) and attach it as a review task (spec section 5). Cancellations block the order.
 */
export async function linkChangeEmail(
  email: InboundEmailDoc,
  label: Extract<EmailClassification, 'amendment' | 'cancellation'>,
): Promise<OrderDoc | null> {
  const po = findPoNumber(`${email.subject}\n${email.text.slice(0, 3000)}`);
  const note = (reason: string) => {
    if (email.classification && !email.classification.reasons.includes(reason))
      email.classification.reasons.push(reason);
  };
  if (!po) {
    note('No PO number found to link it to an order');
    await email.save();
    return null;
  }
  const [index, users, mailboxes] = await Promise.all([
    loadCatalogueIndex(email.orgId),
    User.find({ orgId: email.orgId }, { email: 1 }),
    Mailbox.find({ orgId: email.orgId }, { address: 1 }),
  ]);
  const internalDomains = new Set<string>();
  for (const u of users) {
    const d = u.email.split('@')[1]?.toLowerCase();
    if (d && !isPublicDomain(d)) internalDomains.add(d);
  }
  for (const m of mailboxes) {
    const d = m.address.split('@')[1]?.toLowerCase();
    if (d) internalDomains.add(d);
  }
  internalDomains.add('keyless.local');

  const cm = identifyCustomer(index, {
    fromAddress: email.from?.address,
    emailText: email.text,
    extracted: { name: null, accountNumber: null, email: null },
    isUpload: email.source === 'upload',
    orgInternalDomains: internalDomains,
  });
  const order = await Order.findOne({
    orgId: email.orgId,
    poKey: poKey(po),
    emailId: { $ne: email._id },
    ...(cm.customer ? { customerId: new Types.ObjectId(cm.customer.id) } : {}),
  }).sort({ receivedAt: -1 });
  if (!order) {
    note(`No order with PO ${po} found yet`);
    await email.save();
    return null;
  }

  if (!order.relatedEmails.some((r) => r.emailId.equals(email._id))) {
    order.relatedEmails.push({ emailId: email._id, kind: label, receivedAt: email.receivedAt });
    const when = email.receivedAt.toLocaleDateString('en-GB');
    const reviewable = REVIEWABLE.includes(order.status);
    const issue: Omit<IssueDraft, 'lineNo'> =
      label === 'cancellation'
        ? {
            code: 'cancellation_received',
            severity: 'error',
            blocking: reviewable,
            message: `The customer asked to cancel this order on ${when}${reviewable ? '' : ' - it has already been approved: cancel it in your system'}`,
          }
        : {
            code: 'amendment_received',
            severity: 'warning',
            blocking: false,
            message: `An amendment arrived on ${when} ("${email.subject}") - apply the changes${reviewable ? '' : ' in your system (already approved)'}`,
          };
    order.issues.push({ ...issue, resolved: false } as never);
    const org = await Organization.findOne({ _id: email.orgId });
    rerouteOrder(order, routingSettings(org));
    await order.save();
  }
  note(`Linked to order PO ${order.poNumber}`);
  email.relatedOrderIds = [
    ...new Set([...email.relatedOrderIds.map(String), order._id.toString()]),
  ].map((id) => new Types.ObjectId(id));
  await email.save();
  return order;
}
