import { describe, expect, it } from 'vitest';
import type { ExtractedLine, ExtractedOrderDto } from '@keyless/shared';
import { buildOrderDraft } from '@keyless/core/matching/build';
import {
  CatalogueIndex,
  type CatCustomer,
  type CatProduct,
} from '@keyless/core/matching/catalogue';
import { forwardedSenders, identifyCustomer, matchLine } from '@keyless/core/matching/match';
import { DEFAULT_ROUTING, routeOrder } from '@keyless/core/matching/route';

const products: CatProduct[] = [
  {
    id: 'p1',
    sku: 'GL1001',
    description: 'Nitrile Gloves Powder Free Blue Medium (Box 100)',
    barcode: '5012345678900',
    uom: 'BOX',
    packSize: 100,
    defaultPrice: 4.5,
    stockQty: 50,
    active: true,
  },
  {
    id: 'p2',
    sku: 'GL1002',
    description: 'Nitrile Gloves Powder Free Blue Large (Box 100)',
    uom: 'BOX',
    packSize: 100,
    defaultPrice: 4.75,
    stockQty: 50,
    active: true,
  },
  {
    id: 'p3',
    sku: 'CH2001',
    description: 'Thick Bleach 5L Lemon (Case 2)',
    uom: 'CASE',
    packSize: 2,
    defaultPrice: 12,
    stockQty: 3,
    active: true,
  },
  {
    id: 'p4',
    sku: 'CH2002',
    description: 'Thick Bleach 5L Lemon (Case 6)',
    uom: 'CASE',
    packSize: 6,
    defaultPrice: 33,
    stockQty: 3,
    active: true,
  },
  {
    id: 'p5',
    sku: 'OLD1',
    description: 'Discontinued Mop Head Red',
    uom: 'EACH',
    defaultPrice: 2,
    active: false,
  },
];
const brew: CatCustomer = {
  id: 'c1',
  accountCode: 'BREW001',
  name: 'Brew Cafe Ltd',
  emailDomains: ['brewcafe.example'],
  senderAddresses: ['orders@brewcafe.example'],
  deliveryAddresses: [{ line1: '1 High Street', city: 'Leeds', postcode: 'LS1 4AB' }],
  priceListCode: 'A',
  creditHold: false,
  trustedForAutoApprove: false,
};
const oak: CatCustomer = {
  ...brew,
  id: 'c2',
  accountCode: 'OAK001',
  name: 'Oak Kitchen',
  emailDomains: ['oakgroup.example'],
  senderAddresses: [],
  deliveryAddresses: [],
  priceListCode: undefined,
  creditHold: true,
};
const oak2: CatCustomer = {
  ...oak,
  id: 'c3',
  accountCode: 'OAK002',
  name: 'Oak Deli',
  creditHold: false,
};

const index = new CatalogueIndex({
  products,
  customers: [brew, oak, oak2],
  xrefs: [
    { customerId: 'c1', customerPartCode: 'BW-77', sku: 'GL1002', uomFactor: 1 },
    { customerId: 'c1', customerDescription: 'LARGE BLUE GLOVES', sku: 'GL1002', uomFactor: 1 },
  ],
  prices: [
    { customerId: 'c1', sku: 'GL1001', price: 4.1 },
    { customerId: 'c1', sku: 'GL1001', price: 3.9, minQty: 10 },
    { priceListCode: 'A', sku: 'CH2001', price: 11 },
  ],
});

const conf = { customerPartCode: 0.95, description: 0.95, quantity: 0.95, unitPrice: 0.95 };
const line = (over: Partial<ExtractedLine>): ExtractedLine => ({
  lineNo: 1,
  customerPartCode: null,
  description: null,
  quantity: 1,
  unit: null,
  unitPrice: null,
  lineTotal: null,
  confidence: conf,
  ...over,
});

