import type { Types } from 'mongoose';
import { CrossReference } from '../models/CrossReference';
import { Customer } from '../models/Customer';
import { CustomerPrice } from '../models/CustomerPrice';
import { Product } from '../models/Product';
import { CatalogueIndex } from './catalogue';

/*
 * Builds (and caches) the per-org CatalogueIndex from MongoDB. The cache key is a cheap
 * fingerprint (counts + latest updatedAt of each collection), so an import, a sync, or a
 * correction that learns a cross-reference is picked up on the next order without restarts.
 */

type Entry = { fingerprint: string; index: CatalogueIndex };
const cache = new Map<string, Entry>();
const MAX_CACHED_ORGS = 50;

async function fingerprint(orgId: Types.ObjectId): Promise<string> {
  const parts = await Promise.all(
    [Product, Customer, CustomerPrice, CrossReference].map(async (m) => {
      const model = m as unknown as typeof Product;
      const [count, latest] = await Promise.all([
        model.countDocuments({ orgId }),
        model.findOne({ orgId }, { updatedAt: 1 }).sort({ updatedAt: -1 }).lean(),
      ]);
      return `${count}:${latest?.updatedAt?.getTime() ?? 0}`;
    }),
  );
  return parts.join('|');
}

export async function loadCatalogueIndex(orgId: Types.ObjectId): Promise<CatalogueIndex> {
  const key = orgId.toString();
  const fp = await fingerprint(orgId);
  const hit = cache.get(key);
  if (hit && hit.fingerprint === fp) return hit.index;

  const [products, customers, prices, xrefs] = await Promise.all([
    Product.find(
      { orgId },
      {
        sku: 1,
        description: 1,
        barcode: 1,
        uom: 1,
        packSize: 1,
        defaultPrice: 1,
        stockQty: 1,
        active: 1,
      },
    ).lean(),
    Customer.find(
      { orgId },
      {
        accountCode: 1,
        name: 1,
        emailDomains: 1,
        senderAddresses: 1,
        deliveryAddresses: 1,
        priceListCode: 1,
        creditHold: 1,
        trustedForAutoApprove: 1,
      },
    ).lean(),
    CustomerPrice.find(
      { orgId },
      { customerId: 1, priceListCode: 1, sku: 1, price: 1, minQty: 1, validFrom: 1, validTo: 1 },
    ).lean(),
    CrossReference.find(
      { orgId },
      {
        customerId: 1,
        customerPartCode: 1,
        customerDescription: 1,
        sku: 1,
        uomFactor: 1,
        customerUom: 1,
      },
    ).lean(),
  ]);
  const index = new CatalogueIndex({
    products: products.map((p) => ({
      id: p._id.toString(),
      sku: p.sku,
      description: p.description,
      barcode: p.barcode,
      uom: p.uom,
      packSize: p.packSize,
      defaultPrice: p.defaultPrice,
      stockQty: p.stockQty,
      active: p.active,
    })),
    customers: customers.map((c) => ({
      id: c._id.toString(),
      accountCode: c.accountCode,
      name: c.name,
      emailDomains: c.emailDomains,
      senderAddresses: c.senderAddresses,
      deliveryAddresses: c.deliveryAddresses.map((a) => ({
        line1: a.line1,
        city: a.city ?? undefined,
        postcode: a.postcode ?? undefined,
      })),
      priceListCode: c.priceListCode,
      creditHold: c.creditHold,
      trustedForAutoApprove: c.trustedForAutoApprove,
    })),
    prices: prices.map((p) => ({
      customerId: p.customerId?.toString(),
      priceListCode: p.priceListCode,
      sku: p.sku,
      price: p.price,
      minQty: p.minQty,
      validFrom: p.validFrom,
      validTo: p.validTo,
    })),
    xrefs: xrefs.map((x) => ({
      customerId: x.customerId.toString(),
      customerPartCode: x.customerPartCode,
      customerDescription: x.customerDescription,
      sku: x.sku,
      uomFactor: x.uomFactor,
      customerUom: x.customerUom,
    })),
  });
  if (cache.size >= MAX_CACHED_ORGS) cache.delete(cache.keys().next().value!);
  cache.set(key, { fingerprint: fp, index });
  return index;
}
