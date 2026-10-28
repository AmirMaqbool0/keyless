import request from 'supertest';
import type { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { upsertCustomers, upsertProducts } from '@keyless/core/catalogue/upsert';
import {
  sampleEmail,
  type SampleContext,
  type SampleScenario,
} from '@keyless/core/demo/sampleEmails';
import { CrossReference } from '@keyless/core/models/CrossReference';
import { Customer } from '@keyless/core/models/Customer';
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
  const viewer = await t.createUser({ role: 'viewer', orgId: owner.orgId });

  const cOwner = await t.loginAs(owner.email);
  const cReviewer = await t.loginAs(reviewer.email);
  const cViewer = await t.loginAs(viewer.email);

  const mailboxes = await cOwner.get('/api/mailboxes');
  const to: string = mailboxes.body.items.find(
    (m: { type: string }) => m.type === 'forwarding',
  ).address;

  return { owner, reviewer, viewer, cOwner, cReviewer, cViewer, to };
}

const ctx = (to: string, over: Partial<SampleContext> = {}): SampleContext => ({
  customerName: 'Brew Cafe',
  senderName: 'Sam Buyer',
  senderAddress: 'orders@brewcafe.example',
  to,
  poNumber: 'PO-M6-001',
  deliveryAddress: ['1 High Street', 'Leeds', 'LS1 4AB'],
  lines: [
    { code: 'BC-SOAP-99', description: 'Liquid Hand Soap 500ml', quantity: 6, unitPrice: 3.25 },
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

describe('M6: Review screen, editing and the learning loop', () => {
  it('correcting a line once makes the next PO from that customer match automatically (Done When)', async () => {
    const { cReviewer, to, owner } = await setup();

    // 1. Send first PO with custom customer part code 'BC-SOAP-99'
    await send('pdf_po', ctx(to, { poNumber: 'PO-M6-FIRST' }));

    const listRes = await cReviewer.get('/api/orders?view=needs_review');
    expect(listRes.status).toBe(200);
    expect(listRes.body.items).toHaveLength(1);
    const order1 = listRes.body.items[0];

    // Detail view: line is unmatched or fuzzy
    const detail1 = (await cReviewer.get(`/api/orders/${order1.id}`)).body;
    expect(detail1.lines).toHaveLength(1);
    expect(detail1.lines[0].customerPartCode).toBe('BC-SOAP-99');
    expect(detail1.lines[0].match.method).not.toBe('xref_code');

    // 2. Reviewer corrects line 1 to SKU 'SP500'
    const patchRes = await cReviewer.patch(`/api/orders/${order1.id}`).send({
      lines: [
        {
          id: detail1.lines[0].id,
          sku: 'SP500',
        },
      ],
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.ok).toBe(true);

    // 3. Verify a Correction document was recorded
    const correctionsRes = await cReviewer.get(`/api/orders/${order1.id}/corrections`);
    expect(correctionsRes.status).toBe(200);
    expect(correctionsRes.body.length).toBeGreaterThanOrEqual(1);
    expect(correctionsRes.body[0]).toMatchObject({
      field: 'sku',
      after: 'SP500',
    });

    // 4. Verify CrossReference was created with source: 'learned'
    const xref = await CrossReference.findOne({
      orgId: owner.orgId,
      customerPartCode: 'BC-SOAP-99',
    });
    expect(xref).toBeDefined();
    expect(xref?.sku).toBe('SP500');
    expect(xref?.source).toBe('learned');
    expect(xref?.timesUsed).toBe(1);

    // 5. Reviewer approves PO #1
    const approveRes = await cReviewer.post(`/api/orders/${order1.id}/approve`);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.ok).toBe(true);

    const afterApprove = (await cReviewer.get(`/api/orders/${order1.id}`)).body;
    expect(['approved', 'pushed', 'push_failed']).toContain(afterApprove.status);
    expect(afterApprove.approvedBy).toBeDefined();

    // 6. Send second PO from the SAME customer with the SAME code 'BC-SOAP-99'
    await send(
      'pdf_po',
      ctx(to, {
        poNumber: 'PO-M6-SECOND',
        lines: [
          {
            code: 'BC-SOAP-99',
            description: 'Hand Soap (Re-order)',
            quantity: 12,
            unitPrice: 3.25,
          },
        ],
      }),
    );

    // 7. Verify PO #2 automatically matched 'SP500' via 'xref_code' with high confidence!
    const allRes = await cReviewer.get('/api/orders?view=all');
    const order2Summary = allRes.body.items.find((o: { poNumber: string }) => o.poNumber === 'PO-M6-SECOND');
    expect(order2Summary).toBeDefined();

    const detail2 = (await cReviewer.get(`/api/orders/${order2Summary.id}`)).body;
    expect(detail2.lines).toHaveLength(1);
    expect(detail2.lines[0].match).toMatchObject({
      sku: 'SP500',
      method: 'xref_code',
    });
    expect(detail2.lines[0].match.confidence).toBeGreaterThanOrEqual(0.9);
    expect(detail2.colour).toBe('green');
    expect(detail2.status).toBe('ready');
  });

  it('P2-3: does not log no-op corrections when before and after are equivalent (null/undefined/"")', async () => {
    const { cReviewer, to } = await setup();
    await send('pdf_po', ctx(to, { poNumber: 'PO-P23-NOOP' }));

    const [item] = (await cReviewer.get('/api/orders?view=needs_review')).body.items;
    const initialDetail = (await cReviewer.get(`/api/orders/${item.id}`)).body;

    // Send no-op edit (null / "" for fields that are null/undefined)
    await cReviewer.patch(`/api/orders/${item.id}`).send({
      notes: '',
      requestedDeliveryDate: null,
      lines: [
        {
          id: initialDetail.lines[0].id,
          unit: '',
        },
      ],
    });

    // Check corrections count
    const correctionsRes = await cReviewer.get(`/api/orders/${item.id}/corrections`);
    expect(correctionsRes.status).toBe(200);
    // Should NOT have logged any no-op corrections for notes, requestedDeliveryDate or unit
    const noopFields = correctionsRes.body.filter((c: { field: string }) =>
      ['notes', 'requestedDeliveryDate', 'unit'].includes(c.field),
    );
    expect(noopFields).toHaveLength(0);
  });

  it('supports hold, reject with reason, and editing header fields', async () => {
    const { cReviewer, to } = await setup();
    await send('pdf_po', ctx(to, { poNumber: 'PO-HOLD-REJECT' }));

    const [item] = (await cReviewer.get('/api/orders?view=needs_review')).body.items;

    // Edit header fields
    const patchRes = await cReviewer.patch(`/api/orders/${item.id}`).send({
      poNumber: 'PO-EDITED-123',
      orderDate: '2026-10-25',
      requestedDeliveryDate: '2026-10-30',
      notes: 'Please leave round the back',
      deliveryAddress: {
        line1: '99 Commercial Road',
        city: 'Manchester',
        postcode: 'M1 1AA',
      },
    });
    expect(patchRes.status).toBe(200);

    const updated = (await cReviewer.get(`/api/orders/${item.id}`)).body;
    expect(updated.poNumber).toBe('PO-EDITED-123');
    expect(updated.orderDate).toBe('2026-10-25');
    expect(updated.requestedDeliveryDate).toBe('2026-10-30');
    expect(updated.notes).toBe('Please leave round the back');
    expect(updated.deliveryAddress.line1).toBe('99 Commercial Road');

    // Put on hold
    const holdRes = await cReviewer.post(`/api/orders/${item.id}/hold`);
    expect(holdRes.status).toBe(200);
    expect((await cReviewer.get(`/api/orders/${item.id}`)).body.status).toBe('on_hold');

    // Reject requires a reason
    const badReject = await cReviewer.post(`/api/orders/${item.id}/reject`).send({});
    expect(badReject.status).toBe(400);

    const goodReject = await cReviewer
      .post(`/api/orders/${item.id}/reject`)
      .send({ reason: 'Duplicate order from buyer' });
    expect(goodReject.status).toBe(200);

    const rejected = (await cReviewer.get(`/api/orders/${item.id}`)).body;
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toBe('Duplicate order from buyer');
  });

  it('P0-6: remembers sender email only when rememberSender === true, never adds domains, and customer unchanged without flag', async () => {
    const { cReviewer, cOwner, to, owner } = await setup();

    // 1. PO from an unknown sender address
    await send(
      'pdf_po',
      ctx(to, {
        senderAddress: 'purchasing@newbranch-brew.example',
        customerName: 'New Branch Cafe',
        poNumber: 'PO-REMEMBER-SENDER-1',
      }),
    );

    const [item1] = (await cReviewer.get('/api/orders?view=needs_review')).body.items;
    const brewCust = await Customer.findOne({ orgId: owner.orgId, accountCode: 'BREW001' });
    expect(brewCust).toBeDefined();

    const origSenderAddresses = [...(brewCust?.senderAddresses ?? [])];
    const origEmailDomains = [...(brewCust?.emailDomains ?? [])];

    // Flow 1: Pick customer and save WITHOUT rememberSender flag -> customer remains completely unchanged
    const patchNoFlag = await cReviewer.patch(`/api/orders/${item1.id}`).send({
      customerId: brewCust!._id.toString(),
      // rememberSender not sent
    });
    expect(patchNoFlag.status).toBe(200);

    const custAfterNoFlag = await Customer.findOne({ orgId: owner.orgId, _id: brewCust!._id });
    expect(custAfterNoFlag?.senderAddresses).toEqual(origSenderAddresses);
    expect(custAfterNoFlag?.emailDomains).toEqual(origEmailDomains);

    // Flow 2: PO from another sender address, pick customer WITH rememberSender: true
    await send(
      'pdf_po',
      ctx(to, {
        senderAddress: 'buyer-2@newbranch-brew.example',
        customerName: 'New Branch Cafe',
        poNumber: 'PO-REMEMBER-SENDER-2',
      }),
    );

    const items = (await cReviewer.get('/api/orders?view=needs_review')).body.items;
    const item2 = items.find((it: { poNumber: string }) => it.poNumber === 'PO-REMEMBER-SENDER-2');
    expect(item2).toBeDefined();

    const patchWithFlag = await cReviewer.patch(`/api/orders/${item2.id}`).send({
      customerId: brewCust!._id.toString(),
      rememberSender: true,
    });
    expect(patchWithFlag.status).toBe(200);

    // Verify: sender address is added, but domain is NEVER added automatically
    const custAfterFlag = await Customer.findOne({ orgId: owner.orgId, _id: brewCust!._id });
    expect(custAfterFlag?.senderAddresses).toContain('buyer-2@newbranch-brew.example');
    expect(custAfterFlag?.emailDomains).toEqual(origEmailDomains);
    expect(custAfterFlag?.emailDomains).not.toContain('newbranch-brew.example');

    // Flow 3: Model and Service layers reject public domains (e.g. gmail.com)
    const patchPublicDomain = await cOwner
      .patch(`/api/customers/${brewCust!._id}`)
      .send({ emailDomains: ['gmail.com', 'yahoo.com'] });
    expect(patchPublicDomain.status).toBe(400);

    // Model validation directly
    const directCust = new Customer({
      orgId: owner.orgId,
      accountCode: 'PUBTEST',
      name: 'Public Domain Test',
      emailDomains: ['gmail.com'],
    });
    let modelErr: unknown = null;
    try {
      await directCust.save();
    } catch (err) {
      modelErr = err;
    }
    expect(modelErr).not.toBeNull();
  });

  it('enforces role permissions: viewers cannot edit or approve orders', async () => {
    const { cViewer, to } = await setup();
    await send('pdf_po', ctx(to, { poNumber: 'PO-ROLES-CHECK' }));

    const [item] = (await cViewer.get('/api/orders?view=all')).body.items;

    // Viewers cannot patch
    const patchRes = await cViewer.patch(`/api/orders/${item.id}`).send({ poNumber: 'HACKED' });
    expect(patchRes.status).toBe(403);

    // Viewers cannot approve
    const approveRes = await cViewer.post(`/api/orders/${item.id}/approve`);
    expect(approveRes.status).toBe(403);

    // Viewers cannot hold or reject
    const holdRes = await cViewer.post(`/api/orders/${item.id}/hold`);
    expect(holdRes.status).toBe(403);
  });
});
