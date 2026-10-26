import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import {
  EMAIL_CLASSIFICATIONS,
  type EmailClassification,
  type EmailSource,
  type EmailStatus,
} from '@keyless/shared';
import { tenantScoped } from '../db/tenant';

export type Classification = {
  label: EmailClassification;
  confidence: number;
  method: 'heuristic' | 'llm' | 'manual';
  reasons: string[];
  model?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  classifiedAt: Date;
  classifiedBy?: Types.ObjectId;
};

export type ExtractionSummary = {
  status: 'running' | 'completed' | 'partial' | 'failed' | 'needs_llm';
  orderCount: number;
  lineCount: number;
  issueCount: number;
  costUsd: number;
  completedAt?: Date;
};

export interface IInboundEmail {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  mailboxId?: Types.ObjectId;
  source: EmailSource;
  /** Dedupe key, unique per org: provider id, else Message-ID header, else hash of the raw bytes. */
  providerMessageId: string;
  messageId?: string;
  from?: { name?: string; address?: string };
  to: string[];
  cc: string[];
  subject: string;
  /** Plain-text body (capped). */
  text: string;
  /** HTML body as received (capped). Only ever rendered in a sandboxed iframe. */
  html?: string;
  headers: Record<string, string>;
  receivedAt: Date;
  rawStorageKey: string;
  rawSize: number;
  status: EmailStatus;
  classification?: Classification;
  /** Every classification change, newest last (manual overrides included). */
  classificationHistory: Classification[];
  attachmentIds: Types.ObjectId[];
  /** Filled from M5 when orders are created from this email. */
  orderIds: Types.ObjectId[];
  /** Existing orders this email amends or cancels. */
  relatedOrderIds: Types.ObjectId[];
  /** Roll-up of the latest extraction run (details live in Extraction records). */
  extraction?: ExtractionSummary;
  uploadedBy?: Types.ObjectId;
  error?: string;
  parsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const classificationSchema = new Schema<Classification>(
  {
    label: { type: String, enum: EMAIL_CLASSIFICATIONS, required: true },
    confidence: { type: Number, required: true },
    method: { type: String, enum: ['heuristic', 'llm', 'manual'], required: true },
    reasons: { type: [String], default: [] },
    model: String,
    usage: { inputTokens: Number, outputTokens: Number, costUsd: Number },
    classifiedAt: { type: Date, required: true },
    classifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false },
);

const inboundEmailSchema = new Schema<IInboundEmail>(
  {
    mailboxId: { type: Schema.Types.ObjectId, ref: 'Mailbox' },
    source: { type: String, enum: ['forwarding', 'upload', 'graph', 'gmail'], required: true },
    providerMessageId: { type: String, required: true },
    messageId: String,
    from: { name: String, address: { type: String, lowercase: true } },
    to: { type: [String], default: [] },
    cc: { type: [String], default: [] },
    subject: { type: String, default: '' },
    text: { type: String, default: '' },
    html: String,
    headers: { type: Schema.Types.Mixed, default: {} },
    receivedAt: { type: Date, required: true },
    rawStorageKey: { type: String, required: true },
    rawSize: { type: Number, required: true },
    status: {
      type: String,
      enum: ['received', 'parsed', 'classified', 'failed'],
      default: 'received',
    },
    classification: classificationSchema,
    classificationHistory: { type: [classificationSchema], default: [] },
    attachmentIds: { type: [Schema.Types.ObjectId], ref: 'Attachment', default: [] },
    orderIds: { type: [Schema.Types.ObjectId], default: [] },
    relatedOrderIds: { type: [Schema.Types.ObjectId], default: [] },
    extraction: {
      type: new Schema<ExtractionSummary>(
        {
          status: {
            type: String,
            enum: ['running', 'completed', 'partial', 'failed', 'needs_llm'],
            required: true,
          },
          orderCount: { type: Number, default: 0 },
          lineCount: { type: Number, default: 0 },
          issueCount: { type: Number, default: 0 },
          costUsd: { type: Number, default: 0 },
          completedAt: Date,
        },
        { _id: false },
      ),
      default: undefined,
    },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    error: String,
    parsedAt: Date,
  },
  { timestamps: true, minimize: false },
);
inboundEmailSchema.plugin(tenantScoped);
inboundEmailSchema.index({ orgId: 1, providerMessageId: 1 }, { unique: true });
inboundEmailSchema.index({ orgId: 1, receivedAt: -1 });
inboundEmailSchema.index({ orgId: 1, 'classification.label': 1, receivedAt: -1 });
inboundEmailSchema.index({ orgId: 1, status: 1 });

export const InboundEmail = model<IInboundEmail>('InboundEmail', inboundEmailSchema);
export type InboundEmailDoc = HydratedDocument<IInboundEmail>;
