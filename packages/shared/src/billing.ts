import { z } from 'zod';

export type PlanId = 'trial' | 'starter' | 'growth' | 'pro';

export type PlanDefinition = {
  id: PlanId;
  name: string;
  priceMonthly: number;
  currency: string;
  orderLimit: number;
  description: string;
  features: string[];
};

export const PLANS: Record<PlanId, PlanDefinition> = {
  trial: {
    id: 'trial',
    name: 'Free Trial',
    priceMonthly: 0,
    currency: 'GBP',
    orderLimit: 100,
    description: '14-day free trial to test automated sales order processing.',
    features: [
      'Up to 100 orders included',
      'Forwarding email & upload',
      'All 5 ERP connectors',
      'Standard email support',
    ],
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 295,
    currency: 'GBP',
    orderLimit: 600,
    description: 'Perfect for small distributors processing up to 600 orders per month.',
    features: [
      'Up to 600 orders / month',
      'Unlimited mailboxes (Gmail, M365, Forwarding)',
      'Automated line matching & learning',
      'CSV, Unleashed, Cin7 & QuickBooks Online',
      'Priority email support',
    ],
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    priceMonthly: 595,
    currency: 'GBP',
    orderLimit: 2000,
    description: 'Ideal for scaling distributors handling high order volume.',
    features: [
      'Up to 2,000 orders / month',
      'Full auto-approve rules engine',
      'Outbound confirmation & clarification emails',
      'Advanced analytics & value reports',
      'Dedicated account manager',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 995,
    currency: 'GBP',
    orderLimit: 5000,
    description: 'For busy wholesale operations demanding enterprise throughput and custom rules.',
    features: [
      'Up to 5,000 orders / month',
      'Instant auto-approval & real-time ERP push',
      'Custom ERP connectors & export formats',
      'Audit logs & multi-team management',
      '1-hour SLA phone & Slack support',
    ],
  },
};

export type SubscriptionDto = {
  plan: PlanId;
  planName: string;
  priceMonthly: number;
  currency: string;
  status: 'active' | 'past_due' | 'canceled' | 'trialing' | 'incomplete';
  ordersUsed: number;
  ordersLimit: number;
  usagePct: number;
  approachingLimit: boolean;
  exceededLimit: boolean;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  hasPaymentMethod: boolean;
};

export const createCheckoutSessionSchema = z.object({
  plan: z.enum(['starter', 'growth', 'pro']),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

export type CreateCheckoutSessionInput = z.infer<typeof createCheckoutSessionSchema>;

export const createPortalSessionSchema = z.object({
  returnUrl: z.string().url().optional(),
});

export type CreatePortalSessionInput = z.infer<typeof createPortalSessionSchema>;
