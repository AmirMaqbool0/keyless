import { Schema, model, type Types } from 'mongoose';
import { tenantScoped } from '../db/tenant';

/** Sales orders "received" by the MockConnector's fake ERP (dev and demos). */
export interface IMockErpOrder {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  connectorId: Types.ObjectId;
  idempotencyKey: string;
  erpReference: string;
  customerRef: string;
  poNumber: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

const mockErpOrderSchema = new Schema<IMockErpOrder>(
  {
    connectorId: { type: Schema.Types.ObjectId, ref: 'Connector', required: true },
    idempotencyKey: { type: String, required: true },
    erpReference: { type: String, required: true },
    customerRef: { type: String, required: true },
    poNumber: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
mockErpOrderSchema.plugin(tenantScoped);
mockErpOrderSchema.index({ orgId: 1, connectorId: 1, idempotencyKey: 1 }, { unique: true });
mockErpOrderSchema.index({ orgId: 1, connectorId: 1, customerRef: 1, poNumber: 1 });

export const MockErpOrder = model<IMockErpOrder>('MockErpOrder', mockErpOrderSchema);
