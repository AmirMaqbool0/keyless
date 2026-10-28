import request from 'supertest';
import type { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { upsertCustomers, upsertProducts } from '@keyless/core/catalogue/upsert';
import {
  sampleEmail,
  type SampleContext,
  type SampleScenario,
} from '@keyless/core/demo/sampleEmails';
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
        sku: 'BL2002',
        description: 'Refuse Sacks Black Heavy Duty',
        uom: 'ROLL',
        defaultPrice: 9.95,
        stockQty: 100,
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
      {
        accountCode: 'HOLD001',
        name: 'Late Payers Ltd',
        emailDomains: ['latepayers.example'],
        creditHold: true,
      },
    ],
    'manual',
  );
}

async function setup(role: 'owner' | 'viewer' = 'owner') {
  const owner = await t.createUser({ role: 'owner' });
  await seedCatalogue(owner.orgId);
  const c = await t.loginAs(owner.email);
  const mailboxes = await c.get('/api/mailboxes');
  const to: string = mailboxes.body.items.find(
    (m: { type: string }) => m.type === 'forwarding',
  ).address;
  const viewer =
    role === 'viewer' ? await t.createUser({ role: 'viewer', orgId: owner.orgId }) : undefined;
  return { owner, c, to, viewer };
}

const ctx = (to: string, over: Partial<SampleContext> = {}): SampleContext => ({
  customerName: 'Brew Cafe',
  senderName: 'Sam Buyer',
  senderAddress: 'orders@brewcafe.example',
  to,
  poNumber: 'PO-4471',
  deliveryAddress: ['1 High Street', 'Leeds', 'LS1 4AB'],
  lines: [
    { code: 'GL1001', description: 'Nitrile Gloves Blue Medium', quantity: 10, unitPrice: 4.5 },
    { code: 'BL2002', description: 'Refuse Sacks Black', quantity: 4, unitPrice: 9.95 },
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

type ListItem = {
  id: string;
  status: string;
  colour: string;
  poNumber: string;
  topIssue: string | null;
};
const orders = async (
  c: Awaited<ReturnType<typeof t.loginAs>>,
  view = 'all',
): Promise<ListItem[]> => (await c.get(`/api/orders?view=${view}`)).body.items;
const issueCodes = (detail: { issues: { code: string }[] }) =>
  detail.issues.map((i) => i.code).sort();

describe('PO email -> coloured order (the M5 "done when")', () => {
  it('a clean PO from a known customer becomes a green, ready order', async () => {
    const { c, to } = await setup();
    await send('pdf_po', ctx(to));

    const [item] = await orders(c);
    expect(item).toMatchObject({
      status: 'ready',
      colour: 'green',
      poNumber: 'PO-4471',
      topIssue: null,
    });
    expect((await c.get('/api/orders/counts')).body).toMatchObject({
      ready: 1,
      needs_review: 0,
      on_hold: 0,
      all: 1,
      byColour: { green: 1 },
    });

    const detail = (await c.get(`/api/orders/${item!.id}`)).body;
    expect(detail.customerMatch).toMatchObject({ accountCode: 'BREW001', method: 'sender' });
    expect(
      detail.lines.map((l: { match: { sku: string; method: string } }) => [
        l.match.sku,
        l.match.method,
      ]),
    ).toEqual([
      ['GL1001', 'sku'],
      ['BL2002', 'sku'],
    ]);
    expect(detail).toMatchObject({ value: 84.8, issues: [] });
    expect(detail.source.attachmentUrl).toMatch(/^\/api\/files\//);

    const email = (await c.get(`/api/emails/${detail.email.id}`)).body;
    expect(email.orders).toEqual([
      expect.objectContaining({ id: item!.id, relation: 'created', colour: 'green' }),
    ]);
  });

  it('amber: unknown sender and price differences, with the reasons listed', async () => {
    const { c, to } = await setup();
    await send(
      'pdf_po',
      ctx(to, {
        senderAddress: 'someone@unknown.example',
        customerName: 'Mystery Co',
        lines: [
          {
            code: 'GL1001',
            description: 'Nitrile Gloves Blue Medium',
            quantity: 10,
            unitPrice: 3.99,
          },
        ],
      }),
    );
    const [item] = await orders(c, 'needs_review');
    expect(item).toMatchObject({ colour: 'amber', status: 'needs_review' });
    expect(issueCodes((await c.get(`/api/orders/${item!.id}`)).body)).toEqual([
      'customer_unknown',
      'price_mismatch',
    ]);
  });

  it('red: credit hold and duplicate POs', async () => {
    const { c, to } = await setup();
    await send(
      'pdf_po',
      ctx(to, {
        senderAddress: 'buyer@latepayers.example',
        customerName: 'Late Payers',
        poNumber: 'LP-1',
      }),
    );
    const [held] = await orders(c, 'on_hold');
    expect(held).toMatchObject({ colour: 'red', status: 'on_hold' });
    expect(issueCodes((await c.get(`/api/orders/${held!.id}`)).body)).toContain('credit_hold');

    await send('pdf_po', ctx(to));
    await send('csv_po', ctx(to)); // the same PO sent again, in a different format
    const all = await orders(c);
    expect(
      all
        .filter((o) => o.poNumber === 'PO-4471')
        .map((o) => o.status)
        .sort(),
    ).toEqual(['duplicate', 'ready']);
  });

  it('links amendments and cancellations to the original order', async () => {
    const { c, to } = await setup();
    await send('pdf_po', ctx(to));
    const [order] = await orders(c);

    const amendId = await send('amendment', ctx(to));
    let detail = (await c.get(`/api/orders/${order!.id}`)).body;
    expect(detail).toMatchObject({ status: 'needs_review', colour: 'amber' });
    expect(issueCodes(detail)).toEqual(['amendment_received']);
    expect(detail.relatedEmails).toEqual([
      expect.objectContaining({ emailId: amendId, kind: 'amendment' }),
    ]);
    expect((await c.get(`/api/emails/${amendId}`)).body.orders).toEqual([
      expect.objectContaining({ id: order!.id, relation: 'changes' }),
    ]);

    await send('cancellation', ctx(to));
    detail = (await c.get(`/api/orders/${order!.id}`)).body;
    expect(detail).toMatchObject({ status: 'on_hold', colour: 'red' });
    expect(
      detail.issues.find((i: { code: string }) => i.code === 'cancellation_received'),
    ).toMatchObject({ blocking: true });
    expect(await orders(c)).toHaveLength(1); // neither email created an order of its own
  });

  it('re-matches after the catalogue changes, but never touches approved or edited orders', async () => {
    const { c, to, owner, viewer } = await setup('viewer');
    await send(
      'pdf_po',
      ctx(to, {
        lines: [{ code: 'NEW-9', description: 'Blue Paper Roll 2ply', quantity: 6, unitPrice: 12 }],
      }),
    );
    const [before] = await orders(c);
    expect(before).toMatchObject({ colour: 'red' }); // every line unknown

    const v = await t.loginAs(viewer!.email);
    expect((await v.post(`/api/orders/${before!.id}/rematch`)).status).toBe(403);

    await upsertProducts(
      owner.orgId,
      [{ sku: 'NEW-9', description: 'Blue Paper Roll 2ply', defaultPrice: 12 }],
      'manual',
    );
    expect((await c.post(`/api/orders/${before!.id}/rematch`)).status).toBe(200);
    await t.drainJobs();
    const [after] = await orders(c);
    expect(after).toMatchObject({ colour: 'green', status: 'ready' });
    // P0-7: Update in place (same _id, version+1)
    expect(after!.id).toBe(before!.id);
    const getOldId = await c.get(`/api/orders/${before!.id}`);
    expect(getOldId.status).toBe(200);
    expect(getOldId.body.colour).toBe('green');
    expect(getOldId.body.version).toBeGreaterThanOrEqual(1);

    await Order.updateOne(
      { orgId: owner.orgId, _id: after!.id },
      { $set: { 'lines.0.edited': true } },
    );
    expect((await c.post(`/api/orders/${after!.id}/rematch`)).body.error.code).toBe('EDITED');
    await Order.updateOne({ orgId: owner.orgId, _id: after!.id }, { $set: { status: 'approved' } });
    const res = await c.post(`/api/orders/${after!.id}/rematch`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOT_REVIEWABLE');
  });

  it('keeps orders inside their organisation', async () => {
    const { c, to } = await setup();
    await send('pdf_po', ctx(to));
    const [item] = await orders(c);
    const other = await t.loginAs((await t.createUser({ role: 'owner' })).email);
    expect((await other.get(`/api/orders/${item!.id}`)).status).toBe(404);
    expect((await other.get('/api/orders?view=all')).body.total).toBe(0);
    expect((await other.post(`/api/orders/${item!.id}/rematch`)).status).toBe(404);
  });

  it('P1-2: re-evaluates validation issues, pricing, and routing after edits', async () => {
    const { c, to, owner } = await setup();

    await upsertCustomers(
      owner.orgId,
      [
        {
          accountCode: 'ABBEY01',
          name: 'Abbey Cafe',
          emailDomains: ['abbey.example'],
          senderAddresses: ['manager@abbey.example'],
          deliveryAddresses: [{ line1: '10 Abbey Road', city: 'Leeds', postcode: 'LS2 9JT' }],
        },
      ],
      'manual',
    );
    await upsertProducts(
      owner.orgId,
      [
        {
          sku: 'GL1459',
          description: 'Caterpak Nitrile Gloves Blue Medium',
          uom: 'BOX',
          packSize: 100,
          defaultPrice: 6.8,
          stockQty: 50,
        },
        {
          sku: 'GL1001',
          description: 'Nitrile Gloves Powder Free Blue Medium',
          uom: 'BOX',
          defaultPrice: 10.75,
          stockQty: 100,
        },
      ],
      'manual',
    );

    await send(
      'pdf_po',
      ctx(to, {
        customerName: 'Unknown Sender Cafe',
        senderAddress: 'unknown@stranger.example',
        deliveryAddress: ['10 Abbey Road', 'Leeds', 'LS2 9JT'],
        lines: [
          { code: 'GL1001', description: 'Nitrile Gloves Blue Medium', quantity: 10, unitPrice: 4.5 },
        ],
      }),
    );

    const [orderBefore] = await orders(c);
    let detail = (await c.get(`/api/orders/${orderBefore!.id}`)).body;

    expect(detail.issues.find((i: { code: string }) => i.code === 'customer_unknown')).toBeDefined();
    const initialPriceIssue = detail.issues.find((i: { code: string }) => i.code === 'price_mismatch');
    expect(initialPriceIssue).toBeDefined();
    expect(initialPriceIssue.message).toContain('10.75');

    const custRes = await c.get('/api/customers?q=Abbey');
    const abbeyId = custRes.body.items[0].id;
    const prodRes = await c.get('/api/products?q=GL1459');
    const gl1459Id = prodRes.body.items[0].id;

    const line1Id = detail.lines[0].id;
    const saveRes = await c.patch(`/api/orders/${orderBefore!.id}`, {
      customerId: abbeyId,
      lines: [
        {
          id: line1Id,
          sku: 'GL1459',
          productId: gl1459Id,
          quantity: 10,
          unitPrice: 4.5,
        },
      ],
    });
    expect(saveRes.status).toBe(200);

    detail = (await c.get(`/api/orders/${orderBefore!.id}`)).body;

    const activeCustUnknown = detail.issues.find(
      (i: { code: string; resolved: boolean }) => i.code === 'customer_unknown' && !i.resolved,
    );
    expect(activeCustUnknown).toBeUndefined();

    const updatedPriceIssue = detail.issues.find((i: { code: string }) => i.code === 'price_mismatch');
    expect(updatedPriceIssue).toBeDefined();
    expect(updatedPriceIssue.message).toContain('6.80');
    expect(updatedPriceIssue.message).not.toContain('10.75');

    const dismissRes = await c.post(`/api/orders/${orderBefore!.id}/issues/${updatedPriceIssue.id}/dismiss`);
    expect(dismissRes.status).toBe(200);

    detail = (await c.get(`/api/orders/${orderBefore!.id}`)).body;
    expect(detail.colour).toBe('green');
    expect(detail.status).toBe('ready');

    await c.patch(`/api/orders/${orderBefore!.id}`, {
      notes: 'Preserve dismissal test',
    });
    detail = (await c.get(`/api/orders/${orderBefore!.id}`)).body;
    const dismissedIssue = detail.issues.find((i: { code: string }) => i.code === 'price_mismatch');
    expect(dismissedIssue).toBeDefined();
    expect(dismissedIssue.resolved).toBe(true);
    expect(dismissedIssue.dismissedBy).toBeDefined();
    expect(detail.status).toBe('ready');
  });
});
