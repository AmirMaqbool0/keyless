import { z } from 'zod';

export type TenantOverviewDto = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  subscriptionStatus: string;
  createdAt: string;
  userCount: number;
  orderCountThisMonth: number;
  totalOrders: number;
  estimatedLlmCost: number;
  errorRatePct: number;
};

export type PlatformMetricsDto = {
  totalTenants: number;
  activeSubscriptions: number;
  totalOrdersProcessed: number;
  totalLlmCost: number;
  totalFailedJobs: number;
};

export type FailedJobDto = {
  id: string;
  type: string;
  orgId: string;
  attempts: number;
  maxAttempts: number;
  lastError: string;
  failedAt: string;
  createdAt: string;
};

export const deleteOrgSchema = z.object({
  confirmSlug: z.string().min(1),
});

export type DeleteOrgInput = z.infer<typeof deleteOrgSchema>;
