import { z } from 'zod';

export const RULE_TYPES = ['auto_approve', 'require_review', 'block'] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const RULE_ACTIONS = ['auto_approve', 'require_review', 'block'] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export type RuleConditions = {
  customerId?: string | null;
  customerName?: string | null;
  maxOrderValue?: number | null;
  minConfidence?: number | null;
  requireTrustedCustomer?: boolean;
  requireAllLinesLearned?: boolean;
  requireNoIssues?: boolean;
};

export type RuleActions = {
  action: RuleAction;
  reason?: string | null;
};

export type RuleDto = {
  id: string;
  name: string;
  type: RuleType;
  priority: number;
  active: boolean;
  conditions: RuleConditions;
  actions: RuleActions;
  createdAt: string;
  updatedAt: string;
};

export const createRuleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(RULE_TYPES).default('auto_approve'),
  priority: z.number().int().min(0).max(1000).default(10),
  active: z.boolean().default(true),
  conditions: z
    .object({
      customerId: z.string().nullish(),
      maxOrderValue: z.number().min(0).nullish(),
      minConfidence: z.number().min(0).max(1).nullish(),
      requireTrustedCustomer: z.boolean().optional(),
      requireAllLinesLearned: z.boolean().optional(),
      requireNoIssues: z.boolean().optional(),
    })
    .default({}),
  actions: z
    .object({
      action: z.enum(RULE_ACTIONS).default('auto_approve'),
      reason: z.string().trim().max(250).nullish(),
    })
    .default({ action: 'auto_approve' }),
});

export type CreateRuleInput = z.infer<typeof createRuleSchema>;

export const updateRuleSchema = createRuleSchema.partial();
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;
