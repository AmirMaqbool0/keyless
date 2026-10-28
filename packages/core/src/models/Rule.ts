import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import {
  RULE_ACTIONS,
  RULE_TYPES,
  type RuleAction,
  type RuleType,
} from '@keyless/shared';
import { tenantScoped } from '../db/tenant';

export interface IRule {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  name: string;
  type: RuleType;
  priority: number;
  active: boolean;
  conditions: {
    customerId?: Types.ObjectId;
    maxOrderValue?: number;
    minConfidence?: number;
    requireTrustedCustomer?: boolean;
    requireAllLinesLearned?: boolean;
    requireNoIssues?: boolean;
  };
  actions: {
    action: RuleAction;
    reason?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const ruleSchema = new Schema<IRule>(
  {
    name: { type: String, required: true },
    type: { type: String, enum: RULE_TYPES, default: 'auto_approve' },
    priority: { type: Number, default: 10 },
    active: { type: Boolean, default: true },
    conditions: {
      customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
      maxOrderValue: Number,
      minConfidence: Number,
      requireTrustedCustomer: { type: Boolean, default: false },
      requireAllLinesLearned: { type: Boolean, default: false },
      requireNoIssues: { type: Boolean, default: false },
    },
    actions: {
      action: { type: String, enum: RULE_ACTIONS, default: 'auto_approve' },
      reason: String,
    },
  },
  { timestamps: true },
);

ruleSchema.plugin(tenantScoped);
ruleSchema.index({ orgId: 1, active: 1, priority: -1 });

export const Rule = model<IRule>('Rule', ruleSchema);
export type RuleDoc = HydratedDocument<IRule>;
