import type { Types } from 'mongoose';
import { z } from 'zod';
import type { ImportRowError, ImportType } from '@keyless/shared';
import { accountKey, skuKey } from '../../lib/normalise';
import { Customer } from '../../models/Customer';
import { Product } from '../../models/Product';
import {
  upsertCrossReferences,
  upsertCustomers,
  upsertPrices,
  upsertProducts,
  type CrossReferenceRecord,
  type CustomerRecord,
  type PriceRecord,
  type ProductRecord,
  type UpsertCounts,
} from '../catalogue/upsert';

/** Values for one row after mapping + type coercion, keyed by target field. */
export type RowValues = Record<string, unknown>;

type RowResult<R> = { record: R } | { errors: Omit<ImportRowError, 'row'>[] };

export interface Importer<R> {
  /** Load whatever lookups the rows need (once per run). */
  prepare(orgId: Types.ObjectId): Promise<void>;
  /** Type-specific checks beyond required/coercion. */
  toRecord(values: RowValues): RowResult<R>;
  commit(orgId: Types.ObjectId, records: R[]): Promise<UpsertCounts>;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const date = (v: unknown) => (v instanceof Date ? v : undefined);
const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);

async function loadCustomerIds(orgId: Types.ObjectId): Promise<Map<string, Types.ObjectId>> {
  const rows = await Customer.find({ orgId }, { accountKey: 1 }).lean();
  return new Map(rows.map((c) => [c.accountKey, c._id]));
}

async function loadProductIds(orgId: Types.ObjectId): Promise<Map<string, Types.ObjectId>> {
  const rows = await Product.find({ orgId }, { skuKey: 1 }).lean();
  return new Map(rows.map((p) => [p.skuKey, p._id]));
}

const emailSchema = z.email();
const domainRe = /^[a-z0-9.-]+\.[a-z]{2,}$/;

function productImporter(): Importer<ProductRecord> {
  return {
    async prepare() {},
    toRecord(v) {
      const errors: Omit<ImportRowError, 'row'>[] = [];
      const packSize = num(v.packSize);
      if (packSize !== undefined && packSize <= 0)
        errors.push({ field: 'packSize', message: 'Pack size must be more than 0' });
      const price = num(v.defaultPrice);
      if (price !== undefined && price < 0)
        errors.push({ field: 'defaultPrice', message: 'Price cannot be negative' });
      if (errors.length) return { errors };
      return {
        record: {
          sku: str(v.sku)!,
          description: str(v.description)!,
          uom: str(v.uom),
          packSize,
          barcode: str(v.barcode),
          defaultPrice: price,
          stockQty: num(v.stockQty),
          active: bool(v.active),
        },
      };
    },
    commit: (orgId, records) => upsertProducts(orgId, records, 'import'),
  };
}

function customerImporter(): Importer<CustomerRecord> {
  return {
    async prepare() {},
    toRecord(v) {
      const errors: Omit<ImportRowError, 'row'>[] = [];
      const senders = list(v.senderAddresses).map((e) => e.toLowerCase());
      const badSender = senders.find((e) => !emailSchema.safeParse(e).success);
      if (badSender)
        errors.push({
          field: 'senderAddresses',
          message: `"${badSender}" is not an email address`,
        });
      const domains = list(v.emailDomains).map((d) => d.toLowerCase().replace(/^@/, ''));
      const badDomain = domains.find((d) => !domainRe.test(d));
      if (badDomain)
        errors.push({ field: 'emailDomains', message: `"${badDomain}" is not a domain` });
      if (errors.length) return { errors };

      const line1 = str(v.addressLine1);
      return {
        record: {
          accountCode: str(v.accountCode)!,
          name: str(v.name)!,
          erpCustomerId: str(v.erpCustomerId),
          emailDomains: domains,
          senderAddresses: senders,
          priceListCode: str(v.priceListCode),
          creditHold: bool(v.creditHold),
          deliveryAddresses: line1
            ? [
                {
                  line1,
                  line2: str(v.addressLine2),
                  city: str(v.city),
                  postcode: str(v.postcode)?.toUpperCase(),
                  country: str(v.country),
                },
              ]
            : [],
        },
      };
    },
    commit: (orgId, records) => upsertCustomers(orgId, records, 'import'),
  };
}

