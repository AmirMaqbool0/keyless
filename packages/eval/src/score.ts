import type { ExtractedOrder } from '@keyless/shared';
import type { ExpectedLine, ExpectedOrder } from './types';

/*
 * Scoring rules
 * - A field counts when the truth or the extraction has a value; null vs null is not counted.
 *   So an invented value (truth null, extracted "x") is wrong, which is what we want to punish.
 * - Strings compare case- and whitespace-insensitively; codes also ignore separators.
 * - Descriptions are right when their word overlap (Jaccard) is >= 0.7.
 * - Numbers are right within 0.01.
 * - Orders pair by PO number (else by position); lines by code (else best description).
 */

export type FieldResult = { field: string; expected: unknown; actual: unknown; ok: boolean };
export type LineResult = {
  expected: ExpectedLine | null;
  actual: ExtractedOrder['lines'][number] | null;
  fields: FieldResult[];
};
export type OrderResult = {
  expected: ExpectedOrder | null;
  actual: ExtractedOrder | null;
  header: FieldResult[];
  lines: LineResult[];
};

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const codeKey = (s: string | null | undefined) =>
  (s ?? '').toUpperCase().replace(/[\s\-._/\\]+/g, '');
const words = (s: string | null | undefined) =>
  new Set(
    norm(s)
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(' ')
      .filter(Boolean),
  );
const singular = (s: string | null | undefined) => norm(s).replace(/(es|s)$/, '');

