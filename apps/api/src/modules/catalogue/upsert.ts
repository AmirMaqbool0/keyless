import type { Types } from 'mongoose';
import type { Address } from '@keyless/shared';
import { accountKey, descriptionKey, partCodeKey, searchText, skuKey } from '../../lib/normalise';
import { CrossReference, type ICrossReference } from '../../models/CrossReference';
import { Customer, type ICustomer } from '../../models/Customer';
import { CustomerPrice, type ICustomerPrice } from '../../models/CustomerPrice';
import { Product, type IProduct } from '../../models/Product';

/*
 * Idempotent bulk upserts shared by CSV imports and connector syncs.
 *
 * bulkWrite bypasses query middleware, so the tenant plugin cannot check these: every filter
 * below includes orgId explicitly, and orgId is never taken from the records themselves.
 *
 * Empty optional values are left out of $set, so a partial file never blanks existing data.
 */

const BATCH = 1000;
export type UpsertCounts = { created: number; updated: number };

type UpsertOp = {
  updateOne: { filter: Record<string, unknown>; update: Record<string, unknown>; upsert: true };
};
// Mongoose's per-model bulkWrite typings reject hand-built update documents, so models are
// accepted structurally here; every op is built in this file with an explicit orgId filter.
type BulkWritable = {
  bulkWrite(
    ops: never[],
    opts: { ordered: boolean },
  ): Promise<{ upsertedCount: number; matchedCount: number }>;
};

async function runBatches(model: BulkWritable, ops: UpsertOp[]): Promise<UpsertCounts> {
  const counts = { created: 0, updated: 0 };
  for (let i = 0; i < ops.length; i += BATCH) {
    const res = await model.bulkWrite(ops.slice(i, i + BATCH) as never[], { ordered: false });
    counts.created += res.upsertedCount;
    counts.updated += res.matchedCount;
  }
  return counts;
}

function defined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ) as Partial<T>;
}

export type ProductRecord = {
  sku: string;
  description: string;
  uom?: string;
  packSize?: number;
  barcode?: string;
  defaultPrice?: number;
  stockQty?: number;
  active?: boolean;
  externalId?: string;
};

export function upsertProducts(
  orgId: Types.ObjectId,
  records: ProductRecord[],
  source: IProduct['source'],
): Promise<UpsertCounts> {
  const now = new Date();
  const ops: UpsertOp[] = records.map((r) => {
    const set = defined({
      sku: r.sku.trim(),
      skuKey: skuKey(r.sku),
      description: r.description,
      uom: r.uom,
      packSize: r.packSize,
      barcode: r.barcode,
      defaultPrice: r.defaultPrice,
      stockQty: r.stockQty,
      active: r.active,
      externalId: r.externalId,
      searchText: searchText(r.sku, r.description, r.barcode),
      source,
      ...(source === 'connector' ? { lastSyncedAt: now } : {}),
    });
    return {
      updateOne: {
        filter: { orgId, skuKey: skuKey(r.sku) },
        update: { $set: set, $setOnInsert: r.active === undefined ? { active: true } : {} },
        upsert: true,
      },
    };
  });
  return runBatches(Product, ops);
}

export type CustomerRecord = {
  accountCode: string;
  name: string;
  erpCustomerId?: string;
  emailDomains?: string[];
  senderAddresses?: string[];
  priceListCode?: string;
  creditHold?: boolean;
  deliveryAddresses?: Address[];
};