function priceImporter(defaultCurrency: string): Importer<PriceRecord> {
  let customers = new Map<string, Types.ObjectId>();
  let products = new Map<string, Types.ObjectId>();
  return {
    async prepare(orgId) {
      [customers, products] = await Promise.all([loadCustomerIds(orgId), loadProductIds(orgId)]);
    },
    toRecord(v) {
      const errors: Omit<ImportRowError, 'row'>[] = [];
      const account = str(v.accountCode);
      const priceList = str(v.priceListCode);
      const customerId = account ? customers.get(accountKey(account)) : undefined;
      if (!account && !priceList)
        errors.push({ message: 'Each row needs a customer account code or a price list code' });
      if (account && !customerId)
        errors.push({
          field: 'accountCode',
          message: `Unknown customer account "${account}" - import customers first`,
        });
      const sku = str(v.sku)!;
      if (!products.has(skuKey(sku)))
        errors.push({ field: 'sku', message: `Unknown SKU "${sku}" - import products first` });
      const price = num(v.price)!;
      if (price < 0) errors.push({ field: 'price', message: 'Price cannot be negative' });
      const validFrom = date(v.validFrom);
      const validTo = date(v.validTo);
      if (validFrom && validTo && validTo < validFrom)
        errors.push({ field: 'validTo', message: 'Valid-to is before valid-from' });
      if (errors.length) return { errors };
      return {
        record: {
          customerId,
          priceListCode: customerId ? undefined : priceList,
          sku,
          price,
          currency: (str(v.currency) ?? defaultCurrency).toUpperCase(),
          minQty: num(v.minQty),
          validFrom,
          validTo,
        },
      };
    },
    commit: (orgId, records) => upsertPrices(orgId, records, 'import'),
  };
}

function crossReferenceImporter(): Importer<CrossReferenceRecord> {
  let customers = new Map<string, Types.ObjectId>();
  let products = new Map<string, Types.ObjectId>();
  return {
    async prepare(orgId) {
      [customers, products] = await Promise.all([loadCustomerIds(orgId), loadProductIds(orgId)]);
    },
    toRecord(v) {
      const errors: Omit<ImportRowError, 'row'>[] = [];
      const account = str(v.accountCode)!;
      const customerId = customers.get(accountKey(account));
      if (!customerId)
        errors.push({
          field: 'accountCode',
          message: `Unknown customer account "${account}" - import customers first`,
        });
      const partCode = str(v.customerPartCode);
      const description = str(v.customerDescription);
      if (!partCode && !description)
        errors.push({ message: "Each row needs the customer's part code or description" });
      const sku = str(v.sku)!;
      const productId = products.get(skuKey(sku));
      if (!productId)
        errors.push({ field: 'sku', message: `Unknown SKU "${sku}" - import products first` });
      const factor = num(v.uomFactor);
      if (factor !== undefined && factor <= 0)
        errors.push({ field: 'uomFactor', message: 'Conversion factor must be more than 0' });
      if (errors.length || !customerId) return { errors };
      return {
        record: {
          customerId,
          customerPartCode: partCode,
          customerDescription: description,
          sku,
          productId,
          customerUom: str(v.customerUom),
          uomFactor: factor,
        },
      };
    },
    commit: (orgId, records) => upsertCrossReferences(orgId, records, 'import'),
  };
}

export function createImporter(type: ImportType, opts: { currency: string }): Importer<unknown> {
  switch (type) {
    case 'products':
      return productImporter() as Importer<unknown>;
    case 'customers':
      return customerImporter() as Importer<unknown>;
    case 'prices':
      return priceImporter(opts.currency) as Importer<unknown>;
    case 'cross_references':
      return crossReferenceImporter() as Importer<unknown>;
  }
}
