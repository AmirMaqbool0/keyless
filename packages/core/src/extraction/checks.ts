import type { ExtractedOrder, ExtractionIssue } from '@keyless/shared';
import { countTableRows } from '../llm/ruleExtractor';

/*
 * Deterministic checks on an extracted order (spec section 6). They never change the data; they
 * add issues and lower the confidence so routing (M5) sends doubtful orders to a human.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;

function validIsoDate(s: string | null): Date | null {
  if (!s || !ISO.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return d.toISOString().slice(0, 10) === s ? d : null;
}

const close = (a: number, b: number, relTol: number, absTol: number) =>
  Math.abs(a - b) <= Math.max(absTol, Math.abs(b) * relTol);
const money = (n: number) => n.toFixed(2);

export type CheckContext = {
  now: Date;
  /** The prepared document text, when there is one: lets us count the rows independently. */
  documentText: string | null;
  /** True when the document holds several orders (row counts can't be compared per order). */
  multiOrder: boolean;
};

export function checkOrder(
  order: ExtractedOrder,
  ctx: CheckContext,
): { issues: ExtractionIssue[]; confidence: number } {
  const issues: ExtractionIssue[] = [];
  const add = (
    code: string,
    severity: ExtractionIssue['severity'],
    message: string,
    lineNo?: number,
  ) => issues.push({ code, severity, message, ...(lineNo ? { lineNo } : {}) });

  if (!order.lines.length) add('no_lines', 'error', 'No order lines were found');
  if (!order.poNumber) add('missing_po_number', 'warning', 'No PO number found');

  for (const line of order.lines) {
    if (line.quantity === null) add('missing_quantity', 'error', 'Quantity missing', line.lineNo);
    else if (line.quantity <= 0)
      add('invalid_quantity', 'error', `Quantity ${line.quantity} is not positive`, line.lineNo);
    if (!line.customerPartCode && !line.description)
      add('unidentifiable_line', 'error', 'Line has neither a code nor a description', line.lineNo);
    if (line.unitPrice !== null && line.unitPrice < 0)
      add('negative_price', 'error', 'Negative unit price', line.lineNo);
    if (
      line.quantity !== null &&
      line.unitPrice !== null &&
      line.lineTotal !== null &&
      !close(line.quantity * line.unitPrice, line.lineTotal, 0.01, 0.02)
    ) {
      add(
        'line_total_mismatch',
        'warning',
        `${line.quantity} x ${money(line.unitPrice)} = ${money(line.quantity * line.unitPrice)}, but the line total says ${money(line.lineTotal)}`,
        line.lineNo,
      );
    }
  }

  // Lines add up to the document's subtotal (or total when there is no tax line).
  const lineSum = order.lines.reduce(
    (s, l) =>
      s +
      (l.lineTotal ??
        (l.quantity !== null && l.unitPrice !== null ? l.quantity * l.unitPrice : NaN)),
    0,
  );
  const target =
    order.documentTotals.subtotal ??
    (order.documentTotals.tax === null ? order.documentTotals.total : null);
  if (target !== null && Number.isFinite(lineSum) && !close(lineSum, target, 0.01, 0.05)) {
    add(
      'subtotal_mismatch',
      'warning',
      `Lines add up to ${money(lineSum)} but the document says ${money(target)}`,
    );
  }
  const { subtotal, tax, total } = order.documentTotals;
  if (
    subtotal !== null &&
    tax !== null &&
    total !== null &&
    !close(subtotal + tax, total, 0.005, 0.05)
  ) {
    add(
      'total_mismatch',
      'warning',
      `Subtotal ${money(subtotal)} + tax ${money(tax)} does not equal total ${money(total)}`,
    );
  }

  // Line count against an independent count of the document's table rows.
  if (!ctx.multiOrder && ctx.documentText) {
    const rows = countTableRows(ctx.documentText);
    if (rows !== null && rows !== order.lines.length) {
      add(
        'line_count_mismatch',
        'warning',
        `The document's table has ${rows} rows but ${order.lines.length} lines were extracted`,
      );
    }
  }

  const orderDate = validIsoDate(order.orderDate);
  const delivery = validIsoDate(order.requestedDeliveryDate);
  if (order.orderDate && !orderDate)
    add('invalid_date', 'warning', `Order date "${order.orderDate}" is not a valid date`);
  if (order.requestedDeliveryDate && !delivery)
    add(
      'invalid_date',
      'warning',
      `Delivery date "${order.requestedDeliveryDate}" is not a valid date`,
    );
  if (orderDate && orderDate.getTime() > ctx.now.getTime() + 2 * DAY)
    add('order_date_future', 'warning', 'Order date is in the future');
  if (orderDate && orderDate.getTime() < ctx.now.getTime() - 365 * DAY)
    add('order_date_old', 'info', 'Order date is more than a year ago');
  if (delivery && orderDate && delivery < orderDate)
    add('delivery_before_order', 'warning', 'Requested delivery is before the order date');
  if (delivery && delivery.getTime() < ctx.now.getTime() - DAY)
    add('delivery_in_past', 'warning', 'Requested delivery date has passed');

  // Confidence: the model's own field confidences, pulled down by every problem found.
  const fieldConfs = [
    order.fieldConfidence.poNumber,
    order.fieldConfidence.customer,
    order.fieldConfidence.deliveryAddress,
  ];
  const lineConfs = order.lines.map((l) =>
    Math.min(
      l.confidence.quantity,
      Math.max(l.confidence.customerPartCode, l.confidence.description),
    ),
  );
  const all = [...fieldConfs, ...lineConfs].map((c) => Math.min(1, Math.max(0, c)));
  let confidence = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0;
  if (lineConfs.length) confidence = Math.min(confidence, Math.min(...lineConfs) + 0.2);
  for (const i of issues)
    confidence *= i.severity === 'error' ? 0.6 : i.severity === 'warning' ? 0.85 : 1;
  return { issues, confidence: Math.round(confidence * 100) / 100 };
}
