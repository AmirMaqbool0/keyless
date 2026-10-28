import { accountKey, descriptionKey, partCodeKey, skuKey } from '../lib/normalise';

/*
 * An in-memory view of one org's catalogue, customers, prices and cross-references, built once
 * and reused for every order (5k-50k products fit comfortably). Pure: the worker builds it from
 * MongoDB, the eval harness builds it from demo data, and both run the same matching code.
 */

export type CatProduct = {
  id: string;
  sku: string;
  description: string;
  barcode?: string;
  uom?: string;
  packSize?: number;
  defaultPrice?: number;
  stockQty?: number;
  active: boolean;
};
export type CatXref = {
  customerId: string;
  customerPartCode?: string;
  customerDescription?: string;
  sku: string;
  uomFactor: number;
  customerUom?: string;
};
export type CatAddress = { line1: string; city?: string; postcode?: string };
export type CatCustomer = {
  id: string;
  accountCode: string;
  name: string;
  emailDomains: string[];
  senderAddresses: string[];
  deliveryAddresses: CatAddress[];
  priceListCode?: string;
  creditHold: boolean;
  trustedForAutoApprove: boolean;
};
export type CatPrice = {
  customerId?: string;
  priceListCode?: string;
  sku: string;
  price: number;
  minQty?: number;
  validFrom?: Date;
  validTo?: Date;
};
export type CatalogueData = {
  products: CatProduct[];
  xrefs: CatXref[];
  customers: CatCustomer[];
  prices: CatPrice[];
};

export type SearchHit = { product: CatProduct; score: number };

/** The `ProductSearch` interface from the spec: anything that ranks products for a text. */
export interface ProductSearch {
  search(query: string, limit?: number): SearchHit[];
  scoreProduct?(query: string, product: CatProduct): number;
}

const STOPWORDS = new Set([
  'of',
  'the',
  'and',
  'with',
  'for',
  'in',
  'a',
  'an',
  'to',
  'x',
  'pk',
  'per',
]);
const SYNONYMS: Record<string, string> = {
  ltr: 'l',
  litre: 'l',
  litres: 'l',
  liter: 'l',
  ml: 'ml',
  mtr: 'm',
  metre: 'm',
  metres: 'm',
  ply: 'ply',
  xl: 'xl',
  med: 'medium',
  lg: 'large',
  sml: 'small',
  blk: 'black',
  wht: 'white',
  clr: 'clear',
};

/** Tokens for matching: lower-case, singular, synonyms unified, sizes kept ("5l", "450mm"). */
export function searchTokens(text: string): string[] {
  const out: string[] = [];
  const raw = text
    .toLowerCase()
    .replace(/"/g, ' in ')
    .replace(/(\d)\s+(ml|l|ltr|litre|litres|mm|cm|m|oz|kg|g)\b/g, '$1$2');
  for (let t of raw.match(/[a-z0-9]+(?:\.\d+)?/g) ?? []) {
    t = SYNONYMS[t] ?? t;
    if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') && !/\d/.test(t)) t = t.slice(0, -1);
    if (!STOPWORDS.has(t)) out.push(t);
  }
  return out;
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const set = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter || 1);
}

/**
 * Fuzzy product search: IDF-weighted token overlap (rare words like "nitrile" or "450mm" count
 * more than "pack") blended with character-trigram similarity (tolerates typos and run-together
 * words). Candidates come from an inverted index, so a query only scores products sharing a word.
 */
export class TokenProductSearch implements ProductSearch {
  private readonly postings = new Map<string, number[]>();
  private readonly docs: {
    product: CatProduct;
    tokens: Set<string>;
    weight: number;
    grams: Set<string>;
  }[] = [];
  private readonly idf = new Map<string, number>();

  constructor(products: CatProduct[]) {
    const df = new Map<string, number>();
    const tokenised = products.map((p) => {
      const tokens = new Set(searchTokens(`${p.description} ${p.sku}`));
      for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
      return { p, tokens };
    });
    const n = Math.max(products.length, 1);
    for (const [t, d] of df) this.idf.set(t, Math.log(1 + n / d));
    tokenised.forEach(({ p, tokens }, i) => {
      for (const t of tokens) {
        const list = this.postings.get(t);
        if (list) list.push(i);
        else this.postings.set(t, [i]);
      }
      const weight = [...tokens].reduce((s, t) => s + (this.idf.get(t) ?? 0), 0);
      this.docs.push({ product: p, tokens, weight, grams: trigrams([...tokens].join(' ')) });
    });
  }

