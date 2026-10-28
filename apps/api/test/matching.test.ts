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
  {
    id: 'p6',
    sku: 'GL1003',
    description: 'Nitrile Gloves Powder Free Blue Medium',
    uom: 'EACH',
    packSize: 100,
    defaultPrice: 0.05,
    stockQty: 5000,
    active: true,
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

  describe('P1-4: Uploaded documents and internal forwards customer identification', () => {
    it('manual upload (isUpload: true) ignores uploader email and matches customer by account number', () => {
      const match = identifyCustomer(index, {
        fromAddress: 'sarah.distributor@example.com',
        emailText: 'Uploaded to Keyless',
        extracted: { ...none, accountNumber: 'BREW001' },
        isUpload: true,
      });
      expect(match).toMatchObject({
        method: 'account_number',
        confidence: 0.95,
        customer: { id: 'c1' },
      });
    });

    it('manual upload matches customer by extracted name when account number is absent', () => {
      const match = identifyCustomer(index, {
        fromAddress: 'sarah.distributor@example.com',
        emailText: 'Uploaded to Keyless',
        extracted: { ...none, name: 'Brew Cafe Ltd' },
        isUpload: true,
      });
      expect(match).toMatchObject({
        method: 'name',
        confidence: 0.85,
        customer: { id: 'c1' },
      });
    });

    it('manual upload matches customer by delivery address / postcode when name and account number are absent', () => {
      const match = identifyCustomer(index, {
        fromAddress: 'sarah.distributor@example.com',
        emailText: 'Uploaded to Keyless',
        extracted: none,
        deliveryAddress: {
          line1: '1 High Street',
          city: 'Leeds',
          postcode: 'LS1 4AB',
          line2: null,
          country: null,
        },
        isUpload: true,
      });
      expect(match).toMatchObject({
        method: 'delivery_address',
        confidence: 0.85,
        customer: { id: 'c1' },
      });
    });

    it('email sent from internal domain ignores staff sender and matches customer from document', () => {
      const match = identifyCustomer(index, {
        fromAddress: 'john@distributor.example',
        emailText: 'Please see attached order from customer',
        extracted: { ...none, accountNumber: 'OAK001' },
        orgInternalDomains: new Set(['distributor.example']),
      });
      expect(match).toMatchObject({
        method: 'account_number',
        customer: { id: 'c2' },
      });
    });
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
    expect(whole).toMatchObject({ factor: 0.01, convertedQuantity: 3 });
    expect(whole.notes.map((n) => n.code)).toEqual(['uom_conversion']);
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
      codes(
        build({
          lines: [
            line({
              customerPartCode: 'GL1001',
              description: 'Nitrile Gloves Blue Medium',
              quantity: 2,
              unitPrice: 5,
            }),
          ],
        }),
      ),
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
            line({
              lineNo: 2,
              customerPartCode: 'GL1001',
              description: 'Nitrile Gloves Blue Medium',
              quantity: 1,
            }),
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

  describe('P0-1: Unit of measure and pack-size conversions', () => {
    it('10 x (Box 100) matched to Box 100 SKU, unit null -> ourQty 10, factor 1, no conversion warning', () => {
      const draft = build({
        lines: [
          line({
            description: 'Nitrile Gloves Powder Free Blue Large (Box 100)',
            quantity: 10,
            unit: null,
          }),
        ],
      });
      const l = draft.lines[0]!;
      expect(l.sku).toBe('GL1002');
      expect(l.conversionFactor).toBe(1);
      expect(l.convertedQuantity).toBe(10);
      expect(draft.issues.find((i) => i.code === 'uom_conversion')).toBeUndefined();
    });

    it('10 "boxes" matched to a SKU sold "each" with pack 100 -> ourQty 1000, factor 100, conversion warning present', () => {
      const draft = build({
        lines: [
          line({
            description: 'Nitrile Gloves Powder Free Blue Medium',
            customerPartCode: 'GL1003',
            quantity: 10,
            unit: 'boxes',
          }),
        ],
      });
      const l = draft.lines[0]!;
      expect(l.sku).toBe('GL1003');
      expect(l.conversionFactor).toBe(100);
      expect(l.convertedQuantity).toBe(1000);
      const warn = draft.issues.find((i) => i.code === 'uom_conversion');
      expect(warn).toBeDefined();
      expect(warn?.severity).toBe('warning');
      expect(l.colour).toBe('amber');
    });

    it('500 "each" matched to a Box 100 SKU -> ourQty 5, factor 0.01, warning present; non-integer result -> blocking issue', () => {
      // 500 each -> 5 boxes
      const draft500 = build({
        lines: [
          line({
            customerPartCode: 'GL1002',
            description: 'Nitrile Gloves Powder Free Blue Large',
            quantity: 500,
            unit: 'each',
          }),
        ],
      });
      const l500 = draft500.lines[0]!;
      expect(l500.sku).toBe('GL1002');
      expect(l500.conversionFactor).toBe(0.01);
      expect(l500.convertedQuantity).toBe(5);
      expect(draft500.issues.find((i) => i.code === 'uom_conversion')).toBeDefined();

      // Non-integer: 550 each -> 5.5 boxes -> blocking issue
      const draft550 = build({
        lines: [
          line({
            customerPartCode: 'GL1002',
            description: 'Nitrile Gloves Powder Free Blue Large',
            quantity: 550,
            unit: 'each',
          }),
        ],
      });
      const l550 = draft550.lines[0]!;
      expect(l550.convertedQuantity).toBe(5.5);
      const blocking = draft550.issues.find((i) => i.code === 'pack_multiple');
      expect(blocking).toBeDefined();
      expect(blocking?.severity).toBe('error');
      expect(blocking?.blocking).toBe(true);
      expect(draft550.colour).toBe('red');
      expect(draft550.status).toBe('on_hold');
    });

    it('Learned CrossReference stores the factor the reviewer saved, not a computed default', () => {
      // Create index with an xref that has a custom saved factor (e.g. 0.5)
      const customIndex = new CatalogueIndex({
        products,
        customers: [brew],
        xrefs: [
          {
            customerId: 'c1',
            customerPartCode: 'CUSTOM-GLOVE',
            sku: 'GL1002',
            uomFactor: 2.5,
          },
        ],
        prices: [],
      });
      const m = matchLine(
        customIndex,
        brew,
        line({ customerPartCode: 'CUSTOM-GLOVE', quantity: 4 }),
      );
      expect(m.product?.sku).toBe('GL1002');
      expect(m.method).toBe('xref_code');
      expect(m.factor).toBe(2.5);
      expect(m.convertedQuantity).toBe(10);
      // Confirmed xref factor does not generate a warning
      expect(m.notes.find((n) => n.code === 'uom_conversion')).toBeUndefined();
    });
  });

  describe('P0-2: Exact SKU-code match with description mismatch', () => {
    const p02Products: CatProduct[] = [
      {
        id: 'p-gl1001',
        sku: 'GL1001',
        description: 'ProClean Polythene Gloves Powder Free Black Large (Box 200)',
        uom: 'BOX',
        packSize: 200,
        defaultPrice: 3.5,
        stockQty: 50,
        active: true,
      },
      {
        id: 'p-gl1459',
        sku: 'GL1459',
        description: 'Caterpak Nitrile Gloves Powder Free Blue Medium (Box 100)',
        uom: 'BOX',
        packSize: 100,
        defaultPrice: 6.8,
        stockQty: 50,
        active: true,
      },
      {
        id: 'p-ch1825',
        sku: 'CH1825',
        description: 'Hygenix Thick Bleach 750ml Original (Case 2)',
        uom: 'CASE',
        packSize: 2,
        defaultPrice: 5.5,
        stockQty: 30,
        active: true,
      },
    ];

    const p02Index = new CatalogueIndex({
      products: p02Products,
      customers: [brew],
      xrefs: [],
      prices: [],
    });

    it('Code GL1001 + "Nitrile Gloves Blue Medium" vs catalogue GL1001 "Polythene Gloves Black Large" -> amber, confidence <= 0.4, code_description_mismatch issue', () => {
      const draft = buildOrderDraft(p02Index, {
        extracted: extracted({
          poNumber: 'PO-884920',
          lines: [
            line({
              customerPartCode: 'GL1001',
              description: 'Nitrile Gloves Powder Free Blue Medium (Box 100)',
              quantity: 10,
            }),
          ],
        }),
        customerMatch: { customer: brew, method: 'sender', confidence: 0.99, candidates: [] },
        isDuplicate: false,
        settings: DEFAULT_ROUTING,
        now: new Date(),
      });

      const l = draft.lines[0]!;
      expect(l.matchConfidence).toBeLessThanOrEqual(0.4);
      expect(l.colour).toBe('amber');
      const mismatchIssue = draft.issues.find((i) => i.code === 'code_description_mismatch');
      expect(mismatchIssue).toBeDefined();
      expect(mismatchIssue?.severity).toBe('warning');
      expect(l.candidates[0]?.sku).toBe('GL1459');
    });

    it('Code CH1825 + "Hygenix Thick Bleach 750ml Original (Case 2)" vs identical catalogue description -> green, confidence >= 0.95, no issue', () => {
      const draft = buildOrderDraft(p02Index, {
        extracted: extracted({
          poNumber: 'PO-471855',
          lines: [
            line({
              customerPartCode: 'CH1825',
              description: 'Hygenix Thick Bleach 750ml Original (Case 2)',
              quantity: 5,
            }),
          ],
        }),
        customerMatch: { customer: brew, method: 'sender', confidence: 0.99, candidates: [] },
        isDuplicate: false,
        settings: DEFAULT_ROUTING,
        now: new Date(),
      });

      const l = draft.lines[0]!;
      expect(l.matchConfidence).toBeGreaterThanOrEqual(0.95);
      expect(l.colour).toBe('green');
      expect(draft.issues.find((i) => i.code === 'code_description_mismatch')).toBeUndefined();
    });

    it('Code match with no customer description at all -> keep current behaviour but cap confidence at 0.85', () => {
      const m = matchLine(
        p02Index,
        undefined,
        line({
          customerPartCode: 'CH1825',
          description: null,
          quantity: 2,
        }),
      );
      expect(m.product?.sku).toBe('CH1825');
      expect(m.method).toBe('sku');
      expect(m.confidence).toBe(0.85);
      expect(m.notes.find((n) => n.code === 'code_description_mismatch')).toBeUndefined();
    });
  });

  describe('P1-1: Order value calculation (PO line totals vs expected prices)', () => {
    const p11Index = new CatalogueIndex({
      products: [
        {
          id: 'p-gl1001',
          sku: 'GL1001',
          description: 'Nitrile Gloves Powder Free Blue Medium',
          uom: 'BOX',
          packSize: 100,
          defaultPrice: 10.75,
          stockQty: 100,
          active: true,
        },
        {
          id: 'p-ch1825',
          sku: 'CH1825',
          description: 'Hygenix Thick Bleach 750ml Original (Case 2)',
          uom: 'CASE',
          packSize: 2,
          defaultPrice: 3.25,
          stockQty: 50,
          active: true,
        },
      ],
      customers: [brew],
      xrefs: [],
      prices: [],
    });

    it('PO-771204: produces £102.50 (sum of PO line totals / qty * unitPrice) instead of catalogue list price £247.50', () => {
      const draft = buildOrderDraft(p11Index, {
        extracted: extracted({
          poNumber: 'PO-771204',
          lines: [
            line({
              customerPartCode: 'GL1001',
              description: 'Nitrile Gloves Powder Free Blue Medium',
              quantity: 20,
              unitPrice: 4.5,
              lineTotal: 90.0,
            }),
            line({
              customerPartCode: 'CH1825',
              description: 'Hygenix Thick Bleach 750ml Original (Case 2)',
              quantity: 10,
              unitPrice: 1.25,
              lineTotal: 12.5,
            }),
          ],
        }),
        customerMatch: { customer: brew, method: 'sender', confidence: 0.99, candidates: [] },
        isDuplicate: false,
        settings: DEFAULT_ROUTING,
        now: new Date(),
      });

      expect(draft.value).toBe(102.5);
      expect(draft.valueEstimated).toBe(false);
      expect(draft.expectedValue).toBe(247.5);
    });

    it('PO-884920: produces £64.50 from PO line totals and does not fluctuate when customer is assigned', () => {
      const draft = buildOrderDraft(p11Index, {
        extracted: extracted({
          poNumber: 'PO-884920',
          lines: [
            line({
              customerPartCode: 'GL1001',
              description: 'Nitrile Gloves Powder Free Blue Medium',
              quantity: 10,
              unitPrice: 6.45,
              lineTotal: 64.5,
            }),
          ],
        }),
        customerMatch: { customer: brew, method: 'sender', confidence: 0.99, candidates: [] },
        isDuplicate: false,
        settings: DEFAULT_ROUTING,
        now: new Date(),
      });

      expect(draft.value).toBe(64.5);
      expect(draft.valueEstimated).toBe(false);
    });

    it('Missing PO line price falls back to expected price and marks value as estimated', () => {
      const draft = buildOrderDraft(p11Index, {
        extracted: extracted({
          poNumber: 'PO-ESTIMATED',
          lines: [
            line({
              customerPartCode: 'GL1001',
              description: 'Nitrile Gloves Powder Free Blue Medium',
              quantity: 2,
              unitPrice: null,
              lineTotal: null,
            }),
          ],
        }),
        customerMatch: { customer: brew, method: 'sender', confidence: 0.99, candidates: [] },
        isDuplicate: false,
        settings: DEFAULT_ROUTING,
        now: new Date(),
      });

      expect(draft.value).toBe(21.5);
      expect(draft.valueEstimated).toBe(true);
      expect(draft.expectedValue).toBe(21.5);
    });
  });

  describe('P1-3: Order confidence and weakest-area queue hints', () => {
    const p13Index = new CatalogueIndex({
      products: [
        {
          id: 'p-gl1001',
          sku: 'GL1001',
          description: 'Nitrile Gloves Powder Free Blue Medium',
          uom: 'BOX',
          packSize: 100,
          defaultPrice: 10.75,
          stockQty: 100,
          active: true,
        },
      ],
      customers: [brew],
      xrefs: [],
      prices: [],
    });

    it('PO with high extraction and line match but unknown customer gives 80% amber (not 0%) and "Customer unknown" hint', () => {
      const draft = buildOrderDraft(p13Index, {
        extracted: extracted({
          poNumber: 'PO-884920',
          confidence: 1.0,
          lines: [
            line({
              customerPartCode: 'GL1001',
              description: 'Nitrile Gloves Powder Free Blue Medium',
              quantity: 2,
              unitPrice: 10.75,
              lineTotal: 21.5,
            }),
          ],
        }),
        customerMatch: { method: 'none', confidence: 0, candidates: [] },
        isDuplicate: false,
        settings: DEFAULT_ROUTING,
        now: new Date(),
      });

      // Customer unknown: weighted combination (50% lines + 30% extraction + 20% customer)
      // 0.50 * 0.95 + 0.30 * 1.0 + 0.20 * 0 = 0.475 + 0.30 = 0.78 (or 0.80) -> NOT 0%!
      expect(draft.confidence).toBeGreaterThanOrEqual(0.75);
      expect(draft.confidence).toBeLessThanOrEqual(0.85);
      expect(draft.colour).toBe('amber');
      expect(draft.status).toBe('needs_review');
      expect(draft.confidenceHint).toBe('Customer unknown');
    });

    it('PO with verified customer but unmatched lines gives low confidence and "Unmatched lines" hint', () => {
      const draft = buildOrderDraft(p13Index, {
        extracted: extracted({
          poNumber: 'PO-UNMATCHED',
          confidence: 1.0,
          lines: [
            line({
              customerPartCode: 'GL1001',
              description: 'Nitrile Gloves Powder Free Blue Medium',
              quantity: 2,
              unitPrice: 10.75,
              lineTotal: 21.5,
            }),
            line({
              customerPartCode: 'NONEXISTENT-999',
              description: 'Something totally absent from catalogue',
              quantity: 5,
              unitPrice: 10,
              lineTotal: 50,
            }),
          ],
        }),
        customerMatch: { customer: brew, method: 'sender', confidence: 0.99, candidates: [] },
        isDuplicate: false,
        settings: DEFAULT_ROUTING,
        now: new Date(),
      });

      expect(draft.confidence).toBeLessThan(0.8);
      expect(draft.colour).toBe('amber');
      expect(draft.confidenceHint).toBe('Unmatched lines');
    });

    it('PO with high confidence across all components has null hint and green status', () => {
      const draft = buildOrderDraft(p13Index, {
        extracted: extracted({
          poNumber: 'PO-GREEN',
          confidence: 0.98,
          lines: [
            line({
              customerPartCode: 'GL1001',
              description: 'Nitrile Gloves Powder Free Blue Medium',
              quantity: 2,
              unitPrice: 10.75,
              lineTotal: 21.5,
            }),
          ],
        }),
        customerMatch: { customer: brew, method: 'sender', confidence: 0.99, candidates: [] },
        isDuplicate: false,
        settings: DEFAULT_ROUTING,
        now: new Date(),
      });

      expect(draft.confidence).toBeGreaterThanOrEqual(0.95);
      expect(draft.colour).toBe('green');
      expect(draft.status).toBe('ready');
      expect(draft.confidenceHint).toBeNull();
    });
  });
});

