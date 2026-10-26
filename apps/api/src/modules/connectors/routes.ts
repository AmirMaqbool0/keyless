import { Router } from 'express';
import { z } from 'zod';
import { CONNECTOR_TYPES, type ConnectorDto } from '@keyless/shared';
import {
  AVAILABLE_CONNECTORS,
  SYNC_ENTITIES,
  createConnector,
  runSync,
} from '@keyless/core/connectors/index';
import { MAX_DEMO_PRODUCTS } from '@keyless/core/demo/generator';
import { audit } from '@keyless/core/lib/audit';
import { badRequest, notFound, param, validate } from '@keyless/core/lib/http';
import { authed, requireRole } from '../../middleware/auth';
import { Connector, type IConnector } from '@keyless/core/models/Connector';
import { objectId } from '../shared';

const LABELS: Record<IConnector['type'], string> = {
  mock: 'Demo ERP (mock)',
  csv_export: 'CSV export',
  unleashed: 'Unleashed',
  cin7_core: 'Cin7 Core',
  quickbooks_online: 'QuickBooks Online',
};

const createSchema = z.object({
  type: z.enum(CONNECTOR_TYPES),
  name: z.string().trim().min(1).max(80).optional(),
  settings: z
    .object({ productCount: z.number().int().min(10).max(MAX_DEMO_PRODUCTS).optional() })
    .optional(),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  isDefault: z.literal(true).optional(),
});
const syncSchema = z.object({
  entities: z
    .array(z.enum(SYNC_ENTITIES))
    .min(1)
    .default([...SYNC_ENTITIES]),
});

function toDto(c: IConnector): ConnectorDto {
  return {
    id: c._id.toString(),
    type: c.type,
    name: c.name,
    status: c.status,
    isDefault: c.isDefault,
    lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
    lastSyncResults: c.lastSyncResults,
    lastError: c.lastError ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

/** Mounted behind requireAuth + requireVerified. */
export function connectorsRouter(): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const { orgId } = authed(req);
    const items = await Connector.find({ orgId }).sort({ createdAt: 1 });
    res.json({ items: items.map(toDto), available: AVAILABLE_CONNECTORS });
  });

  r.post('/', requireRole('admin'), async (req, res) => {
    const { orgId, org } = authed(req);
    const input = validate(createSchema, req.body);
    if (!(AVAILABLE_CONNECTORS as readonly string[]).includes(input.type)) {
      throw badRequest(`${LABELS[input.type]} is not available yet`, 'CONNECTOR_UNAVAILABLE');
    }
    const isFirst = !(await Connector.exists({ orgId }));
    const connector = await Connector.create({
      orgId,
      type: input.type,
      name: input.name ?? LABELS[input.type],
      isDefault: isFirst,
      settings: input.settings ?? {},
    });
    const check = await createConnector(connector).testConnection();
    connector.status = check.ok ? 'connected' : 'error';
    connector.lastError = check.ok ? undefined : check.message;
    await connector.save();
    if (isFirst) {
      org.settings.defaultConnector = connector._id.toString();
      await org.save();
    }
    await audit({
      orgId,
      action: 'connector.created',
      entity: { type: 'connector', id: connector._id.toString() },
      summary: { type: input.type },
      req,
    });
    res.status(201).json({ connector: toDto(connector) });
  });

  async function load(req: Parameters<typeof authed>[0]) {
    const { orgId } = authed(req);
    const connector = await Connector.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!connector) throw notFound('Connector not found');
    return connector;
  }

  r.post('/:id/test', requireRole('admin'), async (req, res) => {
    const connector = await load(req);
    const result = await createConnector(connector).testConnection();
    connector.status = result.ok ? 'connected' : 'error';
    connector.lastError = result.ok ? undefined : result.message;
    await connector.save();
    res.json({ result, connector: toDto(connector) });
  });

  r.post('/:id/sync', requireRole('admin'), async (req, res) => {
    const { orgId } = authed(req);
    const connector = await load(req);
    const { entities } = validate(syncSchema, req.body);
    const results = await runSync(connector, entities);
    await audit({
      orgId,
      action: 'connector.synced',
      entity: { type: 'connector', id: connector._id.toString() },
      summary: { results },
      req,
    });
    res.json({ results, connector: toDto(connector) });
  });

  r.patch('/:id', requireRole('admin'), async (req, res) => {
    const { orgId, org } = authed(req);
    const connector = await load(req);
    const input = validate(updateSchema, req.body);
    if (input.name) connector.name = input.name;
    if (input.isDefault) {
      await Connector.updateMany({ orgId, _id: { $ne: connector._id } }, { isDefault: false });
      connector.isDefault = true;
      org.settings.defaultConnector = connector._id.toString();
      await org.save();
    }
    await connector.save();
    res.json({ connector: toDto(connector) });
  });

  r.delete('/:id', requireRole('admin'), async (req, res) => {
    const { orgId, org } = authed(req);
    const connector = await load(req);
    await Connector.deleteOne({ _id: connector._id, orgId });
    if (org.settings.defaultConnector === connector._id.toString()) {
      org.settings.defaultConnector = null;
      await org.save();
    }
    // Synced products/customers stay: orders and cross-references depend on them.
    await audit({
      orgId,
      action: 'connector.deleted',
      entity: { type: 'connector', id: connector._id.toString() },
      summary: { type: connector.type },
      req,
    });
    res.status(204).end();
  });

  return r;
}
