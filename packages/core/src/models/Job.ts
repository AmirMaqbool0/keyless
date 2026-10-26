import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

/**
 * A background job for the MongoDB queue driver (used when Redis/BullMQ is not configured).
 *
 * Deliberately NOT tenant-scoped: workers claim jobs across all orgs. Payloads carry their own
 * orgId and every handler re-scopes its queries with it.
 */
export interface IJob {
  _id: Types.ObjectId;
  name: string;
  data: Record<string, unknown>;
  orgId?: Types.ObjectId;
  status: 'waiting' | 'active' | 'completed' | 'failed';
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  lockedUntil?: Date;
  workerId?: string;
  /** Deduplication key: one job per key (e.g. "process-email:<id>"). */
  uniqueKey?: string;
  lastError?: string;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const jobSchema = new Schema<IJob>(
  {
    name: { type: String, required: true },
    data: { type: Schema.Types.Mixed, required: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization' },
    status: {
      type: String,
      enum: ['waiting', 'active', 'completed', 'failed'],
      default: 'waiting',
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    runAt: { type: Date, default: () => new Date() },
    lockedUntil: Date,
    workerId: String,
    uniqueKey: String,
    lastError: String,
    finishedAt: Date,
  },
  { timestamps: true, minimize: false },
);
jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index(
  { uniqueKey: 1 },
  { unique: true, partialFilterExpression: { uniqueKey: { $type: 'string' } } },
);
jobSchema.index({ orgId: 1, status: 1, updatedAt: -1 });
// Completed jobs are kept a week for debugging, then removed.
jobSchema.index(
  { finishedAt: 1 },
  { expireAfterSeconds: 7 * 24 * 3600, partialFilterExpression: { status: 'completed' } },
);

export const Job = model<IJob>('Job', jobSchema);
export type JobDoc = HydratedDocument<IJob>;
