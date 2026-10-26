import { Schema, model, type Types } from 'mongoose';
import { tenantScoped } from '../db/tenant';

/** One-time email tokens (verification, password reset). Looked up by hash with skipTenant. */
export interface IAuthToken {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  userId: Types.ObjectId;
  type: 'verify_email' | 'reset_password';
  tokenHash: string;
  expiresAt: Date;
  usedAt?: Date;
}

const authTokenSchema = new Schema<IAuthToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['verify_email', 'reset_password'], required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
  },
  { timestamps: true },
);
authTokenSchema.plugin(tenantScoped);
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthToken = model<IAuthToken>('AuthToken', authTokenSchema);
