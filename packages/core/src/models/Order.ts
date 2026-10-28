import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import {
  ORDER_STATUSES,
  type CustomerMatchDto,
  type IssueSeverity,
  type MatchMethod,
  type OrderStatus,
  type RouteColour,
} from '@keyless/shared';
import { tenantScoped } from '../db/tenant';

/*
 * A sales order built from one extracted purchase order. Lines and validation issues are
 * embedded: they are always read and written with their order, and an order has at most a few
 * hundred lines. Each line and issue has its own _id so corrections (M6) can point at it.
 */

export type OrderIssue = {
  _id: Types.ObjectId;
  code: string;
  severity: IssueSeverity;
  /** Blocking issues make the order red (on hold / duplicate). */
  blocking: boolean;
  message: string;
  lineNo?: number;
  resolved: boolean;
  dismissedBy?: Types.ObjectId;
  dismissedAt?: Date;
};

export type MatchCandidate = {
  productId: Types.ObjectId;
  sku: string;
  description: string;
  score: number;
};

export type OrderLine = {
  _id: Types.ObjectId;
  lineNo: number;
  customerPartCode?: string;
  description?: string;
  quantity?: number;
  unit?: string;
  unitPrice?: number;
  lineTotal?: number;
  productId?: Types.ObjectId;
  sku?: string;
  productDescription?: string;
  matchMethod: MatchMethod;
  matchConfidence: number;
  candidates: MatchCandidate[];
  convertedQuantity?: number;
  uom?: string;
  conversionFactor: number;
  expectedPrice?: number;
  priceSource?: 'contract' | 'price_list' | 'default';
  stockQty?: number;
  colour: RouteColour;
  extractionConfidence: number;
  edited: boolean;
};

