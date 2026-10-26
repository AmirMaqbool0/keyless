import { Types } from 'mongoose';
import type { EmailClassification } from '@keyless/shared';
import { logger } from '../lib/logger';
import { partCodeKey } from '../lib/normalise';
import { findPoNumber } from '../llm/ruleExtractor';
import { Extraction } from '../models/Extraction';
import { InboundEmail, type InboundEmailDoc } from '../models/InboundEmail';
import { Order, type IOrder, type OrderDoc } from '../models/Order';
import { Organization, type IOrganization } from '../models/Organization';
import { PermanentJobError } from '../queue/types';
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
    message: (e) => `The document could not be read${e ? `: ${e}` : ''}`,
  },
  empty: { code: 'no_order_found', message: () => 'No purchase order was found in this document' },
};

/** Job: build routed orders from an email's extractions. Never touches orders past review. */
export async function buildOrdersForEmail(data: { orgId: string; emailId: string }): Promise<void> {
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
  await Order.deleteMany({ orgId, emailId: email._id, status: { $in: REVIEWABLE } });

  const [org, extractions, index] = await Promise.all([
    Organization.findOne({ _id: orgId }),
    Extraction.find({ orgId, emailId: email._id }).sort({ createdAt: 1 }),
    loadCatalogueIndex(orgId),
  ]);
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

  for (const x of extractions) {
    if (x.status !== 'completed' || !x.orders.length) {
      // Unreadable or empty documents still go in the queue (red), so nobody loses an order.
      const kind = UNREADABLE[x.status === 'completed' ? 'empty' : x.status]!;
      const cm = identifyCustomer(index, {
        fromAddress: email.from?.address,
        emailText: email.text,
        extracted: { name: null, accountNumber: null, email: null },
      });
      const order = await Order.create({
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
      const order = await Order.create({
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
        status: draft.status,
        colour: draft.colour,
        confidence: draft.confidence,
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
        idempotencyKey: cm.customer && key ? `${orgId}:${cm.customer.id}:${key}:1` : undefined,
      });
      created.push(order._id);
    }
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
  const index = await loadCatalogueIndex(email.orgId);
  const cm = identifyCustomer(index, {
    fromAddress: email.from?.address,
    emailText: email.text,
    extracted: { name: null, accountNumber: null, email: null },
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
