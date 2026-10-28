import { Router } from 'express';
import {
  PLANS,
  createCheckoutSessionSchema,
  createPortalSessionSchema,
  type SubscriptionDto,
} from '@keyless/shared';
import { audit } from '@keyless/core/lib/audit';
import { badRequest, validate } from '@keyless/core/lib/http';
import { StripeBillingService, type StripeWebhookEvent } from '@keyless/core/billing/stripe';
import { Order } from '@keyless/core/models/Order';
import { Organization } from '@keyless/core/models/Organization';
import { authed, requireRole } from '../../middleware/auth';

export function billingRouter(stripeService: StripeBillingService = new StripeBillingService()): Router {
  const r = Router();

  /** Get current subscription, usage, and plan details */
  r.get('/', async (req, res) => {
    const { orgId } = authed(req);
    const org = await Organization.findById(orgId);
    if (!org) throw badRequest('Organization not found');

    const plan = PLANS[org.plan] || PLANS.trial;
    const now = new Date();
    const periodStart = org.currentPeriodStart || new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = org.currentPeriodEnd || new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const ordersUsed = await Order.countDocuments({
      orgId,
      receivedAt: { $gte: periodStart },
    });

    const ordersLimit = plan.orderLimit;
    const usagePct = ordersLimit > 0 ? Number(((ordersUsed / ordersLimit) * 100).toFixed(1)) : 0;
    const approachingLimit = usagePct >= 80;
    const exceededLimit = ordersUsed >= ordersLimit;

    const dto: SubscriptionDto = {
      plan: org.plan,
      planName: plan.name,
      priceMonthly: plan.priceMonthly,
      currency: org.currency || 'GBP',
      status: org.subscriptionStatus || 'trialing',
      ordersUsed,
      ordersLimit,
      usagePct,
      approachingLimit,
      exceededLimit,
      currentPeriodStart: periodStart.toISOString(),
      currentPeriodEnd: periodEnd.toISOString(),
      cancelAtPeriodEnd: Boolean(org.cancelAtPeriodEnd),
      stripeCustomerId: org.stripeCustomerId || null,
      stripeSubscriptionId: org.stripeSubscriptionId || null,
      hasPaymentMethod: Boolean(org.stripeCustomerId),
    };

    res.json(dto);
  });

  /** Create Stripe Checkout session for upgrading or changing plan (Owner only) */
  r.post('/checkout', requireRole('owner'), async (req, res) => {
    const { orgId } = authed(req);
    const org = await Organization.findById(orgId);
    if (!org) throw badRequest('Organization not found');

    const input = validate(createCheckoutSessionSchema, req.body);
    const result = await stripeService.createCheckoutSession(org, input.plan, {
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    });

    await audit({
      orgId,
      action: 'billing.checkout_created',
      entity: { type: 'organization', id: orgId.toString() },
      summary: { plan: input.plan, sessionId: result.sessionId },
      req,
    });

    res.json(result);
  });

  /** Create Customer Portal session for invoices and payment details (Owner only) */
  r.post('/portal', requireRole('owner'), async (req, res) => {
    const { orgId } = authed(req);
    const org = await Organization.findById(orgId);
    if (!org) throw badRequest('Organization not found');

    const input = validate(createPortalSessionSchema, req.body);
    const result = await stripeService.createPortalSession(org, input.returnUrl);

    res.json(result);
  });

  /** Stripe webhook endpoint (public with signature/body verification) */
  r.post('/webhook', async (req, res) => {
    const event = req.body as StripeWebhookEvent;
    if (!event || !event.type) {
      throw badRequest('Invalid webhook payload', 'INVALID_PAYLOAD');
    }

    const result = await stripeService.handleWebhookEvent(event);
    res.json({ received: true, handled: result.handled, eventType: result.eventType });
  });

  return r;
}
