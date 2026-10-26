import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import {
  IMPORT_TYPES,
  type ImportMapping,
  type ImportRowError,
  type ImportType,
} from '@keyless/shared';
import { tenantScoped } from '../db/tenant';

export interface IImportJob {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  type: ImportType;
  filename: string;
  storageKey: string;
  encoding: string;
  status: 'uploaded' | 'validated' | 'completed' | 'failed';
  columns: string[];
  sampleRows: Record<string, string>[];
  mapping: ImportMapping;
  totals: {
    rows: number;
    valid: number;
    created: number;
    updated: number;
    skipped: number;
    errors: number;
  };
  /** First errors only (capped); totals.errors has the full count. */
  rowErrors: ImportRowError[];
  failureMessage?: string;
  createdBy: Types.ObjectId;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const importJobSchema = new Schema<IImportJob>(
  {
    type: { type: String, enum: IMPORT_TYPES, required: true },
    filename: { type: String, required: true },
    storageKey: { type: String, required: true },
    encoding: { type: String, required: true },
    status: {
      type: String,
      enum: ['uploaded', 'validated', 'completed', 'failed'],
      default: 'uploaded',
    },
    columns: { type: [String], default: [] },
    sampleRows: { type: Schema.Types.Mixed, default: [] },
    mapping: { type: Schema.Types.Mixed, default: {} },
    totals: {
      rows: { type: Number, default: 0 },
      valid: { type: Number, default: 0 },
      created: { type: Number, default: 0 },
      updated: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      errors: { type: Number, default: 0 },
    },
    rowErrors: { type: Schema.Types.Mixed, default: [] },
    failureMessage: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    completedAt: Date,
  },
  { timestamps: true, minimize: false },
);
importJobSchema.plugin(tenantScoped);
importJobSchema.index({ orgId: 1, createdAt: -1 });

export const ImportJob = model<IImportJob>('ImportJob', importJobSchema);
export type ImportJobDoc = HydratedDocument<IImportJob>;
