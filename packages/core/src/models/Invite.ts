import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { ROLES, type Role } from '@keyless/shared';
import { tenantScoped } from '../db/tenant';

export interface IInvite {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  email: string;
  role: Role;
  tokenHash: string;
  invitedBy: Types.ObjectId;
  expiresAt: Date;
  acceptedAt?: Date;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const inviteSchema = new Schema<IInvite>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ROLES, required: true },
    tokenHash: { type: String, required: true, unique: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    acceptedAt: Date,
    revokedAt: Date,
  },
  { timestamps: true },
);
inviteSchema.plugin(tenantScoped);
inviteSchema.index({ orgId: 1, email: 1 });

export const Invite = model<IInvite>('Invite', inviteSchema);
export type InviteDoc = HydratedDocument<IInvite>;