describe('customer identification', () => {
  const none = { name: null, accountNumber: null, email: null };
  it('uses sender, then domain, then account number, then name', () => {
    expect(
      identifyCustomer(index, {
        fromAddress: 'orders@brewcafe.example',
        emailText: '',
        extracted: none,
      }),
    ).toMatchObject({ method: 'sender', confidence: 0.99, customer: { id: 'c1' } });
    expect(
      identifyCustomer(index, {
        fromAddress: 'someone.new@brewcafe.example',
        emailText: '',
        extracted: none,
      }),
    ).toMatchObject({ method: 'domain', customer: { id: 'c1' } });
    expect(
      identifyCustomer(index, {
        fromAddress: 'x@gmail.com',
        emailText: '',
        extracted: { ...none, accountNumber: 'oak002' },
      }),
    ).toMatchObject({ method: 'account_number', customer: { id: 'c3' } });
    expect(
      identifyCustomer(index, {
        fromAddress: 'x@gmail.com',
        emailText: '',
        extracted: { ...none, name: 'BREW CAFE' },
      }),
    ).toMatchObject({ method: 'name', customer: { id: 'c1' } });
  });

  it('does not guess when a shared domain or name is ambiguous, and never trusts public webmail domains', () => {
    const shared = identifyCustomer(index, {
      fromAddress: 'buyer@oakgroup.example',
      emailText: '',
      extracted: none,
    });
    expect(shared.customer).toBeUndefined();
    expect(shared.candidates.map((c) => c.customer.id).sort()).toEqual(['c2', 'c3']);
    // ...but the PO's account number settles it.
    expect(
      identifyCustomer(index, {
        fromAddress: 'buyer@oakgroup.example',
        emailText: '',
        extracted: { ...none, accountNumber: 'OAK001' },
      }).customer?.id,
    ).toBe('c2');
    expect(
      identifyCustomer(index, { fromAddress: 'brew@gmail.com', emailText: '', extracted: none })
        .customer,
    ).toBeUndefined();
  });

  it('flags a sender/account conflict and finds the original sender of a forwarded email', () => {
    expect(
      identifyCustomer(index, {
        fromAddress: 'orders@brewcafe.example',
        emailText: '',
        extracted: { ...none, accountNumber: 'OAK002' },
      }).conflict,
    ).toContain('OAK002');
    const fwd =
      'Can you do this?\n\n---------- Forwarded message ---------\nFrom: Sam <orders@brewcafe.example>\nSubject: Order';
    expect(forwardedSenders(fwd)).toEqual(['orders@brewcafe.example']);
    expect(
      identifyCustomer(index, {
        fromAddress: 'pat@distributor.example',
        emailText: fwd,
        extracted: none,
      }),
    ).toMatchObject({ method: 'forwarded_sender', customer: { id: 'c1' } });
  });
});

