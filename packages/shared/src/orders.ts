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
  ready: ['ready'],
  on_hold: ['on_hold', 'duplicate'],
  pushed: ['approved', 'pushing', 'pushed'],
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
  method: 'sender' | 'domain' | 'account_number' | 'name' | 'forwarded_sender' | 'manual' | 'none';
  confidence: number;
  candidates: { customerId: string; name: string; accountCode: string; score: number }[];
};

export type OrderListItemDto = {
  id: string;
  status: OrderStatus;
  colour: RouteColour;
  confidence: number;
  poNumber: string | null;
  customer: { id: string | null; name: string | null; accountCode: string | null };
  lineCount: number;
  value: number | null;
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
  version: number;
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
