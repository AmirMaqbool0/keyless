import { Schema, model, type Types } from 'mongoose';
import { tenantScoped } from '../db/tenant';

/**
 * A price for a SKU, scoped either to one customer (contract price) or to a price list code
 * that customers reference. Used by validation (M5) to flag price differences.
 */
export interface ICustomerPrice {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  customerId?: Types.ObjectId;
  priceListCode?: string;
  sku: string;
  skuKey: string;
  price: number;
  currency: string;
  minQty?: number;
  validFrom?: Date;
  validTo?: Date;
  /** Natural key for idempotent upserts: scope + sku + qty break + start date. */
  priceKey: string;
  source: 'import' | 'connector' | 'manual';
  createdAt: Date;
  updatedAt: Date;
}

const customerPriceSchema = new Schema<ICustomerPrice>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    priceListCode: String,
    sku: { type: String, required: true },
    skuKey: { type: String, required: true },
    price: { type: Number, required: true },
    currency: { type: String, required: true },
    minQty: Number,
    validFrom: Date,
    validTo: Date,
    priceKey: { type: String, required: true },
    source: { type: String, enum: ['import', 'connector', 'manual'], required: true },
  },
  { timestamps: true },
);
customerPriceSchema.plugin(tenantScoped);
customerPriceSchema.index({ orgId: 1, priceKey: 1 }, { unique: true });
customerPriceSchema.index({ orgId: 1, customerId: 1, skuKey: 1 });
customerPriceSchema.index({ orgId: 1, priceListCode: 1, skuKey: 1 });
customerPriceSchema.index({ orgId: 1, updatedAt: -1 });

export const CustomerPrice = model<ICustomerPrice>('CustomerPrice', customerPriceSchema);