export function jaccard(a: string | null | undefined, b: string | null | undefined): number {
  const A = words(a);
  const B = words(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}

type Cmp = 'text' | 'code' | 'number' | 'date' | 'postcode' | 'description' | 'unit';

function same(kind: Cmp, e: unknown, a: unknown): boolean {
  const isNull = (v: unknown) => v === null || v === undefined || v === '';
  if (isNull(e) && isNull(a)) return true;
  if (isNull(e) || isNull(a)) return false;
  switch (kind) {
    case 'number':
      return Math.abs(Number(e) - Number(a)) <= 0.01;
    case 'code':
      return codeKey(String(e)) === codeKey(String(a));
    case 'postcode':
      return (
        String(e).toUpperCase().replace(/\s/g, '') === String(a).toUpperCase().replace(/\s/g, '')
      );
    case 'description':
      return jaccard(String(e), String(a)) >= 0.7;
    case 'unit':
      return singular(String(e)) === singular(String(a));
    default:
      return norm(String(e)) === norm(String(a));
  }
}

function field(name: string, kind: Cmp, e: unknown, a: unknown, out: FieldResult[]): void {
  const counted = !(e === null || e === undefined) || !(a === null || a === undefined || a === '');
  if (counted)
    out.push({ field: name, expected: e ?? null, actual: a ?? null, ok: same(kind, e, a) });
}

function scoreLines(expected: ExpectedLine[], actual: ExtractedOrder['lines']): LineResult[] {
  const remaining = [...actual];
  const results: LineResult[] = [];
  for (const e of expected) {
    let i = e.customerPartCode
      ? remaining.findIndex((a) => codeKey(a.customerPartCode) === codeKey(e.customerPartCode))
      : -1;
    if (i === -1) {
      let best = -1;
      let bestScore = 0.4;
      remaining.forEach((a, k) => {
        const s = jaccard(e.description, a.description);
        if (s > bestScore) [best, bestScore] = [k, s];
      });
      i = best;
    }
    const a = i >= 0 ? remaining.splice(i, 1)[0]! : null;
    const fields: FieldResult[] = [];
    if (a) {
      field('code', 'code', e.customerPartCode, a.customerPartCode, fields);
      field('description', 'description', e.description, a.description, fields);
      field('quantity', 'number', e.quantity, a.quantity, fields);
      field('unit', 'unit', e.unit, a.unit, fields);
      field('unitPrice', 'number', e.unitPrice, a.unitPrice, fields);
    }
    results.push({ expected: e, actual: a, fields });
  }
  for (const a of remaining) results.push({ expected: null, actual: a, fields: [] });
  return results;
}

export function scoreOrders(expected: ExpectedOrder[], actual: ExtractedOrder[]): OrderResult[] {
  const remaining = [...actual];
  const results: OrderResult[] = [];
  for (const [idx, e] of expected.entries()) {
    let i = e.poNumber
      ? remaining.findIndex((a) => codeKey(a.poNumber) === codeKey(e.poNumber))
      : -1;
    if (i === -1 && remaining.length && actual.length === expected.length)
      i = Math.min(idx, remaining.length - 1);
    if (i === -1 && remaining.length && expected.length === 1) i = 0;
    const a = i >= 0 ? remaining.splice(i, 1)[0]! : null;
    const header: FieldResult[] = [];
    if (a) {
      field('customerName', 'text', e.customerName, a.customer.name, header);
      field('accountNumber', 'code', e.accountNumber, a.customer.accountNumber, header);
      field('poNumber', 'code', e.poNumber, a.poNumber, header);
      field('orderDate', 'date', e.orderDate, a.orderDate, header);
      field(
        'requestedDeliveryDate',
        'date',
        e.requestedDeliveryDate,
        a.requestedDeliveryDate,
        header,
      );
      field(
        'deliveryAddress.line1',
        'text',
        e.deliveryAddress.line1,
        a.deliveryAddress.line1,
        header,
      );
      field(
        'deliveryAddress.postcode',
        'postcode',
        e.deliveryAddress.postcode,
        a.deliveryAddress.postcode,
        header,
      );
      field('currency', 'text', e.currency, a.currency, header);
      field('subtotal', 'number', e.totals.subtotal, a.documentTotals.subtotal, header);
      field('tax', 'number', e.totals.tax, a.documentTotals.tax, header);
      field('total', 'number', e.totals.total, a.documentTotals.total, header);
    }
    results.push({
      expected: e,
      actual: a,
      header,
      lines: a
        ? scoreLines(e.lines, a.lines)
        : e.lines.map((l) => ({ expected: l, actual: null, fields: [] })),
    });
  }
  for (const a of remaining)
    results.push({
      expected: null,
      actual: a,
      header: [],
      lines: a.lines.map((l) => ({ expected: null, actual: l, fields: [] })),
    });
  return results;
}

export type Tally = { ok: number; total: number };
export const rate = (t: Tally) => (t.total ? t.ok / t.total : 1);

export type FixtureScore = {
  header: Tally;
  lineFields: Tally;
  /** Expected lines that were found. */
  lineRecall: Tally;
  /** Extracted lines that correspond to a real line. */
  linePrecision: Tally;
  ordersFound: Tally;
  perfect: boolean;
};

export function summarise(orders: OrderResult[]): FixtureScore {
  const s: FixtureScore = {
    header: { ok: 0, total: 0 },
    lineFields: { ok: 0, total: 0 },
    lineRecall: { ok: 0, total: 0 },
    linePrecision: { ok: 0, total: 0 },
    ordersFound: { ok: 0, total: 0 },
    perfect: true,
  };
  for (const o of orders) {
    if (o.expected) {
      s.ordersFound.total += 1;
      if (o.actual) s.ordersFound.ok += 1;
    } else s.perfect = false;
    // A missing order counts all of its header fields as wrong.
    if (o.expected && !o.actual) s.header.total += 11;
    for (const f of o.header) {
      s.header.total += 1;
      if (f.ok) s.header.ok += 1;
    }
    for (const l of o.lines) {
      if (l.expected) {
        s.lineRecall.total += 1;
        if (l.actual) s.lineRecall.ok += 1;
        // A missing line counts its fields as wrong too.
        if (!l.actual) s.lineFields.total += 3;
      }
      if (l.actual) {
        s.linePrecision.total += 1;
        if (l.expected) s.linePrecision.ok += 1;
      }
      for (const f of l.fields) {
        s.lineFields.total += 1;
        if (f.ok) s.lineFields.ok += 1;
      }
    }
  }
  s.perfect =
    s.perfect &&
    s.header.ok === s.header.total &&
    s.lineFields.ok === s.lineFields.total &&
    s.lineRecall.ok === s.lineRecall.total &&
    s.linePrecision.ok === s.linePrecision.total &&
    s.ordersFound.ok === s.ordersFound.total;
  return s;
}