describe('line matching', () => {
  it('prefers learned cross-references, then our SKUs and barcodes', () => {
    expect(matchLine(index, brew, line({ customerPartCode: 'bw 77' }))).toMatchObject({
      method: 'xref_code',
      product: { sku: 'GL1002' },
      confidence: 0.98,
    });
    expect(matchLine(index, brew, line({ description: 'Large blue gloves' }))).toMatchObject({
      method: 'xref_description',
      product: { sku: 'GL1002' },
    });
    expect(
      matchLine(index, oak2, line({ customerPartCode: 'BW-77', description: 'gloves' })).method,
    ).not.toBe('xref_code'); // other customer's code
    expect(
      matchLine(
        index,
        undefined,
        line({ customerPartCode: 'gl1001', description: 'Blue nitrile gloves medium' }),
      ),
    ).toMatchObject({ method: 'sku', confidence: 0.95 });
    expect(matchLine(index, undefined, line({ customerPartCode: '5012345678900' }))).toMatchObject({
      method: 'barcode',
      product: { sku: 'GL1001' },
    });
  });

  it('distrusts a code that matches our SKU when the words disagree', () => {
    const m = matchLine(
      index,
      undefined,
      line({ customerPartCode: 'GL1001', description: 'Thick bleach 5 litre' }),
    );
    expect(m.confidence).toBeLessThan(0.6);
    expect(m.notes.map((n) => n.code)).toContain('code_description_mismatch');
  });

  it('fuzzy-matches descriptions, returns candidates, and refuses to guess between near-identical items', () => {
    const exact = matchLine(
      index,
      undefined,
      line({ description: 'Thick Bleach 5L Lemon (Case 6)' }),
    );
    expect(exact).toMatchObject({ method: 'fuzzy', product: { sku: 'CH2002' } });
    expect(exact.confidence).toBeGreaterThanOrEqual(0.9);
    const ambiguous = matchLine(
      index,
      undefined,
      line({ description: 'thick bleach 5 litre lemon' }),
    );
    expect(ambiguous.product).toBeUndefined();
    expect(ambiguous.candidates.map((c) => c.product.sku).sort()).toEqual(['CH2001', 'CH2002']);
    expect(
      matchLine(index, undefined, line({ description: 'Something we do not sell' })).product,
    ).toBeUndefined();
  });

  it('converts "each" orders into packs and flags part packs', () => {
    const whole = matchLine(
      index,
      undefined,
      line({ customerPartCode: 'GL1001', quantity: 300, unit: 'each' }),
    );
    expect(whole).toMatchObject({ factor: 0.01, convertedQuantity: 3, notes: [] });
    const part = matchLine(
      index,
      undefined,
      line({ customerPartCode: 'GL1001', quantity: 150, unit: 'pcs' }),
    );
    expect(part.convertedQuantity).toBe(1.5);
    expect(part.notes.map((n) => n.code)).toEqual(['pack_multiple']);
  });

  it('prices: quantity-break contract price, then price list, then list price', () => {
    expect(index.expectedPrice(brew, products[0]!, 12, new Date())).toEqual({
      price: 3.9,
      source: 'contract',
    });
    expect(index.expectedPrice(brew, products[0]!, 2, new Date())).toEqual({
      price: 4.1,
      source: 'contract',
    });
    expect(index.expectedPrice(brew, products[2]!, 1, new Date())).toEqual({
      price: 11,
      source: 'price_list',
    });
    expect(index.expectedPrice(oak, products[2]!, 1, new Date())).toEqual({
      price: 12,
      source: 'default',
    });
  });
});

const extracted = (over: Partial<ExtractedOrderDto> = {}): ExtractedOrderDto => ({
  customer: { name: 'Brew Cafe', accountNumber: null, email: null },
  poNumber: 'PO-1',
  orderDate: '2026-10-20',
  requestedDeliveryDate: null,
  deliveryAddress: {
    line1: '1 High Street',
    line2: null,
    city: 'Leeds',
    postcode: 'LS1 4AB',
    country: null,
  },
  notes: null,
  currency: 'GBP',
  lines: [
    line({
      lineNo: 1,
      customerPartCode: 'GL1001',
      description: 'Nitrile Gloves Blue Medium',
      quantity: 2,
      unitPrice: 4.1,
    }),
  ],
  documentTotals: { subtotal: null, tax: null, total: null },
  fieldConfidence: { customer: 0.9, poNumber: 0.9, orderDate: 0.9, deliveryAddress: 0.9 },
  confidence: 0.92,
  issues: [],
  ...over,
});
const brewMatch = identifyCustomer(index, {
  fromAddress: 'orders@brewcafe.example',
  emailText: '',
  extracted: { name: null, accountNumber: null, email: null },
});
const build = (
  over: Partial<ExtractedOrderDto> = {},
  opts: { isDuplicate?: boolean; customerMatch?: typeof brewMatch; highValue?: number } = {},
) =>
  buildOrderDraft(index, {
    extracted: extracted(over),
    customerMatch: opts.customerMatch ?? brewMatch,
    isDuplicate: opts.isDuplicate ?? false,
    settings: { ...DEFAULT_ROUTING, highValueThreshold: opts.highValue ?? null },
    now: new Date('2026-10-21T10:00:00Z'),
  });
