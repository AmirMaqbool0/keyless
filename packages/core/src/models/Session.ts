import { Schema, model, type Types } from 'mongoose';
import { tenantScoped } from '../db/tenant';

/**
 * Refresh-token session. Tokens rotate on every refresh; all rotations of one login share a
 * `familyId`, so reuse of an old token revokes the whole family (stolen-token detection).
 */
export interface ISession {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  userId: Types.ObjectId;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt?: Date;
  /** Set when revoked because it was rotated (vs. logout / reuse). */
  rotatedAt?: Date;
  userAgent?: string;
  ip?: string;
}

const sessionSchema = new Schema<ISession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    familyId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    rotatedAt: Date,
    userAgent: String,
    ip: String,
  },
  { timestamps: true },
);
sessionSchema.plugin(tenantScoped);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = model<ISession>('Session', sessionSchema);
