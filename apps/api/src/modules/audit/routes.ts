import { Router } from 'express';
import { z } from 'zod';
import { validate } from '@keyless/core/lib/http';
import { authed, requireRole } from '../../middleware/auth';
import { AuditLog } from '@keyless/core/models/AuditLog';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime().optional(),
});

/** Mounted behind requireAuth + requireVerified. */
export function auditRouter(): Router {
  const r = Router();

  r.get('/', requireRole('admin'), async (req, res) => {
    const { orgId } = authed(req);
    const { limit, before } = validate(querySchema, req.query);
    const entries = await AuditLog.find({
      orgId,
      ...(before ? { createdAt: { $lt: new Date(before) } } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({
      entries: entries.map((e) => ({
        id: e._id.toString(),
        action: e.action,
        actor: { email: e.actor.email ?? null, type: e.actor.type },
        entity: e.entity,
        summary: e.summary ?? null,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  });

  return r;
}
