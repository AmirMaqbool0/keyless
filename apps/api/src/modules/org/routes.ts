import { Router } from 'express';
import { updateOrganizationSchema } from '@keyless/shared';
import { audit } from '../../lib/audit';
import { validate } from '../../lib/http';
import { authed, requireRole } from '../../middleware/auth';
import { toOrgDto } from '../dto';

/** Mounted behind requireAuth + requireVerified. */
export function orgRouter(): Router {
  const r = Router();

  r.get('/', (req, res) => {
    res.json({ organization: toOrgDto(authed(req).org) });
  });

  r.patch('/', requireRole('admin'), async (req, res) => {
    const { org, orgId } = authed(req);
    const input = validate(updateOrganizationSchema, req.body);
    const before = toOrgDto(org);
    org.set(input);
    await org.save();
    await audit({
      orgId,
      action: 'org.updated',
      entity: { type: 'organization', id: orgId.toString() },
      summary: { before, after: input },
      req,
    });
    res.json({ organization: toOrgDto(org) });
  });

  return r;
}
