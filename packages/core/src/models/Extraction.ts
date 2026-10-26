import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import type { ExtractedOrderDto, ExtractionDto } from '@keyless/shared';
import { tenantScoped } from '../db/tenant';

/**
 * The structured result of reading one document (or the email body). Kept separate from Orders:
 * M5 turns these into orders with matched SKUs; this record keeps what the model actually said,
 * which model said it, with which prompt, at what cost.
 */
export interface IExtraction {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  emailId: Types.ObjectId;
  attachmentId?: Types.ObjectId;
  source: ExtractionDto['source'];
  status: ExtractionDto['status'];
  provider: string;
  model?: string;
  promptVersion: string;
  orders: ExtractedOrderDto[];
  documentNotes?: string;
  error?: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  pageCount: number;
  durationMs: number;
  attempts: number;
  createdAt: Date;
}

const extractionSchema = new Schema<IExtraction>(
  {
    emailId: { type: Schema.Types.ObjectId, ref: 'InboundEmail', required: true },
    attachmentId: { type: Schema.Types.ObjectId, ref: 'Attachment' },
    source: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: ['completed', 'failed', 'needs_llm'], required: true },
    provider: { type: String, required: true },
    model: String,
    promptVersion: { type: String, required: true },
    orders: { type: Schema.Types.Mixed, default: [] },
    documentNotes: String,
    error: String,
    usage: { inputTokens: Number, outputTokens: Number, costUsd: Number },
    pageCount: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);
extractionSchema.plugin(tenantScoped);
extractionSchema.index({ orgId: 1, emailId: 1 });

export const Extraction = model<IExtraction>('Extraction', extractionSchema);
export type ExtractionDoc = HydratedDocument<IExtraction>;
