import request from 'supertest';
import type { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { upsertCustomers, upsertProducts } from '@keyless/core/catalogue/upsert';
import {
  sampleEmail,
  type SampleContext,
  type SampleScenario,
} from '@keyless/core/demo/sampleEmails';
import { CsvExportOrder } from '@keyless/core/models/CsvExportOrder';
import { MockErpOrder } from '@keyless/core/models/MockErpOrder';
import { Order } from '@keyless/core/models/Order';
import { useTestApp } from './helpers';

const t = useTestApp();
const SECRET = 'test-inbound-secret';

async function seedCatalogue(orgId: Types.ObjectId) {
  await upsertProducts(
    orgId,
    [
      {
        sku: 'GL1001',
        description: 'Nitrile Gloves Powder Free Blue Medium',
        uom: 'BOX',
        defaultPrice: 4.5,
        stockQty: 100,
      },
      {
        sku: 'SP500',
        description: 'Eco Hand Soap Liquid 500ml Pump',
        uom: 'BOTTLE',
        defaultPrice: 3.25,
        stockQty: 50,
      },
    ],
    'manual',
  );
  await upsertCustomers(
    orgId,
    [
      {
        accountCode: 'BREW001',
        name: 'Brew Cafe Ltd',
        emailDomains: ['brewcafe.example'],
        senderAddresses: ['orders@brewcafe.example'],
        deliveryAddresses: [{ line1: '1 High Street', city: 'Leeds', postcode: 'LS1 4AB' }],
      },
    ],
    'manual',
  );
}

async function setup() {
  const owner = await t.createUser({ role: 'owner' });
  await seedCatalogue(owner.orgId);
  const reviewer = await t.createUser({ role: 'reviewer', orgId: owner.orgId });

  const cOwner = await t.loginAs(owner.email);
  const cReviewer = await t.loginAs(reviewer.email);

  const mailboxes = await cOwner.get('/api/mailboxes');
  const to: string = mailboxes.body.items.find(
    (m: { type: string }) => m.type === 'forwarding',
  ).address;

  return { owner, reviewer, cOwner, cReviewer, to };
}

const ctx = (to: string, over: Partial<SampleContext> = {}): SampleContext => ({
  customerName: 'Brew Cafe',
  senderName: 'Sam Buyer',
  senderAddress: 'orders@brewcafe.example',
  to,
  poNumber: 'PO-M7-001',
  deliveryAddress: ['1 High Street', 'Leeds', 'LS1 4AB'],
  lines: [
    { code: 'GL1001', description: 'Nitrile Gloves Blue M', quantity: 10, unitPrice: 4.5 },
  ],
  ...over,
});

async function send(scenario: SampleScenario, context: SampleContext) {
  const res = await request(t.app)
    .post('/webhooks/inbound')
    .set('Content-Type', 'message/rfc822')
    .set('X-Inbound-Secret', SECRET)
    .send(await sampleEmail(scenario, context));
  expect(res.status).toBe(200);
  await t.drainJobs();
  return res.body.emailId as string;
}

describe('M7: Push to systems (ERP Connectors)', () => {
  it('approved order pushes automatically to MockConnector and creates ERP sales order', async () => {
    const { cOwner, cReviewer, to, owner } = await setup();

    // 1. Setup MockConnector as default
    const connRes = await cOwner.post('/api/connectors', {
      type: 'mock',
      name: 'Demo ERP',
      settings: { productCount: 20 },
    });
    expect(connRes.status).toBe(201);
    expect(connRes.body.connector.status).toBe('connected');

    // 2. Ingest PO
    await send('pdf_po', ctx(to, { poNumber: 'PO-M7-MOCK-1' }));

    const listRes = await cReviewer.get('/api/orders?view=all');
    expect(listRes.status).toBe(200);
    expect(listRes.body.items).toHaveLength(1);
    const orderId = listRes.body.items[0].id;

    // 3. Approve order
    const approveRes = await cReviewer.post(`/api/orders/${orderId}/approve`);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('pushed');
    expect(approveRes.body.erpReference).toMatch(/^SO-/);

    // 4. Verify order in DB
    const orderDoc = await Order.findOne({ _id: orderId, orgId: owner.orgId });
    expect(orderDoc?.status).toBe('pushed');
    expect(orderDoc?.erpReference).toBe(approveRes.body.erpReference);
    expect(orderDoc?.pushedAt).toBeInstanceOf(Date);

    // 5. Verify MockErpOrder record created
    const erpOrder = await MockErpOrder.findOne({
      orgId: owner.orgId,
      erpReference: approveRes.body.erpReference,
    });
    expect(erpOrder).not.toBeNull();
    expect(erpOrder?.customerRef).toBe('BREW001');
    expect(erpOrder?.poNumber).toBe('PO-M7-MOCK-1');
    const lines = (erpOrder?.payload as { lines?: Array<{ sku: string }> })?.lines;
    expect(lines).toHaveLength(1);
    expect(lines?.[0]?.sku).toBe('GL1001');
  });

  it('idempotency: retrying push returns existing reference without duplicate records', async () => {
    const { cOwner, cReviewer, to, owner } = await setup();

    await cOwner.post('/api/connectors', {
      type: 'mock',
      name: 'Demo ERP',
      settings: { productCount: 20 },
    });

    await send('pdf_po', ctx(to, { poNumber: 'PO-M7-IDEMPOTENT' }));
    const listRes = await cReviewer.get('/api/orders?view=all');
    const orderId = listRes.body.items[0].id;

    const first = await cReviewer.post(`/api/orders/${orderId}/approve`);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('pushed');
    const ref = first.body.erpReference;

    // Retry push
    const retry = await cReviewer.post(`/api/orders/${orderId}/retry-push`);
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('pushed');
    expect(retry.body.erpReference).toBe(ref);

    // Exactly one MockErpOrder should exist for this reference
    const count = await MockErpOrder.countDocuments({
      orgId: owner.orgId,
      erpReference: ref,
    });
    expect(count).toBe(1);
  });

  it('CSV export connector generates RFC-compliant CSV files in storage', async () => {
    const { cOwner, cReviewer, to, owner } = await setup();

    // Create CSV Export connector and set as default
    const csvConn = await cOwner.post('/api/connectors', {
      type: 'csv_export',
      name: 'CSV Pipeline',
      settings: { folder: 'test-exports', delimiter: ',' },
    });
    expect(csvConn.status).toBe(201);
    expect(csvConn.body.connector.status).toBe('connected');

    await send('pdf_po', ctx(to, { poNumber: 'PO-M7-CSV-1' }));
    const listRes = await cReviewer.get('/api/orders?view=all');
    const orderId = listRes.body.items[0].id;

    // Approve order
    const approveRes = await cReviewer.post(`/api/orders/${orderId}/approve`);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('pushed');
    expect(approveRes.body.erpReference).toMatch(/^CSV-/);

    // Check CsvExportOrder record
    const exportRecord = await CsvExportOrder.findOne({
      orgId: owner.orgId,
      reference: approveRes.body.erpReference,
    });
    expect(exportRecord).not.toBeNull();
    expect(exportRecord?.customerRef).toBe('BREW001');
    expect(exportRecord?.poNumber).toBe('PO-M7-CSV-1');
    expect(exportRecord?.storageKey).toContain('test-exports/');

    // Check file content via storage
    const fileBytes = await t.storage.get(exportRecord!.storageKey);
    const csvText = fileBytes.toString('utf8');
    expect(csvText).toContain('PO Number');
    expect(csvText).toContain('Customer Account');
    expect(csvText).toContain('PO-M7-CSV-1');
    expect(csvText).toContain('BREW001');
    expect(csvText).toContain('GL1001');
  });

  it('handles push failures and allows retry-push', async () => {
    const { cOwner, cReviewer, to } = await setup();

    // Create a connector that fails connection or push (e.g. invalid unleashed creds)
    const badConn = await cOwner.post('/api/connectors', {
      type: 'unleashed',
      name: 'Unleashed Broken',
      credentials: { apiId: 'invalid-id', apiKey: 'invalid-key' },
    });
    expect(badConn.status).toBe(201);
    // Unleashed testConnection fails with invalid credentials against live API or offline
    expect(badConn.body.connector.status).toBe('error');

    await send('pdf_po', ctx(to, { poNumber: 'PO-M7-FAIL' }));
    const listRes = await cReviewer.get('/api/orders?view=all');
    const orderId = listRes.body.items[0].id;

    // Approving while the only active connector errors should transition order to push_failed
    const approveRes = await cReviewer.post(`/api/orders/${orderId}/approve`);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('push_failed');
    expect(approveRes.body.lastPushError).toBeDefined();

    // Switch default connector to MockConnector
    const mockConn = await cOwner.post('/api/connectors', {
      type: 'mock',
      name: 'Working Demo ERP',
    });
    await cOwner.patch(`/api/connectors/${mockConn.body.connector.id}`, { isDefault: true });

    // Retry push
    const retryRes = await cReviewer.post(`/api/orders/${orderId}/retry-push`);
    expect(retryRes.status).toBe(200);
    expect(retryRes.body.ok).toBe(true);
    expect(retryRes.body.status).toBe('pushed');
    expect(retryRes.body.erpReference).toMatch(/^SO-/);
  });

  it('P0-4: approving with no active connector marks order push_failed and does not increment Sent count', async () => {
    const { cReviewer, to, owner } = await setup();

    // No connector is created.
    await send('pdf_po', ctx(to, { poNumber: 'PO-M7-NO-CONN' }));
    const listRes = await cReviewer.get('/api/orders?view=all');
    const orderId = listRes.body.items[0].id;

    // Approve order without connector configured
    const approveRes = await cReviewer.post(`/api/orders/${orderId}/approve`);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('push_failed');
    expect(approveRes.body.lastPushError).toContain('No active connector');

    // DB state
    const orderDoc = await Order.findOne({ _id: orderId, orgId: owner.orgId });
    expect(orderDoc?.status).toBe('push_failed');
    expect(orderDoc?.lastPushError).toContain('No active connector');

    // Counts endpoint must report pushed: 0, not incremented
    const countsRes = await cReviewer.get('/api/orders/counts');
    expect(countsRes.status).toBe(200);
    expect(countsRes.body.pushed).toBe(0);
    expect(countsRes.body.failed).toBe(1);
  });

  it('P0-4: safeguardStuckPushJobs marks orders stuck in approved/pushing for >15 min as push_failed', async () => {
    const { cReviewer, to, owner } = await setup();

    await send('pdf_po', ctx(to, { poNumber: 'PO-M7-STUCK' }));
    const listRes = await cReviewer.get('/api/orders?view=all');
    const orderId = listRes.body.items[0].id;

    // Manually simulate order stuck in approved with approvedAt 20 minutes ago
    const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000);
    await Order.updateOne(
      { _id: orderId, orgId: owner.orgId },
      { $set: { status: 'approved', approvedAt: twentyMinsAgo, updatedAt: twentyMinsAgo } },
      { timestamps: false },
    );

    // Fetching the order triggers safeguardStuckPushJobs
    const getRes = await cReviewer.get(`/api/orders/${orderId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.status).toBe('push_failed');
    expect(getRes.body.lastPushError).toContain('timed out');
  });
});
