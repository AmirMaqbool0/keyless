import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { CONNECTOR_TYPES, type ConnectorType, type SyncResult } from '@keyless/shared';
import { tenantScoped } from '../db/tenant';

export interface IConnector {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  type: ConnectorType;
  name: string;
  status: 'connected' | 'error' | 'disconnected';
  isDefault: boolean;
  /** AES-256-GCM encrypted JSON (lib/crypto). Never returned by the API. */
  credentialsEnc?: string;
  settings: Record<string, unknown>;
  lastSyncAt?: Date;
  lastSyncResults: SyncResult[];
  lastError?: string;
  consecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
}

const connectorSchema = new Schema<IConnector>(
  {
    type: { type: String, enum: CONNECTOR_TYPES, required: true },
    name: { type: String, required: true },
    status: { type: String, enum: ['connected', 'error', 'disconnected'], default: 'connected' },
    isDefault: { type: Boolean, default: false },
    credentialsEnc: String,
    settings: { type: Schema.Types.Mixed, default: {} },
    lastSyncAt: Date,
    lastSyncResults: { type: Schema.Types.Mixed, default: [] },
    lastError: String,
    consecutiveFailures: { type: Number, default: 0 },
  },
  { timestamps: true, minimize: false },
);
connectorSchema.plugin(tenantScoped);

export const Connector = model<IConnector>('Connector', connectorSchema);
export type ConnectorDoc = HydratedDocument<IConnector>;
