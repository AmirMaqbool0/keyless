import type { ExtractedLine, ExtractedOrder, MatchMethod } from '@keyless/shared';
import { descriptionKey } from '../lib/normalise';
import { searchTokens, type CatCustomer, type CatProduct, type CatalogueIndex } from './catalogue';

/*
 * Customer identification and line matching (spec section 7), as pure functions over a
 * CatalogueIndex so production and the eval harness share them.
 */

// ---------------------------------------------------------------------------------------------
// Customer identification: sender -> domain -> account number -> fuzzy name.

export type CustomerMatch = {
  customer?: CatCustomer;
  method: 'sender' | 'domain' | 'account_number' | 'name' | 'forwarded_sender' | 'manual' | 'none';
  confidence: number;
  candidates: { customer: CatCustomer; score: number }[];
  /** Set when two signals point at different customers. */
  conflict?: string;
};

function nameSimilarity(a: string, b: string): number {
  const A = new Set(
    searchTokens(a).filter(
      (t) => !['ltd', 'limited', 'plc', 'llp', 'co', 'company', 'uk'].includes(t),
    ),
  );
  const B = new Set(
    searchTokens(b).filter(
      (t) => !['ltd', 'limited', 'plc', 'llp', 'co', 'company', 'uk'].includes(t),
    ),
  );
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

/** Original senders inside a forwarded email ("From: Sam <sam@cafe.co.uk>"). */
export function forwardedSenders(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*>?\s*From:\s*.*?([\w.+-]+@[\w-]+\.[\w.-]+)/gim))
    out.push(m[1]!.toLowerCase());
  return [...new Set(out)];
}

function bySenderOrDomain(
  index: CatalogueIndex,
  address: string,
): { customer?: CatCustomer; method: 'sender' | 'domain'; ambiguous: CatCustomer[] } | null {
  const exact = index.customerForSender(address);
  if (exact) return { customer: exact, method: 'sender', ambiguous: [] };
  const domain = address.split('@')[1] ?? '';
  const byDomain = index.customersForDomain(domain);
  if (byDomain.length === 1) return { customer: byDomain[0], method: 'domain', ambiguous: [] };
  if (byDomain.length > 1) return { method: 'domain', ambiguous: byDomain };
  return null;
}

export function identifyCustomer(
  index: CatalogueIndex,
  input: { fromAddress?: string; emailText: string; extracted: ExtractedOrder['customer'] },
): CustomerMatch {
  const nameScores = (pool: CatCustomer[]) =>
    input.extracted.name
      ? pool
          .map((c) => ({ customer: c, score: nameSimilarity(input.extracted.name!, c.name) }))
          .sort((a, b) => b.score - a.score)
      : [];
  const byAccount = input.extracted.accountNumber
    ? index.customerForAccount(input.extracted.accountNumber)
    : undefined;

  const senders = [input.fromAddress, input.extracted.email].filter((s): s is string => Boolean(s));
  for (const address of senders) {
    const hit = bySenderOrDomain(index, address);
    if (!hit) continue;
    if (hit.customer) {
      const conflict =
        byAccount && byAccount.id !== hit.customer.id
          ? `The sender belongs to ${hit.customer.name}, but the PO shows account ${input.extracted.accountNumber} (${byAccount.name})`
          : undefined;
      return {
        customer: hit.customer,
        method: hit.method,
        confidence: hit.method === 'sender' ? 0.99 : 0.9,
        candidates: [],
        conflict,
      };
    }
    // Several customers share the domain (e.g. sites of one group): let the PO decide.
    if (byAccount && hit.ambiguous.some((c) => c.id === byAccount.id))
      return { customer: byAccount, method: 'account_number', confidence: 0.95, candidates: [] };
    const ranked = nameScores(hit.ambiguous);
    if (ranked[0] && ranked[0].score >= 0.8 && (ranked[1]?.score ?? 0) < ranked[0].score - 0.2) {
      return {
        customer: ranked[0].customer,
        method: 'name',
        confidence: 0.85,
        candidates: ranked.slice(0, 3),
      };
    }
    return {
      method: 'none',
      confidence: 0,
      candidates: (ranked.length
        ? ranked
        : hit.ambiguous.map((c) => ({ customer: c, score: 0.5 }))
      ).slice(0, 3),
    };
  }

  if (byAccount)
    return { customer: byAccount, method: 'account_number', confidence: 0.95, candidates: [] };

  // A colleague forwarded the customer's email by hand: look for the original sender inside.
  for (const address of forwardedSenders(input.emailText)) {
    const hit = bySenderOrDomain(index, address);
    if (hit?.customer)
      return {
        customer: hit.customer,
        method: 'forwarded_sender',
        confidence: 0.9,
        candidates: [],
      };
  }

  const ranked = nameScores(index.customers).filter((r) => r.score > 0.3);
  const [top, second] = ranked;
  if (top && top.score >= 0.85 && (second?.score ?? 0) < top.score - 0.15) {
    return {
      customer: top.customer,
      method: 'name',
      confidence: 0.75,
      candidates: ranked.slice(0, 3),
    };
  }
  return { method: 'none', confidence: 0, candidates: ranked.slice(0, 3) };
}