  search(query: string, limit = 3): SearchHit[] {
    const qTokens = [...new Set(searchTokens(query))];
    if (!qTokens.length) return [];
    // Unknown query words still carry weight (as if seen once), so they count against matches.
    const maxIdf = Math.log(1 + Math.max(this.docs.length, 1));
    const w = (t: string) => this.idf.get(t) ?? maxIdf;
    const qWeight = qTokens.reduce((s, t) => s + w(t), 0);
    const shared = new Map<number, number>();
    for (const t of qTokens)
      for (const i of this.postings.get(t) ?? []) shared.set(i, (shared.get(i) ?? 0) + w(t));
    const shortlist = [...shared.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300);
    const qGrams = trigrams(qTokens.join(' '));
    return shortlist
      .map(([i, sharedWeight]) => {
        const d = this.docs[i]!;
        const dice = (2 * sharedWeight) / (qWeight + d.weight);
        return {
          product: d.product,
          score: Math.round((0.75 * dice + 0.25 * jaccard(qGrams, d.grams)) * 1000) / 1000,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  scoreProduct(query: string, product: CatProduct): number {
    const qTokens = [...new Set(searchTokens(query))];
    if (!qTokens.length) return 0;
    const doc = this.docs.find(
      (d) => d.product.id === product.id || d.product.sku === product.sku,
    );
    if (!doc) return 0;
    const maxIdf = Math.log(1 + Math.max(this.docs.length, 1));
    const w = (t: string) => this.idf.get(t) ?? maxIdf;
    const qWeight = qTokens.reduce((s, t) => s + w(t), 0);
    let sharedWeight = 0;
    for (const t of qTokens) {
      if (doc.tokens.has(t)) sharedWeight += w(t);
    }
    const dice = (2 * sharedWeight) / (qWeight + doc.weight || 1);
    const qGrams = trigrams(qTokens.join(' '));
    return Math.round((0.75 * dice + 0.25 * jaccard(qGrams, doc.grams)) * 1000) / 1000;
  }
}

export const PUBLIC_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'live.co.uk',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'icloud.com',
  'me.com',
  'aol.com',
  'btinternet.com',
  'sky.com',
  'virginmedia.com',
  'talktalk.net',
  'protonmail.com',
  'proton.me',
  'gmx.com',
  'gmx.co.uk',
  'mail.com',
  'zoho.com',
]);
export const isPublicDomain = (domain: string) => PUBLIC_DOMAINS.has(domain.toLowerCase());

export class CatalogueIndex {
  readonly search: ProductSearch;
  private readonly bySku = new Map<string, CatProduct>();
  private readonly byBarcode = new Map<string, CatProduct>();
  private readonly byId = new Map<string, CatProduct>();
  private readonly xrefByCode = new Map<string, CatXref>();
  private readonly xrefByDesc = new Map<string, CatXref>();
  private readonly customersById = new Map<string, CatCustomer>();
  private readonly customerBySender = new Map<string, CatCustomer>();
  private readonly customersByDomain = new Map<string, CatCustomer[]>();
  private readonly customerByAccount = new Map<string, CatCustomer>();
  private readonly pricesBySku = new Map<string, CatPrice[]>();
  readonly customers: CatCustomer[];

  constructor(data: CatalogueData) {
    for (const p of data.products) {
      this.bySku.set(skuKey(p.sku), p);
      this.byId.set(p.id, p);
      if (p.barcode) this.byBarcode.set(p.barcode.trim(), p);
    }
    for (const x of data.xrefs) {
      if (x.customerPartCode)
        this.xrefByCode.set(`${x.customerId}|${partCodeKey(x.customerPartCode)}`, x);
      if (x.customerDescription)
        this.xrefByDesc.set(`${x.customerId}|${descriptionKey(x.customerDescription)}`, x);
    }
    this.customers = data.customers;
    for (const c of data.customers) {
      this.customersById.set(c.id, c);
      this.customerByAccount.set(accountKey(c.accountCode), c);
      for (const s of c.senderAddresses) this.customerBySender.set(s.toLowerCase(), c);
      for (const d of c.emailDomains) {
        const list = this.customersByDomain.get(d.toLowerCase()) ?? [];
        list.push(c);
        this.customersByDomain.set(d.toLowerCase(), list);
      }
    }
    for (const p of data.prices) {
      const key = skuKey(p.sku);
      const list = this.pricesBySku.get(key) ?? [];
      list.push(p);
      this.pricesBySku.set(key, list);
    }
    this.search = new TokenProductSearch(data.products.filter((p) => p.active));
  }

  productBySku(sku: string) {
    return this.bySku.get(skuKey(sku));
  }
  productByBarcode(code: string) {
    return this.byBarcode.get(code.trim());
  }
  productById(id: string) {
    return this.byId.get(id);
  }
  xrefForCode(customerId: string, code: string) {
    return this.xrefByCode.get(`${customerId}|${partCodeKey(code)}`);
  }
  xrefForDescription(customerId: string, description: string) {
    return this.xrefByDesc.get(`${customerId}|${descriptionKey(description)}`);
  }
  customer(id: string) {
    return this.customersById.get(id);
  }
  customerForSender(address: string) {
    return this.customerBySender.get(address.toLowerCase());
  }
  customersForDomain(domain: string) {
    return isPublicDomain(domain) ? [] : (this.customersByDomain.get(domain.toLowerCase()) ?? []);
  }
  customerForAccount(code: string) {
    return this.customerByAccount.get(accountKey(code));
  }

  /** Contract price beats price-list price beats the catalogue default (spec section 8). */
  expectedPrice(
    customer: CatCustomer | undefined,
    product: CatProduct,
    quantity: number,
    on: Date,
  ): { price: number; source: 'contract' | 'price_list' | 'default' } | null {
    const valid = (p: CatPrice) =>
      (!p.validFrom || p.validFrom <= on) &&
      (!p.validTo || p.validTo >= on) &&
      (p.minQty ?? 1) <= quantity;
    // The highest quantity break the order qualifies for.
    const best = (list: CatPrice[]) =>
      list.filter(valid).sort((a, b) => (b.minQty ?? 1) - (a.minQty ?? 1))[0];
    const prices = this.pricesBySku.get(skuKey(product.sku)) ?? [];
    if (customer) {
      const contract = best(prices.filter((p) => p.customerId === customer.id));
      if (contract) return { price: contract.price, source: 'contract' };
      if (customer.priceListCode) {
        const list = best(
          prices.filter(
            (p) => p.priceListCode && skuKey(p.priceListCode) === skuKey(customer.priceListCode!),
          ),
        );
        if (list) return { price: list.price, source: 'price_list' };
      }
    }
    return product.defaultPrice === undefined
      ? null
      : { price: product.defaultPrice, source: 'default' };
  }
}
