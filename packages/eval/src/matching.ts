import type { ExtractedOrder } from '@keyless/shared';
import { generateDemoData } from '@keyless/core/demo/generator';
import { CatalogueIndex } from '@keyless/core/matching/catalogue';
import { identifyCustomer, matchLine } from '@keyless/core/matching/match';
import type { OrderResult, Tally } from './score';

/*
 * Matching accuracy against the same demo catalogue the fixtures were generated from: was the
 * right customer identified, and did each expected line match to its expected SKU? Uses the
 * production matching code on the *extracted* data, so extraction errors count against it too.
 */

let cached: { index: CatalogueIndex; accountByName: Map<string, string> } | undefined;

export function demoCatalogue() {
  if (cached) return cached;
  const d = generateDemoData();
  const index = new CatalogueIndex({
    products: d.products.map((p) => ({ id: p.sku, ...p })),
    customers: d.customers.map((c) => ({
      id: c.accountCode,
      accountCode: c.accountCode,
      name: c.name,
      emailDomains: c.emailDomains,
      senderAddresses: c.senderAddresses,
      deliveryAddresses: c.deliveryAddresses,
      priceListCode: c.priceListCode,
      creditHold: c.creditHold,
      trustedForAutoApprove: false,
    })),
    prices: d.prices.map((p) => ({
      customerId: p.accountCode,
      priceListCode: p.priceListCode,
      sku: p.sku,
      price: p.price,
      minQty: p.minQty,
    })),
    xrefs: d.crossReferences.map((x) => ({
      customerId: x.accountCode,
      customerPartCode: x.customerPartCode,
      customerDescription: x.customerDescription,
      sku: x.sku,
      uomFactor: x.uomFactor ?? 1,
      customerUom: x.customerUom,
    })),
  });
  cached = { index, accountByName: new Map(d.customers.map((c) => [c.name, c.accountCode])) };
  return cached;
}

export type MatchScore = { customer: Tally; sku: Tally; misses: string[] };

export function scoreMatching(
  orders: OrderResult[],
  email: { fromAddress?: string; text: string },
): MatchScore {
  const { index, accountByName } = demoCatalogue();
  const s: MatchScore = { customer: { ok: 0, total: 0 }, sku: { ok: 0, total: 0 }, misses: [] };
  for (const o of orders) {
    if (!o.expected) continue;
    const expectedAccount = o.expected.customerName
      ? accountByName.get(o.expected.customerName)
      : undefined;
    const extracted: ExtractedOrder['customer'] = o.actual?.customer ?? {
      name: null,
      accountNumber: null,
      email: null,
    };
    const cm = identifyCustomer(index, {
      fromAddress: email.fromAddress,
      emailText: email.text,
      extracted,
    });
    if (expectedAccount) {
      s.customer.total += 1;
      if (cm.customer?.accountCode === expectedAccount) s.customer.ok += 1;
      else
        s.misses.push(
          `customer: expected ${expectedAccount}, got ${cm.customer?.accountCode ?? 'none'}`,
        );
    }
    for (const l of o.lines) {
      if (!l.expected?.expectedSku) continue;
      s.sku.total += 1;
      if (!l.actual) {
        s.misses.push(
          `sku: line ${l.expected.customerPartCode ?? l.expected.description} not extracted`,
        );
        continue;
      }
      const m = matchLine(index, cm.customer, l.actual);
      if (m.product?.sku === l.expected.expectedSku) s.sku.ok += 1;
      else
        s.misses.push(
          `sku: "${l.actual.customerPartCode ?? ''} ${l.actual.description ?? ''}" expected ${l.expected.expectedSku}, got ${m.product?.sku ?? 'no match'} (${m.method})`,
        );
    }
  }
  return s;
}
