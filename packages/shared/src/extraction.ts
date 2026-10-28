import { z } from 'zod';

/*
 * What the LLM returns for one document (spec section 6). Deliberately loose: every value is
 * nullable so "not on the document" is representable and nothing has to be invented. Business
 * rules (positive quantities, sane dates, totals adding up) are checked afterwards in code,
 * where they become validation issues rather than rejected output.
 *
 * One document may hold several purchase orders, hence `orders: []`.
 */

const nullableString = z.string().nullable().optional();
const nullableNumber = z.number().nullable().optional();
const confidence = z.number().optional();

export const extractedLineSchema = z
  .object({
    lineNo: z.number().int().nullable().optional(),
    customerPartCode: nullableString.describe(
      "The buyer's item/part/product code exactly as printed, or null",
    ),
    description: nullableString,
    quantity: z.number().positive().describe('Must be a positive number'),
    unit: nullableString.describe('Unit as written, e.g. "box", "case", "each", "pack of 100"'),
    unitPrice: nullableNumber.describe('Price per unit as printed, excluding currency symbols'),
    lineTotal: nullableNumber,
    confidence: z
      .object({
        customerPartCode: confidence,
        description: confidence,
        quantity: confidence,
        unitPrice: confidence,
      })
      .optional(),
  })
  .refine(
    (l) =>
      Boolean(
        (l.description && l.description.trim().length > 0) ||
          (l.customerPartCode && l.customerPartCode.trim().length > 0),
      ),
    {
      message: 'Line must have either a description or a customer part code',
      path: ['description'],
    },
  );

export type ExtractedLine = {
  lineNo: number;
  customerPartCode: string | null;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  lineTotal: number | null;
  confidence: {
    customerPartCode: number;
    description: number;
    quantity: number;
    unitPrice: number;
  };
};

export const extractedAddressSchema = z.object({
  line1: nullableString,
  line2: nullableString,
  city: nullableString,
  postcode: nullableString,
  country: nullableString,
});

export type ExtractedAddress = {
  line1: string | null;
  line2: string | null;
  city: string | null;
  postcode: string | null;
  country: string | null;
};

export const extractedOrderSchema = z.object({
  customer: z
    .object({
      name: nullableString.describe('The buying company (not the supplier the PO is addressed to)'),
      accountNumber: nullableString.describe('Their account number with the supplier, if printed'),
      email: nullableString,
    })
    .optional(),
  poNumber: nullableString,
  orderDate: nullableString.describe('YYYY-MM-DD'),
  requestedDeliveryDate: nullableString.describe('YYYY-MM-DD'),
  deliveryAddress: extractedAddressSchema.optional(),
  notes: nullableString.describe(
    'Delivery instructions or other free text that matters for fulfilment',
  ),
  currency: nullableString.describe('ISO code, e.g. GBP'),
  lines: z.array(extractedLineSchema).min(1, 'Order must contain at least one valid line'),
  documentTotals: z
    .object({
      subtotal: nullableNumber,
      tax: nullableNumber,
      total: nullableNumber,
    })
    .optional(),
  fieldConfidence: z
    .object({
      customer: confidence,
      poNumber: confidence,
      orderDate: confidence,
      deliveryAddress: confidence,
    })
    .optional(),
});

export type ExtractedOrder = {
  customer: {
    name: string | null;
    accountNumber: string | null;
    email: string | null;
  };
  poNumber: string | null;
  orderDate: string | null;
  requestedDeliveryDate: string | null;
  deliveryAddress: ExtractedAddress;
  notes: string | null;
  currency: string | null;
  lines: ExtractedLine[];
  documentTotals: {
    subtotal: number | null;
    tax: number | null;
    total: number | null;
  };
  fieldConfidence: {
    customer: number;
    poNumber: number;
    orderDate: number;
    deliveryAddress: number;
  };
};

export const extractionOutputSchema = z.object({
  orders: z
    .array(extractedOrderSchema)
    .optional()
    .describe('One entry per purchase order found; empty if the document holds no order'),
  documentNotes: nullableString.describe('Anything that made the document hard to read'),
});

export type ExtractionOutput = {
  orders: ExtractedOrder[];
  documentNotes: string | null;
};

type RawDict = Record<string, unknown>;

export function normalizeExtractedLine(raw: unknown, index: number): ExtractedLine {
  const r = (raw && typeof raw === 'object' ? (raw as RawDict) : {}) as RawDict;
  const conf = (r.confidence && typeof r.confidence === 'object' ? (r.confidence as RawDict) : {}) as RawDict;

  return {
    lineNo: typeof r.lineNo === 'number' ? r.lineNo : index + 1,
    customerPartCode: typeof r.customerPartCode === 'string' ? r.customerPartCode : null,
    description: typeof r.description === 'string' ? r.description : null,
    quantity: typeof r.quantity === 'number' ? r.quantity : (r.quantity as number | null),
    unit: typeof r.unit === 'string' ? r.unit : null,
    unitPrice: typeof r.unitPrice === 'number' ? r.unitPrice : null,
    lineTotal: typeof r.lineTotal === 'number' ? r.lineTotal : null,
    confidence: {
      customerPartCode:
        typeof conf.customerPartCode === 'number' ? conf.customerPartCode : 0.5,
      description:
        typeof conf.description === 'number' ? conf.description : 0.5,
      quantity:
        typeof conf.quantity === 'number' ? conf.quantity : 0.5,
      unitPrice:
        typeof conf.unitPrice === 'number' ? conf.unitPrice : 0.5,
    },
  };
}

