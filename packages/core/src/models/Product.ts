import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { tenantScoped } from '../db/tenant';

export interface IProduct {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  sku: string;
  /** Normalised SKU, unique per org. */
  skuKey: string;
  description: string;
  uom?: string;
  /** Units per pack, used for unit-of-measure conversion in matching. */
  packSize?: number;
  barcode?: string;
  defaultPrice?: number;
  stockQty?: number;
  active: boolean;
  source: 'import' | 'connector' | 'manual';
  externalId?: string;
  searchText: string;
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const productSchema = new Schema<IProduct>(
  {
    sku: { type: String, required: true, trim: true },
    skuKey: { type: String, required: true },
    description: { type: String, required: true, trim: true },
    uom: String,
    packSize: Number,
    barcode: String,
    defaultPrice: Number,
    stockQty: Number,
    active: { type: Boolean, default: true },
    source: { type: String, enum: ['import', 'connector', 'manual'], required: true },
    externalId: String,
    searchText: { type: String, required: true },
    lastSyncedAt: Date,
  },
  { timestamps: true },
);
productSchema.plugin(tenantScoped);
productSchema.index({ orgId: 1, skuKey: 1 }, { unique: true });
productSchema.index({ orgId: 1, barcode: 1 }, { sparse: true });
productSchema.index({ orgId: 1, active: 1, skuKey: 1 });
// Word search over descriptions; substring search uses searchText. M5 adds fuzzy matching.
productSchema.index({ description: 'text', sku: 'text' }, { weights: { sku: 5, description: 1 } });

export const Product = model<IProduct>('Product', productSchema);
export type ProductDoc = HydratedDocument<IProduct>;
