import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

/** The tenant itself. Not tenant-scoped (it *is* the tenant). */
export interface IOrganization {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  country: string;
  timezone: string;
  currency: string;
  plan: 'trial' | 'starter' | 'growth' | 'pro';
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  settings: {
    autoApproveEnabled: boolean;
    greenConfidenceThreshold: number;
    amberConfidenceThreshold: number;
    priceTolerancePct: number;
    highValueThreshold: number | null;
    retentionDays: number;
    defaultConnector: string | null;
  };
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const organizationSchema = new Schema<IOrganization>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true },
    country: { type: String, default: 'GB' },
    timezone: { type: String, default: 'Europe/London' },
    currency: { type: String, default: 'GBP' },
    plan: { type: String, enum: ['trial', 'starter', 'growth', 'pro'], default: 'trial' },
    stripeCustomerId: String,
    stripeSubscriptionId: String,
    settings: {
      autoApproveEnabled: { type: Boolean, default: false },
      greenConfidenceThreshold: { type: Number, default: 0.9 },
      amberConfidenceThreshold: { type: Number, default: 0.6 },
      priceTolerancePct: { type: Number, default: 2 },
      highValueThreshold: { type: Number, default: null },
      retentionDays: { type: Number, default: 90 },
      defaultConnector: { type: String, default: null },
    },
    deletedAt: Date,
  },
  { timestamps: true },
);

export const Organization = model<IOrganization>('Organization', organizationSchema);
export type OrganizationDoc = HydratedDocument<IOrganization>;
