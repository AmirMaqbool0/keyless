import { Schema, model, type Types } from 'mongoose';
import { tenantScoped } from '../db/tenant';

export interface IAuditLog {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  actor: { userId?: Types.ObjectId; email?: string; type: 'user' | 'system' | 'superadmin' };
  action: string;
  entity: { type: string; id?: string };
  summary?: Record<string, unknown>;
  ip?: string;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    actor: {
      userId: { type: Schema.Types.ObjectId, ref: 'User' },
      email: String,
      type: { type: String, enum: ['user', 'system', 'superadmin'], required: true },
    },
    action: { type: String, required: true },
    entity: { type: { type: String, required: true }, id: String },
    summary: Schema.Types.Mixed,
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditLogSchema.plugin(tenantScoped);
auditLogSchema.index({ orgId: 1, createdAt: -1 });

// Append-only. Full org deletion (M10) will bypass this deliberately with { allowAuditDelete: true }.
declare module 'mongoose' {
  interface MongooseQueryOptions {
    allowAuditDelete?: boolean;
  }
}
auditLogSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'],
  function () {
    throw new Error('AuditLog is append-only');
  },
);
auditLogSchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], function () {
  if (!this.getOptions().allowAuditDelete) throw new Error('AuditLog is append-only');
});

export const AuditLog = model<IAuditLog>('AuditLog', auditLogSchema);
