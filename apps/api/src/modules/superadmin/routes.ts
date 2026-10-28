import { Router } from 'express';
import { Types } from 'mongoose';
import type { FailedJobDto, PlatformMetricsDto, TenantOverviewDto } from '@keyless/shared';
import { audit } from '@keyless/core/lib/audit';
import { notFound } from '@keyless/core/lib/http';
import { Extraction } from '@keyless/core/models/Extraction';
import { Job } from '@keyless/core/models/Job';
import { Order } from '@keyless/core/models/Order';
import { Organization } from '@keyless/core/models/Organization';
import { User } from '@keyless/core/models/User';
import type { AppDeps } from '../../app';
import { authed, requireSuperAdmin } from '../../middleware/auth';
import { issueSession } from '../auth/tokens';
import { toOrgDto, toUserDto } from '../dto';

export function superAdminRouter(_deps?: Partial<AppDeps>): Router {
  const r = Router();

  // All routes require superadmin role
  r.use(requireSuperAdmin);

  /**
   * Platform-wide high-level metrics & KPIs
   */
  r.get('/metrics', async (_req, res) => {
    const totalTenants = await Organization.countDocuments({ deletedAt: null });
    const activeSubscriptions = await Organization.countDocuments({
      deletedAt: null,
      subscriptionStatus: 'active',
    });
    const totalOrdersProcessed = await Order.countDocuments().setOptions({ skipTenant: true });
    const totalFailedJobs = await Job.countDocuments({ status: 'failed' });

    const llmUsageAgg = await Extraction.aggregate([
      { $group: { _id: null, totalCost: { $sum: '$usage.costUsd' } } },
    ]).option({ skipTenant: true });

    const totalLlmCost = llmUsageAgg[0]?.totalCost ? Number(llmUsageAgg[0].totalCost.toFixed(4)) : 0;

    const metrics: PlatformMetricsDto = {
      totalTenants,
      activeSubscriptions,
      totalOrdersProcessed,
      totalLlmCost,
      totalFailedJobs,
    };

    res.json({ metrics });
  });

  /**
   * List all tenants with usage stats, orders, users, error rates, and costs
   */
  r.get('/tenants', async (_req, res) => {
    const orgs = await Organization.find({ deletedAt: null }).sort({ createdAt: -1 });

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const tenants: TenantOverviewDto[] = await Promise.all(
      orgs.map(async (org) => {
        const orgId = org._id;

        const [userCount, totalOrders, orderCountThisMonth, flaggedCount, rejectedCount, costAgg] =
          await Promise.all([
            User.countDocuments({ orgId, active: true }).setOptions({ skipTenant: true }),
            Order.countDocuments({ orgId }).setOptions({ skipTenant: true }),
            Order.countDocuments({ orgId, createdAt: { $gte: startOfMonth } }).setOptions({
              skipTenant: true,
            }),
            Order.countDocuments({ orgId, status: 'flagged' }).setOptions({ skipTenant: true }),
            Order.countDocuments({ orgId, status: 'rejected' }).setOptions({ skipTenant: true }),
            Extraction.aggregate([
              { $match: { orgId } },
              { $group: { _id: null, totalCost: { $sum: '$usage.costUsd' } } },
            ]).option({ skipTenant: true }),
          ]);

        const totalErrors = flaggedCount + rejectedCount;
        const errorRatePct =
          totalOrders > 0 ? Number(((totalErrors / totalOrders) * 100).toFixed(1)) : 0;
        const estimatedLlmCost = costAgg[0]?.totalCost ? Number(costAgg[0].totalCost.toFixed(4)) : 0;

        return {
          id: orgId.toString(),
          name: org.name,
          slug: org.slug,
          plan: org.plan,
          subscriptionStatus: org.subscriptionStatus ?? 'trialing',
          createdAt: org.createdAt.toISOString(),
          userCount,
          orderCountThisMonth,
          totalOrders,
          estimatedLlmCost,
          errorRatePct,
        };
      }),
    );

    res.json({ tenants });
  });

  /**
   * Detailed single tenant view
   */
  r.get('/tenants/:id', async (req, res) => {
    const org = await Organization.findById(req.params.id);
    if (!org || org.deletedAt) throw notFound('Organization not found');

    const orgId = org._id;
    const users = await User.find({ orgId }).setOptions({ skipTenant: true }).sort({ createdAt: -1 });
    const recentOrders = await Order.find({ orgId })
      .setOptions({ skipTenant: true })
      .sort({ createdAt: -1 })
      .limit(10);

    res.json({
      organization: toOrgDto(org),
      settings: org.settings,
      users: users.map(toUserDto),
      recentOrders: recentOrders.map((o) => ({
        id: o._id.toString(),
        poNumber: o.poNumber,
        status: o.status,
        confidence: o.confidence,
        createdAt: o.createdAt.toISOString(),
      })),
    });
  });

  /**
   * Failed queue jobs list
   */
  r.get('/failed-jobs', async (_req, res) => {
    const jobs = await Job.find({ status: 'failed' }).sort({ updatedAt: -1 }).limit(100);

    const failedJobs: FailedJobDto[] = jobs.map((j) => ({
      id: j._id.toString(),
      type: j.name,
      orgId: j.orgId?.toString() ?? '',
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      lastError: j.lastError ?? 'Unknown error',
      failedAt: j.updatedAt.toISOString(),
      createdAt: j.createdAt.toISOString(),
    }));

    res.json({ jobs: failedJobs });
  });

  /**
   * Retry a failed queue job
   */
  r.post('/failed-jobs/:id/retry', async (req, res) => {
    const job = await Job.findById(req.params.id);
    if (!job) throw notFound('Job not found');

    job.status = 'waiting';
    job.attempts = 0;
    job.runAt = new Date();
    job.lockedUntil = undefined;
    await job.save();

    res.json({ ok: true, job: { id: job._id.toString(), status: job.status } });
  });

  /**
   * Dismiss a failed queue job
   */
  r.post('/failed-jobs/:id/dismiss', async (req, res) => {
    const job = await Job.findById(req.params.id);
    if (!job) throw notFound('Job not found');

    job.status = 'completed';
    job.finishedAt = new Date();
    await job.save();

    res.json({ ok: true, dismissed: true });
  });

  /**
   * Support Impersonation: issue session cookies for the target user with superadmin audit log
   */
  r.post('/impersonate/:userId', async (req, res) => {
    const caller = authed(req).user;
    if (!Types.ObjectId.isValid(req.params.userId)) {
      throw notFound('User not found');
    }

    const targetUser = await User.findById(req.params.userId).setOptions({ skipTenant: true });
    if (!targetUser || !targetUser.active) {
      throw notFound('User not found or inactive');
    }

    // Set new session cookies for the impersonated user
    await issueSession(targetUser, req, res);

    // Audit the impersonation event under target user's org
    await audit({
      orgId: targetUser.orgId,
      action: 'auth.impersonated',
      actor: {
        userId: caller._id,
        email: caller.email,
        type: 'superadmin',
      },
      entity: { type: 'user', id: targetUser._id.toString() },
      summary: {
        impersonatedEmail: targetUser.email,
        superAdminEmail: caller.email,
        targetOrgId: targetUser.orgId.toString(),
      },
      req,
    });

    res.json({
      ok: true,
      impersonated: true,
      user: toUserDto(targetUser),
    });
  });

  return r;
}