export function normalizeExtractedOrder(raw: unknown): ExtractedOrder {
  const r = (raw && typeof raw === 'object' ? (raw as RawDict) : {}) as RawDict;
  const cust = (r.customer && typeof r.customer === 'object' ? (r.customer as RawDict) : {}) as RawDict;
  const addr = (r.deliveryAddress && typeof r.deliveryAddress === 'object' ? (r.deliveryAddress as RawDict) : {}) as RawDict;
  const totals = (r.documentTotals && typeof r.documentTotals === 'object' ? (r.documentTotals as RawDict) : {}) as RawDict;
  const conf = (r.fieldConfidence && typeof r.fieldConfidence === 'object' ? (r.fieldConfidence as RawDict) : {}) as RawDict;

  const rawLines = Array.isArray(r.lines)
    ? r.lines.map((l: unknown, i: number) => normalizeExtractedLine(l, i))
    : (r.lines as unknown as ExtractedLine[]);

  return {
    customer: {
      name: typeof cust.name === 'string' ? cust.name : null,
      accountNumber: typeof cust.accountNumber === 'string' ? cust.accountNumber : null,
      email: typeof cust.email === 'string' ? cust.email : null,
    },
    poNumber: typeof r.poNumber === 'string' ? r.poNumber : null,
    orderDate: typeof r.orderDate === 'string' ? r.orderDate : null,
    requestedDeliveryDate: typeof r.requestedDeliveryDate === 'string' ? r.requestedDeliveryDate : null,
    deliveryAddress: {
      line1: typeof addr.line1 === 'string' ? addr.line1 : null,
      line2: typeof addr.line2 === 'string' ? addr.line2 : null,
      city: typeof addr.city === 'string' ? addr.city : null,
      postcode: typeof addr.postcode === 'string' ? addr.postcode : null,
      country: typeof addr.country === 'string' ? addr.country : null,
    },
    notes: typeof r.notes === 'string' ? r.notes : null,
    currency: typeof r.currency === 'string' ? r.currency : null,
    lines: rawLines,
    documentTotals: {
      subtotal: typeof totals.subtotal === 'number' ? totals.subtotal : null,
      tax: typeof totals.tax === 'number' ? totals.tax : null,
      total: typeof totals.total === 'number' ? totals.total : null,
    },
    fieldConfidence: {
      customer: typeof conf.customer === 'number' ? conf.customer : 0.5,
      poNumber: typeof conf.poNumber === 'number' ? conf.poNumber : 0.5,
      orderDate: typeof conf.orderDate === 'number' ? conf.orderDate : 0.5,
      deliveryAddress: typeof conf.deliveryAddress === 'number' ? conf.deliveryAddress : 0.5,
    },
  };
}

export function normalizeExtractionOutput(raw: unknown): ExtractionOutput {
  const r = (raw && typeof raw === 'object' ? (raw as RawDict) : {}) as RawDict;
  const rawOrders = Array.isArray(r.orders)
    ? r.orders.map(normalizeExtractedOrder)
    : (r.orders as unknown as ExtractedOrder[]);
  return {
    orders: rawOrders,
    documentNotes: typeof r.documentNotes === 'string' ? r.documentNotes : null,
  };
}

export function salvageOrders(raw: unknown): { orders: ExtractedOrder[]; isPartial: boolean } {
  const r = (raw && typeof raw === 'object' ? (raw as RawDict) : {}) as RawDict;
  const rawOrders = Array.isArray(r.orders)
    ? r.orders
    : Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && ('lines' in r || 'customer' in r)
        ? [raw]
        : [];

  const salvagedOrders: ExtractedOrder[] = [];
  let isPartial = false;

  for (const rawOrder of rawOrders) {
    const ro = (rawOrder && typeof rawOrder === 'object' ? (rawOrder as RawDict) : {}) as RawDict;
    const rawLines = Array.isArray(ro.lines) ? ro.lines : [];
    const validLines: unknown[] = [];
    for (let i = 0; i < rawLines.length; i++) {
      const l = (rawLines[i] && typeof rawLines[i] === 'object' ? (rawLines[i] as RawDict) : {}) as RawDict;
      const hasQty = typeof l.quantity === 'number' && Number.isFinite(l.quantity) && l.quantity > 0;
      const hasDescOrCode =
        (typeof l.description === 'string' && l.description.trim().length > 0) ||
        (typeof l.customerPartCode === 'string' && l.customerPartCode.trim().length > 0);
      if (hasQty && hasDescOrCode) {
        validLines.push(rawLines[i]);
      } else {
        isPartial = true;
      }
    }

    if (validLines.length > 0) {
      const order = normalizeExtractedOrder({
        ...ro,
        lines: validLines,
      });
      salvagedOrders.push(order);
    }
  }

  return { orders: salvagedOrders, isPartial };
}

export type ExtractionIssue = {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  lineNo?: number;
};

export type ExtractedOrderDto = ExtractedOrder & { confidence: number; issues: ExtractionIssue[] };

export type ExtractionDto = {
  id: string;
  source: {
    kind: 'attachment' | 'body';
    label: string;
    attachmentId: string | null;
    mode: 'text' | 'pdf' | 'image' | 'table';
  };
  status: 'completed' | 'failed' | 'needs_llm';
  provider: string;
  model: string | null;
  promptVersion: string;
  orders: ExtractedOrderDto[];
  documentNotes: string | null;
  error: string | null;
  technicalError?: string | null;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  durationMs: number;
  attempts: number;
  createdAt: string;
};
