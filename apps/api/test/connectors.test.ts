import { describe, expect, it } from 'vitest';
import { MockConnector } from '@keyless/core/connectors/mock';
import { Connector } from '@keyless/core/models/Connector';
import { CustomerPrice } from '@keyless/core/models/CustomerPrice';
import { MockErpOrder } from '@keyless/core/models/MockErpOrder';
import { Organization } from '@keyless/core/models/Organization';
import { Product } from '@keyless/core/models/Product';
import { useTestApp } from './helpers';

const t = useTestApp();

describe('MockConnector', () => {
  it('admin connects the demo ERP and syncs customers, products and prices', async () => {
    const admin = await t.createUser({ role: 'admin' });
    const c = await t.loginAs(admin.email);

    const created = await c.post('/api/connectors', {
      type: 'mock',
      settings: { productCount: 500 },
    });
    expect(created.status).toBe(201);
    expect(created.body.connector).toMatchObject({
      type: 'mock',
      status: 'connected',
      isDefault: true,
    });
    const id = created.body.connector.id;
    expect((await Organization.findById(admin.orgId))!.settings.defaultConnector).toBe(id);

    const sync = await c.post(`/api/connectors/${id}/sync`, {
      entities: ['prices', 'products', 'customers'],
    });
    expect(sync.status).toBe(200);
    // Dependency order regardless of request order.
    expect(sync.body.results.map((r: { entity: string }) => r.entity)).toEqual([
      'customers',
      'products',
      'prices',
    ]);
    expect(sync.body.results[1]).toMatchObject({ entity: 'products', created: 500, updated: 0 });
    expect(sync.body.results[2].errors).toEqual([]);
    expect(await Product.countDocuments({ orgId: admin.orgId, source: 'connector' })).toBe(500);
    expect(await CustomerPrice.countDocuments({ orgId: admin.orgId })).toBeGreaterThan(0);

    const again = await c.post(`/api/connectors/${id}/sync`, { entities: ['products', 'stock'] });
    expect(again.body.results[0]).toMatchObject({ created: 0, updated: 500 });
    expect(again.body.connector.lastSyncAt).not.toBeNull();

    const list = await c.get('/api/connectors');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.available).toEqual(['mock']);
  });

  it('deactivates products that disappear from the ERP', async () => {
    const admin = await t.createUser({ role: 'admin' });
    const c = await t.loginAs(admin.email);
    const { body } = await c.post('/api/connectors', {
      type: 'mock',
      settings: { productCount: 50 },
    });
    await c.post(`/api/connectors/${body.connector.id}/sync`, { entities: ['products'] });
    await Connector.updateOne(
      { _id: body.connector.id, orgId: admin.orgId },
      { settings: { productCount: 40 } },
    );
    const res = await c.post(`/api/connectors/${body.connector.id}/sync`, {
      entities: ['products'],
    });
    expect(res.body.results[0].deactivated).toBe(10);
    expect(await Product.countDocuments({ orgId: admin.orgId, active: true })).toBeLessThanOrEqual(
      40,
    );
  });

  it('createSalesOrder is idempotent', async () => {
    const admin = await t.createUser({ role: 'admin' });
    const connector = await Connector.create({ orgId: admin.orgId, type: 'mock', name: 'Mock' });
    const mock = new MockConnector({ orgId: admin.orgId, connector });
    const order = {
      customerRef: 'BREW001',
      poNumber: 'PO-1',
      currency: 'GBP',
      lines: [{ lineNo: 1, sku: 'GL1001', quantity: 2 }],
    };

    const first = await mock.createSalesOrder(order, 'key-1');
    const retry = await mock.createSalesOrder(order, 'key-1');
    expect(first).toEqual({ ok: true, reference: 'SO-10001', alreadyExisted: false });
    expect(retry).toEqual({ ok: true, reference: 'SO-10001', alreadyExisted: true });
    expect(await MockErpOrder.countDocuments({ orgId: admin.orgId })).toBe(1);
    expect(await mock.findExistingOrder('BREW001', 'PO-1')).toMatchObject({
      reference: 'SO-10001',
    });
    expect(await mock.findExistingOrder('BREW001', 'PO-2')).toBeNull();
  });

  it('only admins manage connectors; unavailable types are refused', async () => {
    const admin = await t.createUser({ role: 'admin' });
    const reviewer = await t.createUser({ role: 'reviewer', orgId: admin.orgId });
    const c = await t.loginAs(admin.email);
    expect((await c.post('/api/connectors', { type: 'unleashed' })).body.error.code).toBe(
      'CONNECTOR_UNAVAILABLE',
    );
    const { body } = await c.post('/api/connectors', { type: 'mock' });

    const rc = await t.loginAs(reviewer.email);
    expect((await rc.get('/api/connectors')).status).toBe(200);
    expect((await rc.post(`/api/connectors/${body.connector.id}/sync`, {})).status).toBe(403);
    expect((await rc.post('/api/connectors', { type: 'mock' })).status).toBe(403);
  });
});
