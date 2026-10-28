import { z } from 'zod';

export const ORDER_STATUSES = [
  'needs_review',
  'ready',
  'on_hold',
  'duplicate',
  'approved',
  'pushing',
  'pushed',
  'push_failed',
  'rejected',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type RouteColour = 'green' | 'amber' | 'red';

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  needs_review: 'Needs review',
  ready: 'Ready',
  on_hold: 'On hold',
  duplicate: 'Duplicate',
  approved: 'Approved',
  pushing: 'Sending',
  pushed: 'Sent',
  push_failed: 'Send failed',
  rejected: 'Rejected',
};

/** Queue tabs (spec 11.3). */
export const ORDER_VIEWS = {
  needs_review: ['needs_review'],
  ready: ['ready', 'approved', 'pushing'],
  on_hold: ['on_hold', 'duplicate'],
  pushed: ['pushed'],
  failed: ['push_failed'],
  all: [...ORDER_STATUSES],
} as const satisfies Record<string, readonly OrderStatus[]>;
export type OrderView = keyof typeof ORDER_VIEWS;

export type IssueSeverity = 'info' | 'warning' | 'error';

/** Spec section 8. `blocking` issues make an order red. */
export type OrderIssueDto = {
  id: string;
  code: string;
  severity: IssueSeverity;
  blocking: boolean;
  message: string;
  lineNo: number | null;
  resolved: boolean;
  dismissedBy?: string | null;
  dismissedAt?: string | null;
};

export type MatchMethod =
  'xref_code' | 'xref_description' | 'sku' | 'barcode' | 'fuzzy' | 'manual' | 'none';

export type MatchCandidateDto = {
  productId: string;
  sku: string;
  description: string;
  score: number;
};

export type OrderLineDto = {
  id: string;
  lineNo: number;
  customerPartCode: string | null;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  lineTotal: number | null;
  match: {
    productId: string | null;
    sku: string | null;
    description: string | null;
    method: MatchMethod;
    confidence: number;
    candidates: MatchCandidateDto[];
  };
  /** Quantity in our selling unit after unit-of-measure conversion. */
  convertedQuantity: number | null;
  uom: string | null;
  conversionFactor: number;
  expectedPrice: number | null;
  priceSource: 'contract' | 'price_list' | 'default' | null;
  stockQty: number | null;
  colour: RouteColour;
  extractionConfidence: number;
  edited: boolean;
};

export type CustomerMatchDto = {
  customerId: string | null;
  name: string | null;
  accountCode: string | null;
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
  candidates: { customerId: string; name: string; accountCode: string; score: number }[];
};

export type OrderListItemDto = {
  id: string;
  status: OrderStatus;
  colour: RouteColour;
  confidence: number;
  confidenceHint?: string | null;
  poNumber: string | null;
  customer: { id: string | null; name: string | null; accountCode: string | null };
  lineCount: number;
  value: number | null;
  valueEstimated?: boolean | null;
  expectedValue?: number | null;
  currency: string;
  receivedAt: string;
  emailId: string;
  issueCount: number;
  topIssue: string | null;
};

export type OrderDetailDto = OrderListItemDto & {
  orderDate: string | null;
  requestedDeliveryDate: string | null;
  deliveryAddress: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    postcode: string | null;
    country: string | null;
  };
  notes: string | null;
  customerMatch: CustomerMatchDto;
  documentTotals: { subtotal: number | null; tax: number | null; total: number | null };
  lines: OrderLineDto[];
  issues: OrderIssueDto[];
  source: {
    label: string;
    extractionId: string | null;
    attachmentId: string | null;
    attachmentUrl: string | null;
    mimeType: string | null;
  };
  email: { id: string; subject: string; from: string | null };
  relatedEmails: { emailId: string; kind: string; receivedAt: string; subject: string }[];
  timings: {
    receivedAt: string;
    extractedAt: string | null;
    routedAt: string | null;
    approvedAt: string | null;
    pushedAt: string | null;
  };
  approvedBy: { id: string; name: string } | null;
  rejectionReason: string | null;
  erpReference: string | null;
  lastPushError: string | null;
  autoApproved?: boolean | null;
  autoApprovedRuleName?: string | null;
  version: number;
};

