import type { ExtractedLine, ExtractedOrder, MatchMethod } from '@keyless/shared';
import { descriptionKey } from '../lib/normalise';
import { searchTokens, type CatCustomer, type CatProduct, type CatalogueIndex } from './catalogue';
import { computeUomConversion } from './uom';
import { findAttributeConflicts } from './attributeAgreement';

/*
 * Customer identification and line matching (spec section 7), as pure functions over a
 * CatalogueIndex so production and the eval harness share them.
 */

// ---------------------------------------------------------------------------------------------
// Customer identification: sender -> domain -> account number -> fuzzy name.

export type CustomerMatch = {
  customer?: CatCustomer;
  method:
    | 'sender'
    | 'domain'
    | 'account_number'
    | 'name'
    | 'delivery_address'
    | 'forwarded_sender'
    | 'manual'
    | 'none';
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

function normPostcode(s?: string | null): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function matchCustomerByAddress(
  customers: CatCustomer[],
  address?: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    postcode?: string | null;
    country?: string | null;
  } | null,
): { customer: CatCustomer; candidates: { customer: CatCustomer; score: number }[] } | null {
  if (!address) return null;
  const targetPc = normPostcode(address.postcode);
  const targetLine1 = (address.line1 ?? '').toLowerCase().trim();

  // 1. Postcode match (UK postcodes are 5-7 alphanumeric chars)
  if (targetPc && targetPc.length >= 5) {
    const hits: CatCustomer[] = [];
    for (const c of customers) {
      if (
        c.deliveryAddresses &&
        c.deliveryAddresses.some((a) => normPostcode(a.postcode) === targetPc)
      ) {
        hits.push(c);
      }
    }
    if (hits.length === 1) {
      return { customer: hits[0]!, candidates: [] };
    }
    if (hits.length > 1) {
      if (targetLine1) {
        const lineMatch = hits.find((c) =>
          c.deliveryAddresses.some((a) => {
            const l = (a.line1 ?? '').toLowerCase().trim();
            return l && (l.includes(targetLine1) || targetLine1.includes(l));
          }),
        );
        if (lineMatch) return { customer: lineMatch, candidates: [] };
      }
      return {
        customer: hits[0]!,
        candidates: hits.slice(0, 3).map((c) => ({ customer: c, score: 0.8 })),
      };
    }
  }

  // 2. Line 1 + city match if postcode is missing
  if (targetLine1 && targetLine1.length >= 5) {
    const targetCity = (address.city ?? '').toLowerCase().trim();
    const hits: CatCustomer[] = [];
    for (const c of customers) {
      if (
        c.deliveryAddresses &&
        c.deliveryAddresses.some((a) => {
          const l = (a.line1 ?? '').toLowerCase().trim();
          const city = (a.city ?? '').toLowerCase().trim();
          const lineOk = l && (l.includes(targetLine1) || targetLine1.includes(l));
          const cityOk = !targetCity || !city || city === targetCity;
          return lineOk && cityOk;
        })
      ) {
        hits.push(c);
      }
    }
    if (hits.length === 1) {
      return { customer: hits[0]!, candidates: [] };
    }
  }

  return null;
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
  input: {
    fromAddress?: string;
    emailText: string;
    extracted?: ExtractedOrder['customer'];
    deliveryAddress?: {
      line1?: string | null;
      line2?: string | null;
      city?: string | null;
      postcode?: string | null;
      country?: string | null;
    } | null;
    isUpload?: boolean;
    orgInternalDomains?: Set<string>;
  },
): CustomerMatch {
  const extractedCustomer = input.extracted ?? { name: null, accountNumber: null, email: null };
  const nameScores = (pool: CatCustomer[]) =>
    extractedCustomer.name
      ? pool
          .map((c) => ({ customer: c, score: nameSimilarity(extractedCustomer.name!, c.name) }))
          .sort((a, b) => b.score - a.score)
      : [];
  const byAccount = extractedCustomer.accountNumber
    ? index.customerForAccount(extractedCustomer.accountNumber)
    : undefined;

  const senderDomain = input.fromAddress?.split('@')[1]?.toLowerCase();
  const isInternalSender = Boolean(
    senderDomain &&
      (input.orgInternalDomains?.has(senderDomain) ||
        senderDomain === 'keyless.local' ||
        senderDomain.endsWith('.keyless.local')),
  );
  const skipSender = Boolean(input.isUpload || isInternalSender);

  const ranked = nameScores(index.customers).filter((r) => r.score > 0.3);
  const [top, second] = ranked;

  // For uploads and internal forwards: skip sender and use document data in priority order:
  // 1. account number on the PO -> 2. customer name -> 3. delivery address/postcode -> 4. forwarded sender -> 5. fuzzy name
  if (skipSender) {
    // 1. Account number on the PO
    if (byAccount) {
      return { customer: byAccount, method: 'account_number', confidence: 0.95, candidates: [] };
    }

    // 2. Customer name from extraction (exact / high-confidence match)
    if (top && top.score >= 0.85 && (second?.score ?? 0) < top.score - 0.15) {
      return {
        customer: top.customer,
        method: 'name',
        confidence: 0.85,
        candidates: ranked.slice(0, 3),
      };
    }

    // 3. Delivery address/postcode vs known customer addresses
    if (input.deliveryAddress) {
      const addressHit = matchCustomerByAddress(index.customers, input.deliveryAddress);
      if (addressHit) {
        return {
          customer: addressHit.customer,
          method: 'delivery_address',
          confidence: 0.85,
          candidates: addressHit.candidates,
        };
      }
    }

    // 4. Forwarded email sender in email text
    for (const address of forwardedSenders(input.emailText)) {
      const hit = bySenderOrDomain(index, address);
      if (hit?.customer) {
        return {
          customer: hit.customer,
          method: 'forwarded_sender',
          confidence: 0.9,
          candidates: [],
        };
      }
    }

    // 5. Fuzzy name
    if (top && top.score >= 0.65 && (second?.score ?? 0) < top.score - 0.1) {
      return {
        customer: top.customer,
        method: 'name',
        confidence: 0.7,
        candidates: ranked.slice(0, 3),
      };
    }

    return { method: 'none', confidence: 0, candidates: ranked.slice(0, 3) };
  }

  // When not skipping sender (external emails): sender -> domain -> account number -> fuzzy name
  const senders = [input.fromAddress, extractedCustomer.email].filter(
    (s): s is string => Boolean(s),
  );
  for (const address of senders) {
    const hit = bySenderOrDomain(index, address);
    if (!hit) continue;
    if (hit.customer) {
      const conflict =
        byAccount && byAccount.id !== hit.customer.id
          ? `The sender belongs to ${hit.customer.name}, but the PO shows account ${extractedCustomer.accountNumber} (${byAccount.name})`
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
    const rankedAmbiguous = nameScores(hit.ambiguous);
    if (
      rankedAmbiguous[0] &&
      rankedAmbiguous[0].score >= 0.8 &&
      (rankedAmbiguous[1]?.score ?? 0) < rankedAmbiguous[0].score - 0.2
    ) {
      return {
        customer: rankedAmbiguous[0].customer,
        method: 'name',
        confidence: 0.85,
        candidates: rankedAmbiguous.slice(0, 3),
      };
    }
    return {
      method: 'none',
      confidence: 0,
      candidates: (rankedAmbiguous.length
        ? rankedAmbiguous
        : hit.ambiguous.map((c) => ({ customer: c, score: 0.5 }))
      ).slice(0, 3),
    };
  }

  // 1. Account number on the PO
  if (byAccount) {
    return { customer: byAccount, method: 'account_number', confidence: 0.95, candidates: [] };
  }

  // 2. Forwarded email sender in email text
  for (const address of forwardedSenders(input.emailText)) {
    const hit = bySenderOrDomain(index, address);
    if (hit?.customer) {
      return {
        customer: hit.customer,
        method: 'forwarded_sender',
        confidence: 0.9,
        candidates: [],
      };
    }
  }

  // 3. Extracted name match
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
  notes: {
    code: string;
    message: string;
    severity?: 'info' | 'warning' | 'error';
    blocking?: boolean;
  }[];
};

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
  opts?: { mismatchThreshold?: number },
): LineMatch {
  const mismatchThreshold = opts?.mismatchThreshold ?? 0.5;
  const notes: LineMatch['notes'] = [];
  let product: CatProduct | undefined;
  let method: MatchMethod = 'none';
  let confidence = 0;
  let factor = 1;
  let candidates: LineMatch['candidates'] = [];
  let codeMismatch = false;

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

      if (!line.description) {
        // Code match with no customer description at all -> keep current behaviour but cap confidence at 0.85
        confidence = Math.min(confidence, 0.85);
      } else {
        const fuzzySim = index.search.scoreProduct
          ? index.search.scoreProduct(line.description, p)
          : 0;
        const coverage = descriptionAgreement(line, p);
        const sim = Math.max(fuzzySim, coverage);
        const conflicts = findAttributeConflicts(line.description, p.description);

        if (sim < mismatchThreshold || conflicts.length > 0) {
          codeMismatch = true;
          confidence = Math.min(confidence, 0.4);
          notes.push({
            code: 'code_description_mismatch',
            message: `Code ${line.customerPartCode} matches our product '${p.sku} ${p.description}' but the description says '${line.description}'. Please confirm.`,
            severity: 'warning',
          });
        }
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

  if (product && codeMismatch) {
    // Distrusted code match: put best description-based candidates first in the suggestions list
    if (!candidates.some((c) => c.product.id === product!.id)) {
      candidates = [...candidates, { product, score: 0.4 }].slice(0, 3);
    }
  } else if (product && !candidates.some((c) => c.product.id === product!.id)) {
    candidates = [{ product, score: 1 }, ...candidates].slice(0, 3);
  }

  // 5. Unit of measure: customer unit vs our selling unit
  let convertedQuantity =
    line.quantity === null || line.quantity === undefined
      ? undefined
      : Math.round(line.quantity * factor * 10_000) / 10_000;

  if (product) {
    const isXref = method === 'xref_code' || method === 'xref_description';
    const uomRes = computeUomConversion({
      customerQty: line.quantity,
      customerUnit: line.unit,
      customerDescription: line.description,
      productUom: product.uom,
      productPackSize: product.packSize,
      productDescription: product.description,
      isExistingXref: isXref,
      xrefFactor: factor,
    });
    factor = uomRes.factor;
    convertedQuantity = uomRes.convertedQuantity ?? undefined;

    if (uomRes.blockingError) {
      notes.push({
        code: 'pack_multiple',
        message: uomRes.blockingError,
        severity: 'error',
        blocking: true,
      });
    } else if (uomRes.warning && !isXref) {
      notes.push({
        code: 'uom_conversion',
        message: uomRes.warning,
        severity: 'warning',
      });
    }
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
