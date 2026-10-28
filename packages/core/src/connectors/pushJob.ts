import { Types } from 'mongoose';
import { audit } from '../lib/audit';
import { logger } from '../lib/logger';
import { Connector } from '../models/Connector';
import { Customer } from '../models/Customer';
import { Order, type IOrder } from '../models/Order';
import type { JobContext } from '../queue/types';
import { createConnector, type ConnectorDeps } from './index';
import type { NormalisedOrder } from './types';

export function toNormalisedOrder(order: IOrder, customerAccountCode: string): NormalisedOrder {
  return {
    customerRef: customerAccountCode,
    poNumber: order.poNumber || 'UNKNOWN',
    orderDate: order.orderDate,
    requestedDeliveryDate: order.requestedDeliveryDate,
    currency: order.currency || 'GBP',
    deliveryAddress: order.deliveryAddress?.line1
      ? {
          line1: order.deliveryAddress.line1,
          line2: order.deliveryAddress.line2,
          city: order.deliveryAddress.city,
          postcode: order.deliveryAddress.postcode,
          country: order.deliveryAddress.country,
        }
      : undefined,
    notes: order.notes,
    lines: order.lines.map((l) => ({
      lineNo: l.lineNo,
      sku: l.sku || 'UNKNOWN',
      description: l.productDescription || l.description,
      quantity: l.convertedQuantity ?? l.quantity ?? 1,
      unitPrice: l.expectedPrice ?? l.unitPrice,
    })),
  };
}

export async function executeOrderPush(
  deps: ConnectorDeps,
  data: { orgId: string; orderId: string },
  ctx?: JobContext,
): Promise<{ ok: boolean; status: string; reference?: string }> {
  const orgId = new Types.ObjectId(data.orgId);
  const order = await Order.findOne({ _id: new Types.ObjectId(data.orderId), orgId });
  if (!order) {
    logger.warn({ data }, 'Order not found for push-order job');
    return { ok: false, status: 'not_found' };
  }

  // If already pushed, avoid duplicate work
  if (order.status === 'pushed') {
    return { ok: true, status: 'pushed', reference: order.erpReference };
  }

  if (!order.customerId) {
    order.status = 'push_failed';
    order.lastPushError = 'No customer assigned to order';
    await order.save();
    return { ok: false, status: 'push_failed' };
  }

  const customer = await Customer.findOne({ _id: order.customerId, orgId });
  if (!customer) {
    order.status = 'push_failed';
    order.lastPushError = 'Assigned customer not found';
    await order.save();
    return { ok: false, status: 'push_failed' };
  }

  // Find active connector: prefer default, or any connected connector
  const connector =
    (await Connector.findOne({ orgId, isDefault: true, status: { $ne: 'disconnected' } })) ??
    (await Connector.findOne({ orgId, status: { $ne: 'disconnected' } }));

  if (!connector) {
    logger.warn({ orgId: data.orgId }, 'No active connector configured; push failed');
    order.status = 'push_failed';
    order.lastPushError = 'No active connector';
    await order.save();
    return { ok: false, status: 'push_failed' };
  }

  order.status = 'pushing';
  await order.save();

  const impl = createConnector(connector, deps);
  const idempotencyKey = `${orgId.toString()}:${order.customerId.toString()}:${order.poNumber || 'no-po'}:v${order.version}`;

  // Check findExistingOrder first
  if (impl.findExistingOrder) {
    try {
      const existing = await impl.findExistingOrder(customer.accountCode, order.poNumber || '');
      if (existing) {
        order.status = 'pushed';
        order.pushedAt = new Date();
        order.erpReference = existing.reference;
        order.lastPushError = undefined;
        await order.save();
        await audit({
          orgId,
          action: 'order.pushed',
          entity: { type: 'order', id: order._id.toString() },
          summary: { reference: existing.reference, alreadyExisted: true },
        });
        return { ok: true, status: 'pushed', reference: existing.reference };
      }
    } catch (checkErr) {
      logger.warn({ err: checkErr }, 'findExistingOrder pre-check error, proceeding to create');
    }
  }

  const normalised = toNormalisedOrder(order, customer.accountCode);
  const res = await impl.createSalesOrder(normalised, idempotencyKey);

  if (res.ok) {
    order.status = 'pushed';
    order.pushedAt = new Date();
    order.erpReference = res.reference;
    order.lastPushError = undefined;
    await order.save();
    await audit({
      orgId,
      action: 'order.pushed',
      entity: { type: 'order', id: order._id.toString() },
      summary: { reference: res.reference, alreadyExisted: res.alreadyExisted },
    });
    return { ok: true, status: 'pushed', reference: res.reference };
  } else {
    order.status = 'push_failed';
    order.lastPushError = res.error;
    await order.save();
    await audit({
      orgId,
      action: 'order.push_failed',
      entity: { type: 'order', id: order._id.toString() },
      summary: { error: res.error, attempt: ctx?.attempt ?? 1 },
    });

    if (res.retryable) {
      throw new Error(`Push failed (retryable): ${res.error}`);
    }
    return { ok: false, status: 'push_failed' };
  }
}
