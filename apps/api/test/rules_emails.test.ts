import request from 'supertest';
import type { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { upsertCustomers, upsertProducts } from '@keyless/core/catalogue/upsert';
import {
  sampleEmail,
  type SampleContext,
  type SampleScenario,
} from '@keyless/core/demo/sampleEmails';
import { Customer } from '@keyless/core/models/Customer';
import { MockErpOrder } from '@keyless/core/models/MockErpOrder';
import { Order } from '@keyless/core/models/Order';
import { OutboundEmail } from '@keyless/core/models/OutboundEmail';
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
        trustedForAutoApprove: true,
      },
      {
        accountCode: 'RISK001',
        name: 'Risk Corp',
        emailDomains: ['risk.example'],
        senderAddresses: ['po@risk.example'],
        deliveryAddresses: [{ line1: '99 Danger Way', city: 'Manchester', postcode: 'M1 1AA' }],
        trustedForAutoApprove: false,
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
  customerName: 'Brew Cafe Ltd',
  senderName: 'Sam Buyer',
  senderAddress: 'orders@brewcafe.example',
  to,
  poNumber: 'PO-M8-001',
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

describe('M8: Rules engine & Outbound emails', () => {
  it('rule CRUD API: admins can create, view, update, delete rules, reviewers forbidden', async () => {
    const { cOwner, cReviewer } = await setup();

    // Reviewer cannot create rules (requires admin/owner)
    const forbiddenRes = await cReviewer.post('/api/rules', {
      name: 'Reviewer rule',
      type: 'auto_approve',
      priority: 10,
      active: true,
      conditions: {},
      actions: { action: 'auto_approve' },
    });
    expect(forbiddenRes.status).toBe(403);

    // Owner creates an auto-approve rule
    const createRes = await cOwner.post('/api/rules', {
      name: 'Auto-approve low value',
      type: 'auto_approve',
      priority: 5,
      active: true,
      conditions: {
        maxOrderValue: 200,
        requireTrustedCustomer: true,
        requireNoIssues: true,
        requireAllLinesLearned: true,
      },
      actions: { action: 'auto_approve' },
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.rule.name).toBe('Auto-approve low value');
    expect(createRes.body.rule.conditions.maxOrderValue).toBe(200);
    const ruleId = createRes.body.rule.id;

    // List rules
    const listRes = await cOwner.get('/api/rules');
    expect(listRes.status).toBe(200);
    expect(listRes.body.items).toHaveLength(1);
    expect(listRes.body.items[0].id).toBe(ruleId);

    // Update rule (toggle active and bump priority)
    const updateRes = await cOwner.patch(`/api/rules/${ruleId}`, {
      priority: 15,
      active: false,
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.rule.priority).toBe(15);
    expect(updateRes.body.rule.active).toBe(false);

    // Delete rule
    const delRes = await cOwner.delete(`/api/rules/${ruleId}`);
    expect(delRes.status).toBe(204);

    const emptyList = await cOwner.get('/api/rules');
    expect(emptyList.body.items).toHaveLength(0);
  });

  it('auto-approves matching clean PO under value limit and automatically pushes to ERP', async () => {
    const { cOwner, to, owner } = await setup();

    // 1. Setup Mock ERP connector
    await cOwner.post('/api/connectors', {
      type: 'mock',
      name: 'Demo ERP',
      settings: { productCount: 20 },
    });

    // 2. Create auto-approve rule
    const ruleRes = await cOwner.post('/api/rules', {
      name: 'Auto-approve clean small orders',
      type: 'auto_approve',
      priority: 10,
      active: true,
      conditions: {
        maxOrderValue: 100,
        requireTrustedCustomer: true,
        requireNoIssues: true,
        requireAllLinesLearned: true,
      },
      actions: { action: 'auto_approve' },
    });
    expect(ruleRes.status).toBe(201);

    // 3. Ingest clean PO: 10 units @ 4.5 = £45 (< £100) from trusted customer Brew Cafe
    await send('pdf_po', ctx(to, { poNumber: 'PO-M8-AUTO-1' }));

    // 4. Verify order was auto-approved and pushed to ERP
    const orderDoc = await Order.findOne({ orgId: owner.orgId, poNumber: 'PO-M8-AUTO-1' });
    expect(orderDoc).not.toBeNull();
    expect(orderDoc?.autoApproved).toBe(true);
    expect(orderDoc?.autoApprovedRuleName).toBe('Auto-approve clean small orders');
    expect(orderDoc?.status).toBe('pushed');
    expect(orderDoc?.erpReference).toMatch(/^SO-/);

    // 5. Verify MockErpOrder was created
    const erpOrder = await MockErpOrder.findOne({
      orgId: owner.orgId,
      erpReference: orderDoc?.erpReference,
    });
    expect(erpOrder).not.toBeNull();
    expect(erpOrder?.poNumber).toBe('PO-M8-AUTO-1');
  });

  it('does NOT auto-approve if order value exceeds rule maxOrderValue limit', async () => {
    const { cOwner, to, owner } = await setup();

    // Rule has maxOrderValue: 50
    await cOwner.post('/api/rules', {
      name: 'Small orders only',
      type: 'auto_approve',
      priority: 10,
      active: true,
      conditions: {
        maxOrderValue: 50,
        requireTrustedCustomer: true,
      },
      actions: { action: 'auto_approve' },
    });

    // Ingest PO with value: 20 units @ 4.5 = £90 (> £50)
    await send(
      'pdf_po',
      ctx(to, {
        poNumber: 'PO-M8-HIGH-VAL',
        lines: [
          { code: 'GL1001', description: 'Nitrile Gloves Blue M', quantity: 20, unitPrice: 4.5 },
        ],
      }),
    );

    const orderDoc = await Order.findOne({ orgId: owner.orgId, poNumber: 'PO-M8-HIGH-VAL' });
    expect(orderDoc).not.toBeNull();
    expect(orderDoc?.autoApproved).toBe(false);
    expect(orderDoc?.status).toBe('ready'); // Ready for manual review, not auto-approved
  });

  it('blocks order if block rule matches, placing order on_hold with blocking issue', async () => {
    const { cOwner, to, owner } = await setup();

    const riskCustomer = await Customer.findOne({ orgId: owner.orgId, accountCode: 'RISK001' });
    expect(riskCustomer).not.toBeNull();

    // Create block rule for RISK001
    await cOwner.post('/api/rules', {
      name: 'Block Risk Corp Orders',
      type: 'block',
      priority: 50,
      active: true,
      conditions: {
        customerId: riskCustomer!._id.toString(),
      },
      actions: {
        action: 'block',
        reason: 'Risk Corp orders require manager authorization',
      },
    });

    // Ingest PO from Risk Corp
    await send(
      'pdf_po',
      ctx(to, {
        customerName: 'Risk Corp',
        senderName: 'Rick Risk',
        senderAddress: 'po@risk.example',
        poNumber: 'PO-M8-BLOCKED-1',
      }),
    );

    const orderDoc = await Order.findOne({ orgId: owner.orgId, poNumber: 'PO-M8-BLOCKED-1' });
    expect(orderDoc).not.toBeNull();
    expect(orderDoc?.status).toBe('on_hold');
    const blockIssue = orderDoc?.issues.find((i) => i.code === 'rule_blocked');
    expect(blockIssue).toBeDefined();
    expect(blockIssue?.blocking).toBe(true);
    expect(blockIssue?.message).toContain('Risk Corp orders require manager authorization');
  });

  it('generates, updates, and sends clarification and acknowledgment email drafts', async () => {
    const { cReviewer, to, owner } = await setup();

    // 1. Ingest an order that has an issue (e.g. unknown product description)
    await send(
      'pdf_po',
      ctx(to, {
        poNumber: 'PO-M8-EMAIL-1',
        lines: [
          { code: 'UNKNOWN_999', description: 'Mysterious Custom Part', quantity: 5, unitPrice: 12 },
        ],
      }),
    );

    const orderDoc = await Order.findOne({ orgId: owner.orgId, poNumber: 'PO-M8-EMAIL-1' });
    expect(orderDoc).not.toBeNull();
    const orderId = orderDoc!._id.toString();

    // 2. Draft clarification email
    const draftRes = await cReviewer.post(`/api/orders/${orderId}/emails/draft`, {
      type: 'clarification',
    });
    expect(draftRes.status).toBe(201);
    expect(draftRes.body.email.type).toBe('clarification');
    expect(draftRes.body.email.status).toBe('draft');
    expect(draftRes.body.email.to).toBe('orders@brewcafe.example');
    expect(draftRes.body.email.subject).toContain('PO-M8-EMAIL-1');
    expect(draftRes.body.email.body).toContain('clarification');
    const draftId = draftRes.body.email.id;

    // 3. Edit draft subject and body
    const updateRes = await cReviewer.patch(`/api/orders/${orderId}/emails/${draftId}`, {
      to: 'buyer@brewcafe.example',
      subject: 'Urgent: Clarification needed for PO-M8-EMAIL-1',
      body: 'Hi Sam,\nPlease confirm whether UNKNOWN_999 is equivalent to GL1001.\nThanks!',
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.email.to).toBe('buyer@brewcafe.example');
    expect(updateRes.body.email.subject).toBe('Urgent: Clarification needed for PO-M8-EMAIL-1');

    // 4. Send email draft
    const sendRes = await cReviewer.post(`/api/orders/${orderId}/emails/${draftId}/send`);
    expect(sendRes.status).toBe(200);
    expect(sendRes.body.ok).toBe(true);
    expect(sendRes.body.email.status).toBe('sent');
    expect(sendRes.body.email.sentAt).not.toBeNull();

    // Verify OutboundEmail in DB
    const emailDoc = await OutboundEmail.findOne({ _id: draftId, orgId: owner.orgId });
    expect(emailDoc?.status).toBe('sent');
    expect(emailDoc?.sentAt).toBeInstanceOf(Date);

    // Verify ConsoleMailer outbox captured the sent message
    expect(t.mailer.outbox).toHaveLength(1);
    expect(t.mailer.outbox[0]?.to).toBe('buyer@brewcafe.example');
    expect(t.mailer.outbox[0]?.subject).toBe('Urgent: Clarification needed for PO-M8-EMAIL-1');
    expect(t.mailer.outbox[0]?.text).toContain('Please confirm whether UNKNOWN_999');

    // 5. Draft acknowledgment email
    const ackRes = await cReviewer.post(`/api/orders/${orderId}/emails/draft`, {
      type: 'acknowledgment',
    });
    expect(ackRes.status).toBe(201);
    expect(ackRes.body.email.type).toBe('acknowledgment');
    expect(ackRes.body.email.body).toContain('accepted');

    // Send acknowledgment email
    const sendAckRes = await cReviewer.post(`/api/orders/${orderId}/emails/${ackRes.body.email.id}/send`);
    expect(sendAckRes.status).toBe(200);
    expect(t.mailer.outbox).toHaveLength(2);
    // ConsoleMailer unshifts, so outbox[0] is the latest sent mail
    expect(t.mailer.outbox[0]?.subject).toContain('Order Confirmation - PO PO-M8-EMAIL-1');
    expect(t.mailer.outbox[1]?.subject).toContain('Urgent: Clarification needed');
  });
});
