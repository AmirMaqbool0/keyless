import type { SyncResult } from '@keyless/shared';
import { MAX_DEMO_PRODUCTS, generateDemoData, type DemoData } from '../demo/generator';
import { accountKey, skuKey } from '../lib/normalise';
import { Customer } from '../models/Customer';
import { MockErpOrder } from '../models/MockErpOrder';
import { Product } from '../models/Product';
import {
  upsertCustomers,
  upsertPrices,
  upsertProducts,
  type PriceRecord,
} from '../catalogue/upsert';
import type {
  ConnectorContext,
  ExternalOrderRef,
  NormalisedOrder,
  OrderConnector,
  PushResult,
} from './types';

const cache = new Map<number, DemoData>();
function feed(productCount: number): DemoData {
  let data = cache.get(productCount);
  if (!data) {
    data = generateDemoData({ productCount });
    cache.set(productCount, data);
  }
  return data;
}

export type MockConnectorSettings = { productCount?: number; customerCount?: number };

/**
 * A fake ERP for development and demos. Its "API" is the deterministic demo data generator;
 * stock levels drift a little on every sync so stock updates are visible. Sales orders land in
 * the MockErpOrder collection.
 */
export class MockConnector implements OrderConnector {
  constructor(private readonly ctx: ConnectorContext) {}

  private get settings(): MockConnectorSettings {
    return this.ctx.connector.settings as MockConnectorSettings;
  }

  private data(): DemoData {
    return feed(Math.min(this.settings.productCount ?? 5000, MAX_DEMO_PRODUCTS));
  }

  async testConnection() {
    return { ok: true, message: 'Connected to the demo ERP' };
  }

  async syncProducts(): Promise<SyncResult> {
    const started = Date.now();
    const { orgId } = this.ctx;
    const products = this.data().products;
    const counts = await upsertProducts(
      orgId,
      products.map((p) => ({ ...p, externalId: p.sku })),
      'connector',
    );
    // Items that disappeared from the ERP are deactivated, never deleted (orders may reference them).
    const gone = await Product.updateMany(
      {
        orgId,
        source: 'connector',
        active: true,
        skuKey: { $nin: products.map((p) => skuKey(p.sku)) },
      },
      { active: false },
    );
    return {
      entity: 'products',
      ...counts,
      deactivated: gone.modifiedCount,
      errors: [],
      durationMs: Date.now() - started,
    };
  }

  async syncCustomers(): Promise<SyncResult> {
    const started = Date.now();
    const customers = this.data().customers.slice(0, this.settings.customerCount ?? 60);
    const counts = await upsertCustomers(this.ctx.orgId, customers, 'connector');
    return {
      entity: 'customers',
      ...counts,
      deactivated: 0,
      errors: [],
      durationMs: Date.now() - started,
    };
  }

  async syncPrices(): Promise<SyncResult> {
    const started = Date.now();
    const { orgId } = this.ctx;
    const customers = await Customer.find({ orgId }, { accountKey: 1 }).lean();
    const ids = new Map(customers.map((c) => [c.accountKey, c._id]));
    const errors: string[] = [];
    const records: PriceRecord[] = [];
    for (const p of this.data().prices) {
      const customerId = p.accountCode ? ids.get(accountKey(p.accountCode)) : undefined;
      if (p.accountCode && !customerId) {
        if (errors.length < 20)
          errors.push(`Customer ${p.accountCode} not synced yet - sync customers first`);
        continue;
      }
      records.push({
        customerId,
        priceListCode: p.priceListCode,
        sku: p.sku,
        price: p.price,
        currency: p.currency,
        minQty: p.minQty,
      });
    }
    const counts = await upsertPrices(orgId, records, 'connector');
    return {
      entity: 'prices',
      ...counts,
      deactivated: 0,
      errors,
      durationMs: Date.now() - started,
    };
  }

  async syncStock(): Promise<SyncResult> {
    const started = Date.now();
    const { orgId } = this.ctx;
    // Small, time-varying drift so repeated syncs show changes.
    const tick = Math.floor(Date.now() / 60_000);
    const ops = this.data().products.map((p, i) => ({
      updateOne: {
        filter: { orgId, skuKey: skuKey(p.sku) },
        update: { $set: { stockQty: Math.max(0, p.stockQty + (((i * 31 + tick) % 21) - 10)) } },
      },
    }));
    const res = await Product.bulkWrite(ops, { ordered: false });
    return {
      entity: 'stock',
      created: 0,
      updated: res.modifiedCount,
      deactivated: 0,
      errors: [],
      durationMs: Date.now() - started,
    };
  }

  async findExistingOrder(customerRef: string, poNumber: string): Promise<ExternalOrderRef | null> {
    const existing = await MockErpOrder.findOne({
      orgId: this.ctx.orgId,
      connectorId: this.ctx.connector._id,
      customerRef,
      poNumber,
    });
    return existing
      ? { reference: existing.erpReference, createdAt: existing.createdAt.toISOString() }
      : null;
  }

  async createSalesOrder(order: NormalisedOrder, idempotencyKey: string): Promise<PushResult> {
    const { orgId, connector } = this.ctx;
    const existing = await MockErpOrder.findOne({
      orgId,
      connectorId: connector._id,
      idempotencyKey,
    });
    if (existing) return { ok: true, reference: existing.erpReference, alreadyExisted: true };
    const count = await MockErpOrder.countDocuments({ orgId, connectorId: connector._id });
    try {
      const created = await MockErpOrder.create({
        orgId,
        connectorId: connector._id,
        idempotencyKey,
        erpReference: `SO-${10001 + count}`,
        customerRef: order.customerRef,
        poNumber: order.poNumber,
        payload: order,
      });
      return { ok: true, reference: created.erpReference, alreadyExisted: false };
    } catch (err) {
      // A concurrent retry won the unique index race: report the order it created.
      const winner = await MockErpOrder.findOne({
        orgId,
        connectorId: connector._id,
        idempotencyKey,
      });
      if (winner) return { ok: true, reference: winner.erpReference, alreadyExisted: true };
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }
  }
}
