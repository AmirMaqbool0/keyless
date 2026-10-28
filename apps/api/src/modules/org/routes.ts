import { Router } from 'express';
import {
  deleteOrgSchema,
  updateOrganizationSchema,
  type IntegrationPipelineStatusDto,
} from '@keyless/shared';
import { env } from '@keyless/core/config/env';
import { audit } from '@keyless/core/lib/audit';
import { badRequest, validate } from '@keyless/core/lib/http';
import { pruneExpiredTenantData } from '@keyless/core/retention/cleanup';
import { Connector } from '@keyless/core/models/Connector';
import { CrossReference } from '@keyless/core/models/CrossReference';
import { Customer } from '@keyless/core/models/Customer';
import { CustomerPrice } from '@keyless/core/models/CustomerPrice';
import { Extraction } from '@keyless/core/models/Extraction';
import { InboundEmail } from '@keyless/core/models/InboundEmail';
import { Mailbox } from '@keyless/core/models/Mailbox';
import { Order } from '@keyless/core/models/Order';
import { Product } from '@keyless/core/models/Product';
import { Rule } from '@keyless/core/models/Rule';
import { Session } from '@keyless/core/models/Session';
import { User } from '@keyless/core/models/User';
import type { AppDeps } from '../../app';
import { authed, requireRole } from '../../middleware/auth';
import { clearAuthCookies } from '../auth/tokens';
import { toOrgDto } from '../dto';

/** Mounted behind requireAuth + requireVerified. */
export function orgRouter(deps?: Partial<AppDeps>): Router {
  const r = Router();

  r.get('/', (req, res) => {
    res.json({ organization: toOrgDto(authed(req).org) });
  });

  r.get('/pipeline-status', async (req, res) => {
    const { orgId } = authed(req);

    const [connector, mailboxes, latestEmail, latestExtraction] = await Promise.all([
      Connector.findOne({ orgId, status: { $ne: 'disconnected' } }),
      Mailbox.find({ orgId }),
      InboundEmail.findOne({ orgId }).sort({ receivedAt: -1 }),
      Extraction.findOne({ orgId }).sort({ createdAt: -1 }),
    ]);

    const erpConnected = Boolean(connector && connector.status !== 'disconnected');
    const emailAddress = mailboxes[0]?.address ?? null;
    const emailStatus = mailboxes.length > 0 ? 'listening' : 'not_configured';
    const aiStatus = env.LLM_PROVIDER !== 'mock' || env.NODE_ENV !== 'production' ? 'active' : 'not_configured';
    const mailerConfigured = env.EMAIL_PROVIDER !== 'console' || env.NODE_ENV !== 'production';

    const status: IntegrationPipelineStatusDto = {
      allOperational: erpConnected && emailStatus === 'listening' && aiStatus === 'active' && mailerConfigured,
      erp: {
        name: connector ? connector.name : 'Not connected',
        type: connector ? connector.type : null,
        status: erpConnected ? 'connected' : 'not_connected',
        lastSyncAt: connector?.lastSyncAt?.toISOString() ?? null,
      },
      email: {
        status: emailStatus,
        address: emailAddress,
        lastReceivedAt: latestEmail?.receivedAt?.toISOString() ?? null,
      },
      ai: {
        status: latestExtraction?.status === 'failed' ? 'degraded' : 'active',
        provider: env.LLM_PROVIDER,
        model: env.LLM_MODEL_EXTRACTION || (env.LLM_PROVIDER === 'agentrouter' ? 'gpt-5.6-sol' : 'claude-3-5-sonnet'),
        lastExtractionAt: latestExtraction?.createdAt?.toISOString() ?? null,
      },
      mailer: {
        status: mailerConfigured ? 'verified' : 'not_configured',
        provider: env.EMAIL_PROVIDER,
        from: env.EMAIL_FROM,
      },
    };

    res.json(status);
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

  /**
   * GDPR Data Export: Exports the complete tenant dataset (org settings, customers,
   * catalogue products, customer prices, cross-references, rules, and orders).
   */
  r.post('/export', requireRole('admin'), async (req, res) => {
    const { org, orgId } = authed(req);

    const [customers, products, prices, crossReferences, rules, orders] = await Promise.all([
      Customer.find({ orgId }).lean(),
      Product.find({ orgId }).lean(),
      CustomerPrice.find({ orgId }).lean(),
      CrossReference.find({ orgId }).lean(),
      Rule.find({ orgId }).lean(),
      Order.find({ orgId }).lean(),
    ]);

    await audit({
      orgId,
      action: 'org.exported',
      entity: { type: 'organization', id: orgId.toString() },
      summary: {
        customerCount: customers.length,
        productCount: products.length,
        orderCount: orders.length,
      },
      req,
    });

    res.json({
      exportedAt: new Date().toISOString(),
      organization: toOrgDto(org),
      counts: {
        customers: customers.length,
        products: products.length,
        prices: prices.length,
        crossReferences: crossReferences.length,
        rules: rules.length,
        orders: orders.length,
      },
      data: {
        customers,
        products,
        prices,
        crossReferences,
        rules,
        orders,
      },
    });
  });

  /**
   * GDPR Retention Cleanup: Manually triggers data retention prune for raw emails/attachments
   * older than the retention setting, preserving structured orders.
   */
  r.post('/retention/cleanup', requireRole('admin'), async (req, res) => {
    const { org, orgId } = authed(req);
    const result = await pruneExpiredTenantData(
      { storage: deps?.storage },
      orgId,
      org.settings.retentionDays,
    );

    await audit({
      orgId,
      action: 'org.retention_pruned',
      entity: { type: 'organization', id: orgId.toString() },
      summary: result,
      req,
    });

    res.json({ ok: true, ...result });
  });

  /**
   * GDPR Full Org Deletion: Permanently closes and soft-deletes the organization,
   * invalidates all user sessions, and terminates access (Owner only).
   */
  r.delete('/', requireRole('owner'), async (req, res) => {
    const { org, orgId } = authed(req);
    const input = validate(deleteOrgSchema, req.body);

    if (input.confirmSlug !== org.slug) {
      throw badRequest('Confirmation slug does not match organization slug', 'SLUG_MISMATCH');
    }

    org.deletedAt = new Date();
    await org.save();

    // Revoke all sessions for users in this org
    await Session.updateMany({ orgId }, { revokedAt: new Date() });
    await User.updateMany({ orgId }, { active: false });

    await audit({
      orgId,
      action: 'org.deleted',
      entity: { type: 'organization', id: orgId.toString() },
      summary: { slug: org.slug, name: org.name },
      req,
    });

    clearAuthCookies(res);
    res.json({ ok: true, deleted: true });
  });

  return r;
}
