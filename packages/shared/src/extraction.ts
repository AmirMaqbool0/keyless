import { z } from 'zod';

/*
 * What the LLM returns for one document (spec section 6). Deliberately loose: every value is
 * nullable so "not on the document" is representable and nothing has to be invented. Business
 * rules (positive quantities, sane dates, totals adding up) are checked afterwards in code,
 * where they become validation issues rather than rejected output.
 *
 * One document may hold several purchase orders, hence `orders: []`.
 */

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();
const confidence = z.number().describe('0 to 1: how sure you are this value is read correctly');

export const extractedLineSchema = z.object({
  lineNo: z.number().int().describe('1-based position on the document'),
  customerPartCode: nullableString.describe(
    "The buyer's item/part/product code exactly as printed, or null",
  ),
  description: nullableString,
  quantity: nullableNumber,
  unit: nullableString.describe('Unit as written, e.g. "box", "case", "each", "pack of 100"'),
  unitPrice: nullableNumber.describe('Price per unit as printed, excluding currency symbols'),
  lineTotal: nullableNumber,
  confidence: z.object({
    customerPartCode: confidence,
    description: confidence,
    quantity: confidence,
    unitPrice: confidence,
  }),
});
export type ExtractedLine = z.infer<typeof extractedLineSchema>;

export const extractedAddressSchema = z.object({
  line1: nullableString,
  line2: nullableString,
  city: nullableString,
  postcode: nullableString,
  country: nullableString,
});

export const extractedOrderSchema = z.object({
  customer: z.object({
    name: nullableString.describe('The buying company (not the supplier the PO is addressed to)'),
    accountNumber: nullableString.describe('Their account number with the supplier, if printed'),
    email: nullableString,
  }),
  poNumber: nullableString,
  orderDate: nullableString.describe('YYYY-MM-DD'),
  requestedDeliveryDate: nullableString.describe('YYYY-MM-DD'),
  deliveryAddress: extractedAddressSchema,
  notes: nullableString.describe(
    'Delivery instructions or other free text that matters for fulfilment',
  ),
  currency: nullableString.describe('ISO code, e.g. GBP'),
  lines: z.array(extractedLineSchema),
  documentTotals: z.object({
    subtotal: nullableNumber,
    tax: nullableNumber,
    total: nullableNumber,
  }),
  fieldConfidence: z.object({
    customer: confidence,
    poNumber: confidence,
    orderDate: confidence,
    deliveryAddress: confidence,
  }),
});
export type ExtractedOrder = z.infer<typeof extractedOrderSchema>;

export const extractionOutputSchema = z.object({
  orders: z
    .array(extractedOrderSchema)
    .describe('One entry per purchase order found; empty if the document holds no order'),
  documentNotes: nullableString.describe('Anything that made the document hard to read'),
});
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

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
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  durationMs: number;
  attempts: number;
  createdAt: string;
};
