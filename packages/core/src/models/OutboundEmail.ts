import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import {
  OUTBOUND_EMAIL_STATUSES,
  OUTBOUND_EMAIL_TYPES,
  type OutboundEmailStatus,
  type OutboundEmailType,
} from '@keyless/shared';
import { tenantScoped } from '../db/tenant';

export interface IOutboundEmail {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  orderId: Types.ObjectId;
  type: OutboundEmailType;
  to: string;
  subject: string;
  body: string;
  status: OutboundEmailStatus;
  sentAt?: Date;
  sentBy?: Types.ObjectId;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const outboundEmailSchema = new Schema<IOutboundEmail>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    type: { type: String, enum: OUTBOUND_EMAIL_TYPES, required: true },
    to: { type: String, required: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    status: {
      type: String,
      enum: OUTBOUND_EMAIL_STATUSES,
      default: 'draft',
    },
    sentAt: Date,
    sentBy: { type: Schema.Types.ObjectId, ref: 'User' },
    error: String,
  },
  { timestamps: true },
);

outboundEmailSchema.plugin(tenantScoped);
outboundEmailSchema.index({ orgId: 1, orderId: 1, createdAt: -1 });

export const OutboundEmail = model<IOutboundEmail>('OutboundEmail', outboundEmailSchema);
export type OutboundEmailDoc = HydratedDocument<IOutboundEmail>;
