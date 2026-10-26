import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import type { MailboxType } from '@keyless/shared';
import { tenantScoped } from '../db/tenant';

export interface IMailbox {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  type: MailboxType;
  name: string;
  /** The mailbox's own address (for forwarding: the Keyless inbound address). */
  address: string;
  /** Forwarding only: local part of the inbound address, unique across all orgs. */
  inboundAlias?: string;
  status: 'active' | 'error' | 'disconnected' | 'paused';
  /** Graph mail folder id (default "inbox") or Gmail label id (default "INBOX"). */
  folder?: string;
  /** AES-256-GCM encrypted JSON: { accessToken, refreshToken, expiresAt }. */
  tokensEnc?: string;
  /** Graph: the deltaLink URL. Gmail: the last historyId. */
  syncCursor?: string;
  lastSyncAt?: Date;
  lastError?: string;
  consecutiveFailures: number;
  connectedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const mailboxSchema = new Schema<IMailbox>(
  {
    type: { type: String, enum: ['forwarding', 'graph', 'gmail'], required: true },
    name: { type: String, required: true },
    address: { type: String, required: true, lowercase: true },
    inboundAlias: { type: String, lowercase: true },
    status: {
      type: String,
      enum: ['active', 'error', 'disconnected', 'paused'],
      default: 'active',
    },
    folder: String,
    tokensEnc: String,
    syncCursor: String,
    lastSyncAt: Date,
    lastError: String,
    consecutiveFailures: { type: Number, default: 0 },
    connectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
mailboxSchema.plugin(tenantScoped);
mailboxSchema.index(
  { inboundAlias: 1 },
  { unique: true, partialFilterExpression: { inboundAlias: { $type: 'string' } } },
);
mailboxSchema.index({ orgId: 1, type: 1, address: 1 }, { unique: true });
mailboxSchema.index({ type: 1, status: 1 });

export const Mailbox = model<IMailbox>('Mailbox', mailboxSchema);
export type MailboxDoc = HydratedDocument<IMailbox>;