export interface IOrder {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  emailId: Types.ObjectId;
  extractionId?: Types.ObjectId;
  attachmentId?: Types.ObjectId;
  sourceLabel: string;
  /** Position of this order within its extraction (one document can hold several POs). */
  sourceIndex: number;
  customerId?: Types.ObjectId;
  customerMatch: Omit<CustomerMatchDto, 'customerId' | 'candidates'> & {
    customerId?: Types.ObjectId;
    candidates: { customerId: Types.ObjectId; name: string; accountCode: string; score: number }[];
  };
  poNumber?: string;
  poKey?: string;
  orderDate?: string;
  requestedDeliveryDate?: string;
  deliveryAddress: {
    line1?: string;
    line2?: string;
    city?: string;
    postcode?: string;
    country?: string;
  };
  notes?: string;
  currency: string;
  documentTotals: { subtotal?: number; tax?: number; total?: number };
  /** Order value = sum of PO line totals (or qty * PO unit price), fallback to expected price (estimated). */
  value?: number;
  valueEstimated?: boolean;
  expectedValue?: number;
  status: OrderStatus;
  colour: RouteColour;
  confidence: number;
  confidenceHint?: string;
  /** The extractor's own confidence for this order, kept for re-routing. */
  extractionConfidence: number;
  lines: OrderLine[];
  issues: OrderIssue[];
  /** Amendments/cancellations that arrived after the order (spec section 5). */
  relatedEmails: {
    emailId: Types.ObjectId;
    kind: 'amendment' | 'cancellation';
    receivedAt: Date;
  }[];
  receivedAt: Date;
  extractedAt?: Date;
  routedAt?: Date;
  approvedAt?: Date;
  approvedBy?: Types.ObjectId;
  pushedAt?: Date;
  erpReference?: string;
  rejectionReason?: string;
  lastPushError?: string;
  autoApproved?: boolean;
  autoApprovedRuleId?: Types.ObjectId;
  autoApprovedRuleName?: string;
  /** orgId + customerId + poNumber + version (spec section 10). */
  idempotencyKey?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const issueSchema = new Schema<OrderIssue>({
  code: { type: String, required: true },
  severity: { type: String, enum: ['info', 'warning', 'error'], required: true },
  blocking: { type: Boolean, default: false },
  message: { type: String, required: true },
  lineNo: Number,
  resolved: { type: Boolean, default: false },
  dismissedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  dismissedAt: Date,
});

const lineSchema = new Schema<OrderLine>({
  lineNo: { type: Number, required: true },
  customerPartCode: String,
  description: String,
  quantity: Number,
  unit: String,
  unitPrice: Number,
  lineTotal: Number,
  productId: { type: Schema.Types.ObjectId, ref: 'Product' },
  sku: String,
  productDescription: String,
  matchMethod: {
    type: String,
    enum: ['xref_code', 'xref_description', 'sku', 'barcode', 'fuzzy', 'manual', 'none'],
    default: 'none',
  },
  matchConfidence: { type: Number, default: 0 },
  candidates: {
    type: [
      {
        productId: Schema.Types.ObjectId,
        sku: String,
        description: String,
        score: Number,
        _id: false,
      },
    ],
    default: [],
  },
  convertedQuantity: Number,
  uom: String,
  conversionFactor: { type: Number, default: 1 },
  expectedPrice: Number,
  priceSource: { type: String, enum: ['contract', 'price_list', 'default'] },
  stockQty: Number,
  colour: { type: String, enum: ['green', 'amber', 'red'], default: 'amber' },
  extractionConfidence: { type: Number, default: 0 },
  edited: { type: Boolean, default: false },
});

const orderSchema = new Schema<IOrder>(
  {
    emailId: { type: Schema.Types.ObjectId, ref: 'InboundEmail', required: true },
    extractionId: { type: Schema.Types.ObjectId, ref: 'Extraction' },
    attachmentId: { type: Schema.Types.ObjectId, ref: 'Attachment' },
    sourceLabel: { type: String, required: true },
    sourceIndex: { type: Number, default: 0 },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    customerMatch: {
      customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
      name: String,
      accountCode: String,
      method: {
        type: String,
        enum: [
          'sender',
          'domain',
          'account_number',
          'name',
          'delivery_address',
          'forwarded_sender',
          'manual',
          'none',
        ],
        default: 'none',
      },
      confidence: { type: Number, default: 0 },
      candidates: {
        type: [
          {
            customerId: Schema.Types.ObjectId,
            name: String,
            accountCode: String,
            score: Number,
            _id: false,
          },
        ],
        default: [],
      },
    },
    poNumber: String,
    poKey: String,
    orderDate: String,
    requestedDeliveryDate: String,
    deliveryAddress: {
      line1: String,
      line2: String,
      city: String,
      postcode: String,
      country: String,
    },
    notes: String,
    currency: { type: String, default: 'GBP' },
    documentTotals: { subtotal: Number, tax: Number, total: Number },
    value: Number,
    valueEstimated: { type: Boolean, default: false },
    expectedValue: Number,
    status: { type: String, enum: ORDER_STATUSES, required: true },
    colour: { type: String, enum: ['green', 'amber', 'red'], required: true },
    confidence: { type: Number, default: 0 },
    confidenceHint: String,
    extractionConfidence: { type: Number, default: 0 },
    lines: { type: [lineSchema], default: [] },
    issues: { type: [issueSchema], default: [] },
    relatedEmails: {
      type: [{ emailId: Schema.Types.ObjectId, kind: String, receivedAt: Date, _id: false }],
      default: [],
    },
    receivedAt: { type: Date, required: true },
    extractedAt: Date,
    routedAt: Date,
    approvedAt: Date,
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    pushedAt: Date,
    erpReference: String,
    rejectionReason: String,
    lastPushError: String,
    autoApproved: { type: Boolean, default: false },
    autoApprovedRuleId: { type: Schema.Types.ObjectId, ref: 'Rule' },
    autoApprovedRuleName: String,
    idempotencyKey: String,
    version: { type: Number, default: 1 },
  },
  { timestamps: true },
);
orderSchema.plugin(tenantScoped);
orderSchema.index({ orgId: 1, status: 1, receivedAt: -1 });
orderSchema.index({ orgId: 1, emailId: 1 });
// Duplicate detection: same customer + PO number.
orderSchema.index({ orgId: 1, customerId: 1, poKey: 1 });
orderSchema.index({ orgId: 1, poKey: 1 });

export const Order = model<IOrder>('Order', orderSchema);
export type OrderDoc = HydratedDocument<IOrder>;
