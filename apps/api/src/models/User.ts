import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { ROLES, type Role } from '@keyless/shared';
import { tenantScoped } from '../db/tenant';

export interface IUser {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  /** False once removed from the org. Removed users keep their record for audit history. */
  active: boolean;
  emailVerifiedAt?: Date;
  isSuperAdmin: boolean;
  /** Bumped on password change / removal to invalidate outstanding access tokens. */
  tokenVersion: number;
  twoFactor: {
    enabled: boolean;
    secretEnc?: string;
    pendingSecretEnc?: string;
    recoveryCodeHashes: string[];
  };
  notificationPrefs: {
    reviewQueue: boolean;
    pushFailures: boolean;
    dailyDigest: boolean;
    weeklyReport: boolean;
  };
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    active: { type: Boolean, default: true },
    emailVerifiedAt: Date,
    isSuperAdmin: { type: Boolean, default: false },
    tokenVersion: { type: Number, default: 0 },
    twoFactor: {
      enabled: { type: Boolean, default: false },
      secretEnc: String,
      pendingSecretEnc: String,
      recoveryCodeHashes: { type: [String], default: [] },
    },
    notificationPrefs: {
      reviewQueue: { type: Boolean, default: true },
      pushFailures: { type: Boolean, default: true },
      dailyDigest: { type: Boolean, default: false },
      weeklyReport: { type: Boolean, default: false },
    },
    lastLoginAt: Date,
  },
  { timestamps: true },
);
userSchema.plugin(tenantScoped);
// MVP: one user belongs to exactly one org, so an active email is unique platform-wide.
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { active: true } });

export const User = model<IUser>('User', userSchema);
export type UserDoc = HydratedDocument<IUser>;
