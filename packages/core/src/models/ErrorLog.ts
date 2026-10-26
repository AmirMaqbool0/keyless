import { Schema, model, type Types } from 'mongoose';
import { tenantScoped } from '../db/tenant';

/**
 * A background job that failed for good (retries exhausted or a permanent error). Shown to admins
 * as "Processing errors" with a Retry button. Written by both queue drivers.
 */
export interface IErrorLog {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  jobName: string;
  data: Record<string, unknown>;
  /** What the job was about, for display (e.g. { type: 'email', id }). */
  entity?: { type: string; id: string };
  message: string;
  stack?: string;
  attempts: number;
  status: 'open' | 'retried' | 'dismissed';
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const errorLogSchema = new Schema<IErrorLog>(
  {
    jobName: { type: String, required: true },
    data: { type: Schema.Types.Mixed, required: true },
    entity: { type: { type: String }, id: String },
    message: { type: String, required: true },
    stack: String,
    attempts: { type: Number, default: 0 },
    status: { type: String, enum: ['open', 'retried', 'dismissed'], default: 'open' },
    resolvedAt: Date,
  },
  { timestamps: true, minimize: false },
);
errorLogSchema.plugin(tenantScoped);
errorLogSchema.index({ orgId: 1, status: 1, createdAt: -1 });

export const ErrorLog = model<IErrorLog>('ErrorLog', errorLogSchema);
