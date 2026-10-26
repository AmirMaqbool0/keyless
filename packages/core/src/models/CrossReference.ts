import { Schema, model, type Types } from 'mongoose';
import { tenantScoped } from '../db/tenant';

/**
 * Customer's way of naming an item -> our SKU. The core learning asset: imported up front,
 * then grown from every reviewer correction (M6).
 */
export interface ICrossReference {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  customerId: Types.ObjectId;
  customerPartCode?: string;
  partCodeKey?: string;
  customerDescription?: string;
  descriptionKey?: string;
  /** "code:<partCodeKey>" or "desc:<descriptionKey>"; unique per customer. */
  matchKey: string;
  productId?: Types.ObjectId;
  sku: string;
  skuKey: string;
  customerUom?: string;
  /** Our units per one customer unit (customer orders 1 box, we ship 100 each -> 100). */
  uomFactor: number;
  source: 'import' | 'learned' | 'manual';
  confidence: number;
  timesUsed: number;
  lastUsedAt?: Date;
  searchText: string;
  createdAt: Date;
  updatedAt: Date;
}

const crossReferenceSchema = new Schema<ICrossReference>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerPartCode: String,
    partCodeKey: String,
    customerDescription: String,
    descriptionKey: String,
    matchKey: { type: String, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },
    sku: { type: String, required: true },
    skuKey: { type: String, required: true },
    customerUom: String,
    uomFactor: { type: Number, default: 1 },
    source: { type: String, enum: ['import', 'learned', 'manual'], required: true },
    confidence: { type: Number, default: 1 },
    timesUsed: { type: Number, default: 0 },
    lastUsedAt: Date,
    searchText: { type: String, required: true },
  },
  { timestamps: true },
);
crossReferenceSchema.plugin(tenantScoped);
crossReferenceSchema.index({ orgId: 1, customerId: 1, matchKey: 1 }, { unique: true });
crossReferenceSchema.index({ orgId: 1, skuKey: 1 });
crossReferenceSchema.index({ orgId: 1, updatedAt: -1 });

export const CrossReference = model<ICrossReference>('CrossReference', crossReferenceSchema);
