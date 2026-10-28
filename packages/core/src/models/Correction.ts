import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { tenantScoped } from '../db/tenant';

/**
 * Tracks every human edit/correction to an order line or header field.
 * Feeds the cross-reference learning loop and accuracy metrics (spec section 4 & 7).
 */
export interface ICorrection {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  orderId: Types.ObjectId;
  lineId?: Types.ObjectId;
  field: string;
  before: unknown;
  after: unknown;
  userId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const correctionSchema = new Schema<ICorrection>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    lineId: { type: Schema.Types.ObjectId },
    field: { type: String, required: true },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

correctionSchema.plugin(tenantScoped);
correctionSchema.index({ orgId: 1, orderId: 1, createdAt: -1 });
correctionSchema.index({ orgId: 1, createdAt: -1 });

export const Correction = model<ICorrection>('Correction', correctionSchema);
export type CorrectionDoc = HydratedDocument<ICorrection>;