/** Rows sharing an account code are merged (e.g. one row per delivery address). */
export function upsertCustomers(
  orgId: Types.ObjectId,
  records: CustomerRecord[],
  source: ICustomer['source'],
): Promise<UpsertCounts> {
  const merged = new Map<string, CustomerRecord>();
  for (const r of records) {
    const key = accountKey(r.accountCode);
    const prev = merged.get(key);
    merged.set(
      key,
      prev
        ? {
            ...prev,
            ...defined(r),
            emailDomains: [...(prev.emailDomains ?? []), ...(r.emailDomains ?? [])],
            senderAddresses: [...(prev.senderAddresses ?? []), ...(r.senderAddresses ?? [])],
            deliveryAddresses: [...(prev.deliveryAddresses ?? []), ...(r.deliveryAddresses ?? [])],
          }
        : r,
    );
  }

  const now = new Date();
  const ops: UpsertOp[] = [...merged.entries()].map(([key, r]) => {
    const addToSet = defined({
      emailDomains: r.emailDomains?.length
        ? { $each: r.emailDomains.map((d) => d.toLowerCase()) }
        : undefined,
      senderAddresses: r.senderAddresses?.length
        ? { $each: r.senderAddresses.map((e) => e.toLowerCase()) }
        : undefined,
      deliveryAddresses: r.deliveryAddresses?.length
        ? { $each: r.deliveryAddresses.map((a) => defined(a)) }
        : undefined,
    });
    return {
      updateOne: {
        filter: { orgId, accountKey: key },
        update: {
          $set: defined({
            accountCode: r.accountCode.trim(),
            accountKey: key,
            name: r.name,
            erpCustomerId: r.erpCustomerId,
            priceListCode: r.priceListCode,
            creditHold: r.creditHold,
            searchText: searchText(r.accountCode, r.name),
            source,
            ...(source === 'connector' ? { lastSyncedAt: now } : {}),
          }),
          ...(Object.keys(addToSet).length ? { $addToSet: addToSet } : {}),
        },
        upsert: true,
      },
    };
  });
  return runBatches(Customer, ops);
}

export type PriceRecord = {
  customerId?: Types.ObjectId;
  priceListCode?: string;
  sku: string;
  price: number;
  currency: string;
  minQty?: number;
  validFrom?: Date;
  validTo?: Date;
};

export function priceKey(r: PriceRecord): string {
  const scope = r.customerId
    ? `c:${r.customerId.toString()}`
    : `pl:${skuKey(r.priceListCode ?? '')}`;
  return [scope, skuKey(r.sku), r.minQty ?? 1, r.validFrom?.toISOString().slice(0, 10) ?? ''].join(
    '|',
  );
}

export function upsertPrices(
  orgId: Types.ObjectId,
  records: PriceRecord[],
  source: ICustomerPrice['source'],
): Promise<UpsertCounts> {
  const ops: UpsertOp[] = records.map((r) => {
    const key = priceKey(r);
    return {
      updateOne: {
        filter: { orgId, priceKey: key },
        update: {
          $set: defined({
            customerId: r.customerId,
            priceListCode: r.priceListCode ? skuKey(r.priceListCode) : undefined,
            sku: r.sku.trim(),
            skuKey: skuKey(r.sku),
            price: r.price,
            currency: r.currency,
            minQty: r.minQty,
            validFrom: r.validFrom,
            validTo: r.validTo,
            priceKey: key,
            source,
          }),
        },
        upsert: true,
      },
    };
  });
  return runBatches(CustomerPrice, ops);
}

export type CrossReferenceRecord = {
  customerId: Types.ObjectId;
  customerPartCode?: string;
  customerDescription?: string;
  sku: string;
  productId?: Types.ObjectId;
  customerUom?: string;
  uomFactor?: number;
};

export function crossReferenceMatchKey(r: {
  customerPartCode?: string;
  customerDescription?: string;
}): string {
  if (r.customerPartCode && partCodeKey(r.customerPartCode))
    return `code:${partCodeKey(r.customerPartCode)}`;
  return `desc:${descriptionKey(r.customerDescription ?? '')}`;
}

export function upsertCrossReferences(
  orgId: Types.ObjectId,
  records: CrossReferenceRecord[],
  source: ICrossReference['source'],
): Promise<UpsertCounts> {
  const ops: UpsertOp[] = records.map((r) => ({
    updateOne: {
      filter: { orgId, customerId: r.customerId, matchKey: crossReferenceMatchKey(r) },
      update: {
        $set: defined({
          customerPartCode: r.customerPartCode,
          partCodeKey: r.customerPartCode ? partCodeKey(r.customerPartCode) : undefined,
          customerDescription: r.customerDescription,
          descriptionKey: r.customerDescription ? descriptionKey(r.customerDescription) : undefined,
          matchKey: crossReferenceMatchKey(r),
          sku: r.sku.trim(),
          skuKey: skuKey(r.sku),
          productId: r.productId,
          customerUom: r.customerUom,
          uomFactor: r.uomFactor,
          source,
          confidence: 1,
          searchText: searchText(r.customerPartCode, r.customerDescription, r.sku),
        }),
        $setOnInsert: { timesUsed: 0 },
      },
      upsert: true,
    },
  }));
  return runBatches(CrossReference, ops);
}
