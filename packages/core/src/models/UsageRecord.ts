import { Schema, model, type Types } from 'mongoose';
import { tenantScoped } from '../db/tenant';

/** Monthly usage per org: what LLM work cost (now) and what billing counts (orders, from M7). */
export interface IUsageRecord {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  /** "YYYY-MM" in UTC. */
  period: string;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  documentsExtracted: number;
  pagesProcessed: number;
  ordersExtracted: number;
  ordersProcessed: number;
}

const usageRecordSchema = new Schema<IUsageRecord>(
  {
    period: { type: String, required: true },
    llmCalls: { type: Number, default: 0 },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    documentsExtracted: { type: Number, default: 0 },
    pagesProcessed: { type: Number, default: 0 },
    ordersExtracted: { type: Number, default: 0 },
    ordersProcessed: { type: Number, default: 0 },
  },
  { timestamps: true },
);
usageRecordSchema.plugin(tenantScoped);
usageRecordSchema.index({ orgId: 1, period: 1 }, { unique: true });

export const UsageRecord = model<IUsageRecord>('UsageRecord', usageRecordSchema);

type UsageDelta = Partial<Omit<IUsageRecord, '_id' | 'orgId' | 'period'>>;

export async function recordUsage(
  orgId: Types.ObjectId,
  delta: UsageDelta,
  at = new Date(),
): Promise<void> {
  const period = at.toISOString().slice(0, 7);
  await UsageRecord.updateOne({ orgId, period }, { $inc: delta }, { upsert: true });
}
