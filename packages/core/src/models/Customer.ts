import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import type { Address } from '@keyless/shared';
import { tenantScoped } from '../db/tenant';
import { isPublicDomain } from '../matching/catalogue';

export interface ICustomer {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  accountCode: string;
  accountKey: string;
  name: string;
  erpCustomerId?: string;
  /** Lower-case domains whose senders belong to this customer (never public webmail). */
  emailDomains: string[];
  /** Exact sender addresses known to send orders for this customer. */
  senderAddresses: string[];
  deliveryAddresses: Address[];
  priceListCode?: string;
  creditHold: boolean;
  trustedForAutoApprove: boolean;
  /** Learned extraction hints, e.g. "codes are in column 2" (used from M4). */
  extractionHints: string[];
  source: 'import' | 'connector' | 'manual';
  searchText: string;
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const addressSchema = new Schema<Address>(
  {
    label: String,
    line1: { type: String, required: true },
    line2: String,
    city: String,
    postcode: String,
    country: String,
  },
  { _id: false },
);

const customerSchema = new Schema<ICustomer>(
  {
    accountCode: { type: String, required: true, trim: true },
    accountKey: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    erpCustomerId: String,
    emailDomains: {
      type: [String],
      default: [],
      validate: {
        validator: (domains: string[]) => !domains.some((d) => isPublicDomain(d)),
        message: 'Public webmail domains (e.g. gmail.com) cannot be added to customer emailDomains',
      },
    },
    senderAddresses: { type: [String], default: [] },
    deliveryAddresses: { type: [addressSchema], default: [] },
    priceListCode: String,
    creditHold: { type: Boolean, default: false },
    trustedForAutoApprove: { type: Boolean, default: false },
    extractionHints: { type: [String], default: [] },
    source: { type: String, enum: ['import', 'connector', 'manual'], required: true },
    searchText: { type: String, required: true },
    lastSyncedAt: Date,
  },
  { timestamps: true },
);

customerSchema.pre('save', function (next) {
  if (this.emailDomains) {
    this.emailDomains = this.emailDomains
      .map((d) => d.toLowerCase().trim().replace(/^@/, ''))
      .filter((d) => d.length > 0 && !isPublicDomain(d));
  }
  next();
});

customerSchema.plugin(tenantScoped);
customerSchema.index({ orgId: 1, accountKey: 1 }, { unique: true });
customerSchema.index({ orgId: 1, senderAddresses: 1 });
customerSchema.index({ orgId: 1, emailDomains: 1 });
customerSchema.index({ orgId: 1, name: 1 });
customerSchema.index({ orgId: 1, updatedAt: -1 });

export const Customer = model<ICustomer>('Customer', customerSchema);
export type CustomerDoc = HydratedDocument<ICustomer>;
