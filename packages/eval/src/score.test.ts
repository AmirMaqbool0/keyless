import { describe, expect, it } from 'vitest';
import type { ExtractedOrder } from '@keyless/shared';
import { jaccard, scoreOrders, summarise } from './score';
import type { ExpectedOrder } from './types';

const expected: ExpectedOrder = {
  customerName: 'Brew Cafe',
  accountNumber: null,
  poNumber: 'PO-1',
  orderDate: '2026-10-20',
  requestedDeliveryDate: null,
  deliveryAddress: { line1: '1 High Street', postcode: 'LS1 4AB' },
  currency: 'GBP',
  totals: { subtotal: 10, tax: null, total: null },
  lines: [
    {
      customerPartCode: 'A-1',
      description: 'Blue nitrile gloves medium',
      quantity: 2,
      unit: null,
      unitPrice: 5,
      expectedSku: 'GL1',
    },
    {
      customerPartCode: 'B-2',
      description: 'Black sacks',
      quantity: 1,
      unit: null,
      unitPrice: null,
      expectedSku: 'BL1',
    },
  ],
};

const conf = { customerPartCode: 1, description: 1, quantity: 1, unitPrice: 1 };
const actual: ExtractedOrder = {
  customer: { name: 'brew  cafe', accountNumber: null, email: null },
  poNumber: 'po1',
  orderDate: '2026-10-20',
  requestedDeliveryDate: '2026-10-25', // invented
  deliveryAddress: {
    line1: '1 High Street',
    line2: null,
    city: null,
    postcode: 'ls14ab',
    country: null,
  },
  notes: null,
  currency: 'GBP',
  lines: [
    {
      lineNo: 1,
      customerPartCode: 'a1',
      description: 'Nitrile gloves blue medium',
      quantity: 2,
      unit: null,
      unitPrice: 5,
      lineTotal: 10,
      confidence: conf,
    },
    {
      lineNo: 2,
      customerPartCode: 'Z9',
      description: 'Something else',
      quantity: 3,
      unit: null,
      unitPrice: null,
      lineTotal: null,
      confidence: conf,
    },
  ],
  documentTotals: { subtotal: 10, tax: null, total: null },
  fieldConfidence: { customer: 1, poNumber: 1, orderDate: 1, deliveryAddress: 1 },
};

describe('eval scoring', () => {
  it('is lenient on formatting but punishes invented values and wrong lines', () => {
    const [o] = scoreOrders([expected], [actual]);
    const wrong = o!.header.filter((f) => !f.ok).map((f) => f.field);
    expect(wrong).toEqual(['requestedDeliveryDate']);
    const s = summarise(scoreOrders([expected], [actual]));
    expect(s.lineRecall).toEqual({ ok: 1, total: 2 });
    expect(s.linePrecision).toEqual({ ok: 1, total: 2 });
    expect(s.perfect).toBe(false);
  });

  it('counts a missing order against every header field', () => {
    const s = summarise(scoreOrders([expected], []));
    expect(s.ordersFound).toEqual({ ok: 0, total: 1 });
    expect(s.header.ok).toBe(0);
    expect(s.header.total).toBeGreaterThan(0);
  });

  it('compares descriptions by word overlap', () => {
    expect(jaccard('Nitrile Gloves Blue (Box 100)', 'nitrile gloves blue box 100')).toBe(1);
    expect(jaccard('Nitrile Gloves', 'Refuse Sacks')).toBe(0);
  });
});
