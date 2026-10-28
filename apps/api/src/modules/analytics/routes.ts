import { Router } from 'express';
import { updateAnalyticsSettingsSchema } from '@keyless/shared';
import { audit } from '@keyless/core/lib/audit';
import { badRequest, validate } from '@keyless/core/lib/http';
import { getAnalyticsSummary, getValueReport } from '@keyless/core/analytics/service';
import { Organization } from '@keyless/core/models/Organization';
import { authed, requireRole } from '../../middleware/auth';

export function analyticsRouter(): Router {
  const r = Router();

  /** Get dashboard metrics summary */
  r.get('/summary', async (req, res) => {
    const { orgId } = authed(req);

    const fromQuery = req.query.from ? new Date(String(req.query.from)) : undefined;
    const toQuery = req.query.to ? new Date(String(req.query.to)) : undefined;

    const summary = await getAnalyticsSummary(orgId, {
      from: fromQuery && !isNaN(fromQuery.getTime()) ? fromQuery : undefined,
      to: toQuery && !isNaN(toQuery.getTime()) ? toQuery : undefined,
    });

    res.json(summary);
  });

  /** Get executive value report with ROI */
  r.get('/value-report', async (req, res) => {
    const { orgId } = authed(req);
    const days = req.query.days ? parseInt(String(req.query.days), 10) : 30;
    const report = await getValueReport(orgId, isNaN(days) ? 30 : Math.min(365, Math.max(1, days)));
    res.json(report);
  });

  /** Update analytics calculation settings (minutes per order, staff cost) */
  r.patch('/settings', requireRole('admin'), async (req, res) => {
    const { orgId } = authed(req);
    const input = validate(updateAnalyticsSettingsSchema, req.body);

    const org = await Organization.findById(orgId);
    if (!org) throw badRequest('Organization not found');

    if (input.minutesSavedPerOrder !== undefined) {
      org.settings.minutesSavedPerOrder = input.minutesSavedPerOrder;
    }
    if (input.hourlyStaffCost !== undefined) {
      org.settings.hourlyStaffCost = input.hourlyStaffCost;
    }
    await org.save();

    await audit({
      orgId,
      action: 'analytics.settings_updated',
      entity: { type: 'organization', id: orgId.toString() },
      summary: input,
      req,
    });

    res.json({
      ok: true,
      settings: {
        minutesSavedPerOrder: org.settings.minutesSavedPerOrder,
        hourlyStaffCost: org.settings.hourlyStaffCost,
      },
    });
  });

  return r;
}