export type CorrectionDto = {
  id: string;
  orderId: string;
  lineId: string | null;
  field: string;
  before: unknown;
  after: unknown;
  userId: string;
  userName?: string;
  createdAt: string;
};

export type OrderCounts = Record<OrderView, number> & { byColour: Record<RouteColour, number> };

export const orderListQuerySchema = z.object({
  view: z.enum(Object.keys(ORDER_VIEWS) as [OrderView, ...OrderView[]]).default('needs_review'),
  colour: z.enum(['green', 'amber', 'red']).optional(),
  customerId: z.string().optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const updateOrderLineSchema = z.object({
  id: z.string(),
  lineNo: z.number().int().optional(),
  customerPartCode: z.string().trim().max(100).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  quantity: z.number().positive().nullable().optional(),
  unit: z.string().trim().max(50).nullable().optional(),
  unitPrice: z.number().nonnegative().nullable().optional(),
  productId: z.string().nullable().optional(),
  sku: z.string().trim().max(100).nullable().optional(),
  conversionFactor: z.number().positive().optional(),
});

export const updateOrderSchema = z.object({
  poNumber: z.string().trim().max(100).nullable().optional(),
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  requestedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  deliveryAddress: z
    .object({
      line1: z.string().trim().max(200).nullable().optional(),
      line2: z.string().trim().max(200).nullable().optional(),
      city: z.string().trim().max(100).nullable().optional(),
      postcode: z.string().trim().max(20).nullable().optional(),
      country: z.string().trim().max(100).nullable().optional(),
    })
    .optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  currency: z.string().trim().length(3).optional(),
  customerId: z.string().nullable().optional(),
  rememberSender: z.boolean().optional(),
  lines: z.array(updateOrderLineSchema).optional(),
});
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;

export const rejectOrderSchema = z.object({
  reason: z.string().trim().min(2, 'A rejection reason is required').max(500),
});
export type RejectOrderInput = z.infer<typeof rejectOrderSchema>;

export interface LineForValueCalculation {
  quantity?: number | null;
  unitPrice?: number | null;
  lineTotal?: number | null;
  convertedQuantity?: number | null;
  expectedPrice?: number | null;
}

export interface CalculatedOrderValue {
  value: number | null;
  isEstimated: boolean;
  expectedValue: number | null;
}

/**
 * P1-1: Order value calculation used universally across queue, detail screen, analytics, and rules.
 * Order value = sum of PO line totals (or qty * PO unit price).
 * If any PO price is missing, uses our expected price for that line and marks the value as estimated.
 * Expected (our list/contract) value is also computed for comparison.
 */
export function computeOrderValue(lines: LineForValueCalculation[]): CalculatedOrderValue {
  if (!lines || lines.length === 0) {
    return { value: null, isEstimated: false, expectedValue: null };
  }

  let poSum: number | null = null;
  let expectedSum: number | null = null;
  let hasEstimatedLine = false;

  for (const line of lines) {
    // 1. PO price for this line: lineTotal or (quantity * unitPrice)
    const poLineValue =
      line.lineTotal != null && !isNaN(line.lineTotal)
        ? line.lineTotal
        : line.quantity != null && line.unitPrice != null
          ? line.quantity * line.unitPrice
          : null;

    // 2. Expected (our list/contract price) for this line:
    // convertedQuantity * expectedPrice (or quantity * expectedPrice)
    const expectedLineValue =
      line.expectedPrice != null && !isNaN(line.expectedPrice)
        ? (line.convertedQuantity ?? line.quantity ?? 1) * line.expectedPrice
        : null;

    if (expectedLineValue != null) {
      expectedSum = (expectedSum ?? 0) + expectedLineValue;
    }

    if (poLineValue != null) {
      poSum = (poSum ?? 0) + poLineValue;
    } else if (expectedLineValue != null) {
      // Missing PO price: fallback to expected price and mark as estimated
      poSum = (poSum ?? 0) + expectedLineValue;
      hasEstimatedLine = true;
    } else {
      // Completely unpriced line
      hasEstimatedLine = true;
    }
  }

  return {
    value: poSum != null ? Math.round(poSum * 100) / 100 : null,
    isEstimated: hasEstimatedLine,
    expectedValue: expectedSum != null ? Math.round(expectedSum * 100) / 100 : null,
  };
}
