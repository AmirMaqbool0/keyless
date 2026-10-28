import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { tenantScoped } from '../db/tenant';

/** Records sales orders exported as CSV files for universal ERP import (spec section 10). */
export interface ICsvExportOrder {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  connectorId: Types.ObjectId;
  idempotencyKey: string;
  reference: string;
  customerRef: string;
  poNumber: string;
  storageKey: string;
  rowCount: number;
  totalValue?: number;
  createdAt: Date;
}

const csvExportOrderSchema = new Schema<ICsvExportOrder>(
  {
    connectorId: { type: Schema.Types.ObjectId, ref: 'Connector', required: true },
    idempotencyKey: { type: String, required: true },
    reference: { type: String, required: true },
    customerRef: { type: String, required: true },
    poNumber: { type: String, required: true },
    storageKey: { type: String, required: true },
    rowCount: { type: Number, required: true },
    totalValue: Number,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

csvExportOrderSchema.plugin(tenantScoped);
csvExportOrderSchema.index({ orgId: 1, connectorId: 1, idempotencyKey: 1 }, { unique: true });
csvExportOrderSchema.index({ orgId: 1, connectorId: 1, customerRef: 1, poNumber: 1 });
csvExportOrderSchema.index({ orgId: 1, createdAt: -1 });

export const CsvExportOrder = model<ICsvExportOrder>('CsvExportOrder', csvExportOrderSchema);
export type CsvExportOrderDoc = HydratedDocument<ICsvExportOrder>;
