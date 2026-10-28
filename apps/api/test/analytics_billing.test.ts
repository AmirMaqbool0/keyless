import request from 'supertest';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { upsertCustomers, upsertProducts } from '@keyless/core/catalogue/upsert';
import {
  sampleEmail,
  type SampleContext,
  type SampleScenario,
} from '@keyless/core/demo/sampleEmails';
import { Order } from '@keyless/core/models/Order';
import { Organization } from '@keyless/core/models/Organization';
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
        defaultPrice: 5.0,
        stockQty: 100,
      },
      {
        sku: 'SP500',
        description: 'Eco Hand Soap Liquid 500ml Pump',
        uom: 'BOTTLE',
        defaultPrice: 3.5,
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
    ],
    'manual',
  );
}

async function setup() {
  const owner = await t.createUser({ role: 'owner' });
  await seedCatalogue(owner.orgId);
  const admin = await t.createUser({ role: 'admin', orgId: owner.orgId });
  const reviewer = await t.createUser({ role: 'reviewer', orgId: owner.orgId });

  const cOwner = await t.loginAs(owner.email);
  const cAdmin = await t.loginAs(admin.email);
  const cReviewer = await t.loginAs(reviewer.email);

  const mailboxes = await cOwner.get('/api/mailboxes');
  const to: string = mailboxes.body.items.find(
    (m: { type: string }) => m.type === 'forwarding',
  ).address;

  return { owner, admin, reviewer, cOwner, cAdmin, cReviewer, to };
}