const codes = (d: ReturnType<typeof build>) => d.issues.map((i) => i.code).sort();

describe('validation and routing', () => {
  it('routes a clean order from a known customer green / ready', () => {
    const d = build();
    expect(d).toMatchObject({ colour: 'green', status: 'ready', value: 8.2 });
    expect(d.lines[0]).toMatchObject({
      sku: 'GL1001',
      colour: 'green',
      expectedPrice: 4.1,
      priceSource: 'contract',
    });
    expect(d.issues).toEqual([]);
  });

  it('amber: price differences, part packs, inactive items, new addresses, high value, unknown customer', () => {
    expect(
      codes(build({ lines: [line({ customerPartCode: 'GL1001', quantity: 2, unitPrice: 5 })] })),
    ).toEqual(['price_mismatch']);
    expect(
      codes(
        build({
          deliveryAddress: {
            line1: 'Unit 9',
            line2: null,
            city: 'York',
            postcode: 'YO1 1AA',
            country: null,
          },
        }),
      ),
    ).toEqual(['new_delivery_address']);
    expect(
      codes(
        build({
          lines: [
            line({
              customerPartCode: 'OLD1',
              description: 'Discontinued mop head red',
              quantity: 1,
            }),
            line({ lineNo: 2, customerPartCode: 'GL1001', quantity: 1 }),
          ],
        }),
      ),
    ).toEqual(['sku_inactive']);
    expect(codes(build({}, { highValue: 5 }))).toEqual(['high_value']);
    const unknown = build({}, { customerMatch: { method: 'none', confidence: 0, candidates: [] } });
    expect(unknown).toMatchObject({ colour: 'amber', status: 'needs_review' });
    expect(codes(unknown)).toEqual(['customer_unknown', 'price_mismatch']); // no contract price without a customer
    expect(
      build({ lines: [line({ customerPartCode: 'GL1001', quantity: 2 })] }).issues.find(
        (i) => i.code === 'insufficient_stock',
      ),
    ).toBeUndefined();
    const stock = build({
      lines: [
        line({ customerPartCode: 'CH2001', description: 'Thick bleach 5L lemon', quantity: 10 }),
      ],
    });
    expect(stock.issues.find((i) => i.code === 'insufficient_stock')).toMatchObject({
      severity: 'info',
    });
  });

  it('red: credit hold, duplicate PO, mostly unknown items, unreadable', () => {
    const hold = build(
      {},
      { customerMatch: { customer: oak, method: 'sender', confidence: 0.99, candidates: [] } },
    );
    expect(hold).toMatchObject({ colour: 'red', status: 'on_hold' });
    expect(hold.issues.find((i) => i.code === 'credit_hold')).toMatchObject({ blocking: true });
    expect(build({}, { isDuplicate: true })).toMatchObject({ colour: 'red', status: 'duplicate' });
    const unknownItems = build({
      lines: [
        line({ description: 'Widgets' }),
        line({ lineNo: 2, description: 'Gizmos' }),
        line({ lineNo: 3, customerPartCode: 'GL1001' }),
      ],
    });
    expect(unknownItems).toMatchObject({ colour: 'red', status: 'on_hold' });
    expect(codes(unknownItems)).toContain('unknown_items');
    expect(
      build({
        lines: [],
        issues: [{ code: 'no_lines', severity: 'error', message: 'No order lines were found' }],
      }),
    ).toMatchObject({ colour: 'red' });
  });

  it('a resolved issue no longer counts', () => {
    const r = routeOrder({
      lines: [{ lineNo: 1, matchConfidence: 0.98, quantity: 2, sku: 'GL1001' }],
      issues: [
        { code: 'price_mismatch', severity: 'warning', blocking: false, resolved: true, lineNo: 1 },
      ],
      customerConfidence: 0.99,
      extractionConfidence: 0.9,
      settings: DEFAULT_ROUTING,
    });
    expect(r).toMatchObject({ colour: 'green', status: 'ready' });
  });
});