// ---------------------------------------------------------------------------------------------
// Line matching: cross-reference (code, then description) -> our SKU/barcode -> fuzzy search.

export type LineMatch = {
  product?: CatProduct;
  method: MatchMethod;
  confidence: number;
  candidates: { product: CatProduct; score: number }[];
  /** Our units per one customer unit. */
  factor: number;
  convertedQuantity?: number;
  notes: { code: string; message: string }[];
};

const EACH_UNITS = /^(each|ea|unit|units|single|singles|pcs?|pieces?|item|items|no)$/i;

function descriptionAgreement(line: ExtractedLine, product: CatProduct): number {
  if (!line.description) return 1;
  const a = new Set(searchTokens(line.description));
  const b = new Set(searchTokens(product.description));
  if (!a.size) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / a.size;
}

export function matchLine(
  index: CatalogueIndex,
  customer: CatCustomer | undefined,
  line: ExtractedLine,
): LineMatch {
  const notes: LineMatch['notes'] = [];
  let product: CatProduct | undefined;
  let method: MatchMethod = 'none';
  let confidence = 0;
  let factor = 1;
  let candidates: LineMatch['candidates'] = [];

  // 1-2. The customer's own cross-references: the learning asset.
  if (customer && line.customerPartCode) {
    const x = index.xrefForCode(customer.id, line.customerPartCode);
    const p = x && index.productBySku(x.sku);
    if (x && p) [product, method, confidence, factor] = [p, 'xref_code', 0.98, x.uomFactor || 1];
  }
  if (!product && customer && line.description) {
    const x = index.xrefForDescription(customer.id, line.description);
    const p = x && index.productBySku(x.sku);
    if (x && p)
      [product, method, confidence, factor] = [p, 'xref_description', 0.92, x.uomFactor || 1];
  }

  // 3. Customers who use our codes (or barcodes) directly.
  if (!product && line.customerPartCode) {
    const bySku = index.productBySku(line.customerPartCode);
    const byBarcode = bySku ? undefined : index.productByBarcode(line.customerPartCode);
    const p = bySku ?? byBarcode;
    if (p) {
      [product, method, confidence] = [p, bySku ? 'sku' : 'barcode', 0.95];
      // Their code happens to equal one of ours but the words disagree: don't trust it blindly.
      if (descriptionAgreement(line, p) < 0.25) {
        confidence = 0.55;
        notes.push({
          code: 'code_description_mismatch',
          message: `Code ${line.customerPartCode} is our ${p.sku} "${p.description}", but the line says "${line.description}"`,
        });
      }
    }
  }

  // 4. Fuzzy search on the description: top 3 candidates either way, for the reviewer.
  const query = line.description ?? line.customerPartCode ?? '';
  if (query) {
    const hits = index.search.search(query, 3);
    const exactKey = descriptionKey(query);
    for (const h of hits) if (descriptionKey(h.product.description) === exactKey) h.score = 1;
    hits.sort((a, b) => b.score - a.score);
    candidates = hits;
    if (!product && hits[0]) {
      const [top, second] = hits;
      const gap = top.score - (second?.score ?? 0);
      if (top.score === 1 && gap > 0) [product, method, confidence] = [top.product, 'fuzzy', 0.93];
      else if (top.score >= 0.55 && (gap >= 0.05 || top.score >= 0.95)) {
        [product, method] = [top.product, 'fuzzy'];
        confidence = Math.min(0.88, top.score * 0.9 + Math.min(gap, 0.2) * 0.5);
      }
    }
  }
  if (product && !candidates.some((c) => c.product.id === product!.id))
    candidates = [{ product, score: 1 }, ...candidates].slice(0, 3);

  // 5. Unit of measure: the customer orders single items but we sell packs.
  if (
    product &&
    method !== 'xref_code' &&
    method !== 'xref_description' &&
    line.unit &&
    EACH_UNITS.test(line.unit.trim()) &&
    (product.packSize ?? 1) > 1 &&
    product.uom !== 'EACH'
  ) {
    factor = 1 / product.packSize!;
  }
  const convertedQuantity =
    line.quantity === null ? undefined : Math.round(line.quantity * factor * 10_000) / 10_000;
  if (
    product &&
    convertedQuantity !== undefined &&
    factor !== 1 &&
    !Number.isInteger(convertedQuantity)
  ) {
    notes.push({
      code: 'pack_multiple',
      message: `${line.quantity} ${line.unit ?? 'units'} is ${convertedQuantity} x ${product.uom ?? 'pack'} of ${product.packSize}: not a whole pack`,
    });
  }
  return {
    product,
    method,
    confidence: Math.round(confidence * 100) / 100,
    candidates,
    factor,
    convertedQuantity,
    notes,
  };
}