const ctx = (to: string, over: Partial<SampleContext> = {}): SampleContext => ({
  customerName: 'Brew Cafe Ltd',
  senderName: 'Sam Buyer',
  senderAddress: 'orders@brewcafe.example',
  to,
  poNumber: 'PO-M9-001',
  deliveryAddress: ['1 High Street', 'Leeds', 'LS1 4AB'],
  lines: [
    { code: 'GL1001', description: 'Nitrile Gloves Blue M', quantity: 10, unitPrice: 5.0 },
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

describe('M9: Analytics & Billing', () => {
  it('calculates analytics summary metrics, touch-free rate, and financial savings', async () => {
    const { cReviewer, to, owner } = await setup();

    // Ingest Order 1: Clean PO (will be approved manually)
    await send('pdf_po', ctx(to, { poNumber: 'PO-M9-ANALYTICS-1' }));
    const order1 = await Order.findOne({ orgId: owner.orgId, poNumber: 'PO-M9-ANALYTICS-1' });
    expect(order1).not.toBeNull();
    // Order 1: auto-approved and pushed without edits (touch-free)
    order1!.status = 'pushed';
    order1!.autoApproved = true;
    order1!.approvedAt = new Date();
    order1!.pushedAt = new Date();
    await order1!.save();

    // Ingest Order 2: PO with an edited line
    await send(
      'pdf_po',
      ctx(to, {
        poNumber: 'PO-M9-ANALYTICS-2',
        lines: [
          { code: 'GL1001', description: 'Nitrile Gloves Blue M', quantity: 2, unitPrice: 5.0 },
          { code: 'SP500', description: 'Eco Hand Soap 500ml', quantity: 4, unitPrice: 3.5 },
        ],
      }),
    );
    const order2 = await Order.findOne({ orgId: owner.orgId, poNumber: 'PO-M9-ANALYTICS-2' });
    expect(order2).not.toBeNull();
    // Simulate user editing a line on order 2 before approving
    order2!.lines[0]!.edited = true;
    order2!.status = 'approved';
    order2!.approvedAt = new Date();
    await order2!.save();

    // Query analytics summary
    const summaryRes = await cReviewer.get('/api/analytics/summary');
    expect(summaryRes.status).toBe(200);
    const summary = summaryRes.body;

    expect(summary.totalOrders).toBe(2);
    expect(summary.approvedOrders).toBe(2);
    // Order 1 was touch-free (no line edits, auto-approved, pushed), Order 2 had edited line
    expect(summary.touchFreeRate).toBe(50);
    expect(summary.totalValue).toBeGreaterThan(0);
    expect(summary.linesCorrectedPct).toBeGreaterThan(0);
    expect(summary.estimatedHoursSaved).toBeGreaterThan(0);
    expect(summary.estimatedCostSaved).toBeGreaterThan(0);
    expect(summary.ordersByDay.length).toBeGreaterThanOrEqual(1);
    expect(summary.topCustomers.length).toBeGreaterThanOrEqual(1);
    expect(summary.topCustomers[0]?.name).toContain('Brew Cafe');
  });

  it('P1-5: computes accurate metrics, distinct medians, match rate, and human-labeled review reasons', async () => {
    const { cReviewer, to, owner } = await setup();

    // Ingest Order A: clean, pushed touch-free
    await send('pdf_po', ctx(to, { poNumber: 'PO-P15-A' }));
    const orderA = await Order.findOne({ orgId: owner.orgId, poNumber: 'PO-P15-A' });
    orderA!.status = 'pushed';
    orderA!.autoApproved = true;
    const t0 = new Date(Date.now() - 600000); // 10m ago
    orderA!.receivedAt = t0;
    orderA!.approvedAt = new Date(t0.getTime() + 120000); // 2 min to approve
    orderA!.pushedAt = new Date(t0.getTime() + 240000); // 4 min to push
    await orderA!.save();

    // Ingest Order B: had an issue with code 'below_minimum_order'
    await send('pdf_po', ctx(to, { poNumber: 'PO-P15-B' }));
    const orderB = await Order.findOne({ orgId: owner.orgId, poNumber: 'PO-P15-B' });
    orderB!.issues = [
      {
        _id: new Types.ObjectId(),
        code: 'below_minimum_order',
        severity: 'warning',
        blocking: false,
        resolved: false,
        message: 'Order total is below minimum £50',
      },
    ];
    orderB!.status = 'on_hold';
    await orderB!.save();

    const summaryRes = await cReviewer.get('/api/analytics/summary');
    expect(summaryRes.status).toBe(200);
    const summary = summaryRes.body;

    // Medians: separate approve and push
    expect(summary.medianMinutesToApprove).toBe(2);
    expect(summary.medianMinutesToPush).toBe(4);

    // Match rate and touch-free rate exist and are reasonable numbers
    expect(typeof summary.matchRate).toBe('number');
    expect(summary.matchRate).toBeGreaterThanOrEqual(0);
    expect(summary.touchFreeRate).toBe(50); // 1 out of 2 is touch-free

    // Issues reasons grouped by code with human readable labels
    const minOrderReason = summary.topIssues.find(
      (r: { code: string; label: string; count: number }) => r.code === 'below_minimum_order',
    );
    expect(minOrderReason).toBeDefined();
    expect(minOrderReason.label).toBe('Below minimum order');
    expect(minOrderReason.count).toBe(1);
  });

  it('generates an executive value report with ROI multiple and automated insights', async () => {
    const { cReviewer, to, owner } = await setup();

    await send('pdf_po', ctx(to, { poNumber: 'PO-M9-ROI-1' }));
    const order = await Order.findOne({ orgId: owner.orgId, poNumber: 'PO-M9-ROI-1' });
    expect(order).not.toBeNull();
    await cReviewer.post(`/api/orders/${order!._id}/approve`);

    const reportRes = await cReviewer.get('/api/analytics/value-report?days=30');
    expect(reportRes.status).toBe(200);
    const report = reportRes.body;

    expect(report.periodLabel).toBe('Last 30 Days');
    expect(report.totalOrders).toBe(1);
    expect(report.touchFreeRate).toBeGreaterThanOrEqual(0);
    expect(report.roiMultiple).toBeGreaterThanOrEqual(0);
    expect(report.keyInsights.length).toBeGreaterThan(0);
  });

  it('enforces RBAC for analytics settings updates', async () => {
    const { cReviewer, cAdmin } = await setup();

    // Reviewer cannot change calculation assumptions
    const forbiddenRes = await cReviewer.patch('/api/analytics/settings', {
      minutesSavedPerOrder: 15,
      hourlyStaffCost: 22,
    });
    expect(forbiddenRes.status).toBe(403);

    // Admin can update settings
    const successRes = await cAdmin.patch('/api/analytics/settings', {
      minutesSavedPerOrder: 15,
      hourlyStaffCost: 22,
    });
    expect(successRes.status).toBe(200);
    expect(successRes.body.settings.minutesSavedPerOrder).toBe(15);
    expect(successRes.body.settings.hourlyStaffCost).toBe(22);

    // Check summary reflects updated settings
    const summaryRes = await cAdmin.get('/api/analytics/summary');
    expect(summaryRes.body.settings.minutesSavedPerOrder).toBe(15);
    expect(summaryRes.body.settings.hourlyStaffCost).toBe(22);
  });

  it('meters monthly order usage and reports approaching (80%) and exceeded (100%) limit flags', async () => {
    const { cOwner, to, owner } = await setup();

    // Initial state: Free Trial (100 orders limit)
    const initialRes = await cOwner.get('/api/billing');
    expect(initialRes.status).toBe(200);
    expect(initialRes.body.plan).toBe('trial');
    expect(initialRes.body.ordersLimit).toBe(100);
    expect(initialRes.body.ordersUsed).toBe(0);
    expect(initialRes.body.approachingLimit).toBe(false);
    expect(initialRes.body.exceededLimit).toBe(false);

    // Ingest 1 order
    await send('pdf_po', ctx(to, { poNumber: 'PO-M9-LIMIT-1' }));

    const after1Res = await cOwner.get('/api/billing');
    expect(after1Res.body.ordersUsed).toBe(1);
    expect(after1Res.body.usagePct).toBe(1);
    expect(after1Res.body.approachingLimit).toBe(false);
    expect(after1Res.body.exceededLimit).toBe(false);

    // Set trial order count threshold test by temporarily setting plan limit to 2
    await Organization.updateOne({ _id: owner.orgId }, { plan: 'starter' }); // starter = 600
    // Test custom small order count: create orders directly in DB to test 80% threshold
    const emailId = new Types.ObjectId();
    const ordersBatch = Array.from({ length: 480 }).map((_, i) => ({
      orgId: owner.orgId,
      emailId,
      sourceLabel: 'test',
      receivedAt: new Date(),
      status: 'pushed',
      colour: 'green',
      confidence: 1,
      poNumber: `PO-BATCH-${i}`,
      currency: 'GBP',
      lines: [],
      issues: [],
    }));
    await Order.insertMany(ordersBatch);

    const thresholdRes = await cOwner.get('/api/billing');
    expect(thresholdRes.body.ordersUsed).toBe(481); // 480 + 1 = 481 / 600 = 80.2%
    expect(thresholdRes.body.approachingLimit).toBe(true);
    expect(thresholdRes.body.exceededLimit).toBe(false);

    // Insert more orders to exceed limit
    const exceedBatch = Array.from({ length: 130 }).map((_, i) => ({
      orgId: owner.orgId,
      emailId,
      sourceLabel: 'test',
      receivedAt: new Date(),
      status: 'pushed',
      colour: 'green',
      confidence: 1,
      poNumber: `PO-EXCEED-${i}`,
      currency: 'GBP',
      lines: [],
      issues: [],
    }));
    await Order.insertMany(exceedBatch);

    const exceededRes = await cOwner.get('/api/billing');
    expect(exceededRes.body.ordersUsed).toBeGreaterThanOrEqual(600);
    expect(exceededRes.body.exceededLimit).toBe(true);
  });

  it('manages Stripe Checkout & Customer Portal with Owner role enforcement', async () => {
    const { cReviewer, cAdmin, cOwner } = await setup();

    // Reviewer and Admin cannot access checkout/portal (Owner only)
    const reviewerCheckout = await cReviewer.post('/api/billing/checkout', { plan: 'growth' });
    expect(reviewerCheckout.status).toBe(403);

    const adminCheckout = await cAdmin.post('/api/billing/checkout', { plan: 'growth' });
    expect(adminCheckout.status).toBe(403);

    // Owner creates checkout session
    const ownerCheckout = await cOwner.post('/api/billing/checkout', { plan: 'growth' });
    expect(ownerCheckout.status).toBe(200);
    expect(ownerCheckout.body.url).toBeDefined();
    expect(ownerCheckout.body.sessionId).toContain('cs_test_');

    // Owner creates customer portal session
    const portalRes = await cOwner.post('/api/billing/portal', {});
    expect(portalRes.status).toBe(200);
    expect(portalRes.body.url).toBeDefined();
  });

  it('processes Stripe webhooks to upgrade, update, and cancel subscriptions', async () => {
    const { owner } = await setup();

    // 1. Webhook: checkout.session.completed
    const checkoutWebhookRes = await request(t.app)
      .post('/webhooks/stripe')
      .send({
        id: 'evt_test_checkout',
        type: 'checkout.session.completed',
        data: {
          object: {
            client_reference_id: owner.orgId.toString(),
            customer: 'cus_test_123',
            subscription: 'sub_test_456',
            metadata: {
              plan: 'pro',
            },
          },
        },
      });
    expect(checkoutWebhookRes.status).toBe(200);
    expect(checkoutWebhookRes.body.handled).toBe(true);

    const orgAfterCheckout = await Organization.findById(owner.orgId);
    expect(orgAfterCheckout?.plan).toBe('pro');
    expect(orgAfterCheckout?.subscriptionStatus).toBe('active');
    expect(orgAfterCheckout?.stripeCustomerId).toBe('cus_test_123');
    expect(orgAfterCheckout?.stripeSubscriptionId).toBe('sub_test_456');

    // 2. Webhook: customer.subscription.updated (e.g. past_due or scheduled cancellation)
    const updateWebhookRes = await request(t.app)
      .post('/webhooks/stripe')
      .send({
        id: 'evt_test_update',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_test_456',
            customer: 'cus_test_123',
            status: 'past_due',
            cancel_at_period_end: true,
          },
        },
      });
    expect(updateWebhookRes.status).toBe(200);
    expect(updateWebhookRes.body.handled).toBe(true);

    const orgAfterUpdate = await Organization.findById(owner.orgId);
    expect(orgAfterUpdate?.subscriptionStatus).toBe('past_due');
    expect(orgAfterUpdate?.cancelAtPeriodEnd).toBe(true);

    // 3. Webhook: customer.subscription.deleted
    const deleteWebhookRes = await request(t.app)
      .post('/webhooks/stripe')
      .send({
        id: 'evt_test_delete',
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_test_456',
            customer: 'cus_test_123',
          },
        },
      });
    expect(deleteWebhookRes.status).toBe(200);
    expect(deleteWebhookRes.body.handled).toBe(true);

    const orgAfterDelete = await Organization.findById(owner.orgId);
    expect(orgAfterDelete?.plan).toBe('trial');
    expect(orgAfterDelete?.subscriptionStatus).toBe('canceled');
  });
});
