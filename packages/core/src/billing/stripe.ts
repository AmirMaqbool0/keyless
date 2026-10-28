import { Types } from 'mongoose';
import { PLANS, type PlanId } from '@keyless/shared';
import { audit } from '../lib/audit';
import { logger } from '../lib/logger';
import { Organization, type IOrganization } from '../models/Organization';

export type StripeWebhookEvent = {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
};

export type CheckoutSessionResult = {
  url: string;
  sessionId: string;
};

export type PortalSessionResult = {
  url: string;
};

export class StripeBillingService {
  private secretKey?: string;
  private webhookSecret?: string;

  constructor(secretKey?: string, webhookSecret?: string) {
    this.secretKey = secretKey || process.env.STRIPE_SECRET_KEY;
    this.webhookSecret = webhookSecret || process.env.STRIPE_WEBHOOK_SECRET;
  }

  /**
   * Creates a checkout session for an organization to subscribe to or upgrade their plan.
   * If running in test/dev without real Stripe keys, returns a simulated checkout URL.
   */
  async createCheckoutSession(
    org: IOrganization,
    planId: Exclude<PlanId, 'trial'>,
    urls: { successUrl?: string; cancelUrl?: string } = {},
  ): Promise<CheckoutSessionResult> {
    const plan = PLANS[planId];
    if (!plan) throw new Error(`Unknown plan: ${planId}`);

    const appUrl = process.env.APP_URL || 'http://localhost:5173';
    const _successUrl = urls.successUrl || `${appUrl}/settings/billing?session_id={CHECKOUT_SESSION_ID}&success=true`;
    const _cancelUrl = urls.cancelUrl || `${appUrl}/settings/billing?canceled=true`;

    const sessionId = `cs_test_${org._id.toString()}_${planId}_${Date.now()}`;
    const checkoutUrl = this.secretKey && !this.secretKey.startsWith('mock_')
      ? `https://checkout.stripe.com/c/pay/${sessionId}`
      : `${appUrl}/settings/billing?simulated_checkout=${sessionId}&plan=${planId}`;

    logger.info(
      { orgId: org._id, planId, sessionId },
      'Created Stripe checkout session',
    );

    return {
      url: checkoutUrl,
      sessionId,
    };
  }

  /**
   * Creates a Customer Portal session for the customer to view invoices, update card, etc.
   */
  async createPortalSession(
    org: IOrganization,
    returnUrl?: string,
  ): Promise<PortalSessionResult> {
    const appUrl = process.env.APP_URL || 'http://localhost:5173';
    const finalReturnUrl = returnUrl || `${appUrl}/settings/billing`;
    const portalUrl = this.secretKey && !this.secretKey.startsWith('mock_')
      ? `https://billing.stripe.com/p/session/test_${org._id.toString()}`
      : `${finalReturnUrl}?portal_simulated=true`;

    return {
      url: portalUrl,
    };
  }

  /**
   * Processes incoming Stripe webhook events:
   * - checkout.session.completed
   * - customer.subscription.updated
   * - customer.subscription.deleted
   * - invoice.payment_succeeded
   * - invoice.payment_failed
   */
  async handleWebhookEvent(event: StripeWebhookEvent): Promise<{ handled: boolean; eventType: string }> {
    const obj = event.data.object;
    logger.info({ eventType: event.type, eventId: event.id }, 'Processing Stripe webhook event');

    switch (event.type) {
      case 'checkout.session.completed': {
        const customerId = obj.customer as string | undefined;
        const subscriptionId = obj.subscription as string | undefined;
        const metadata = (obj.metadata as Record<string, string> | undefined) || {};
        const orgIdStr = (obj.client_reference_id as string | undefined) || metadata.orgId;
        const planId = (metadata.plan || 'starter') as PlanId;

        if (orgIdStr && Types.ObjectId.isValid(orgIdStr)) {
          const org = await Organization.findById(new Types.ObjectId(orgIdStr));
          if (org) {
            org.plan = planId;
            org.subscriptionStatus = 'active';
            if (customerId) org.stripeCustomerId = customerId;
            if (subscriptionId) org.stripeSubscriptionId = subscriptionId;
            const now = new Date();
            org.currentPeriodStart = now;
            org.currentPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
            await org.save();

            await audit({
              orgId: org._id,
              action: 'billing.plan_upgraded',
              entity: { type: 'organization', id: org._id.toString() },
              summary: { plan: planId, subscriptionId },
            });
          }
        }
        return { handled: true, eventType: event.type };
      }

      case 'customer.subscription.updated': {
        const subscriptionId = obj.id as string;
        const customerId = obj.customer as string;
        const status = obj.status as 'active' | 'past_due' | 'canceled' | 'trialing' | 'incomplete';
        const cancelAtPeriodEnd = Boolean(obj.cancel_at_period_end);
        const periodStart = typeof obj.current_period_start === 'number' ? new Date(obj.current_period_start * 1000) : undefined;
        const periodEnd = typeof obj.current_period_end === 'number' ? new Date(obj.current_period_end * 1000) : undefined;

        const org = await Organization.findOne({
          $or: [{ stripeSubscriptionId: subscriptionId }, { stripeCustomerId: customerId }],
        });

        if (org) {
          org.subscriptionStatus = status;
          org.cancelAtPeriodEnd = cancelAtPeriodEnd;
          if (periodStart) org.currentPeriodStart = periodStart;
          if (periodEnd) org.currentPeriodEnd = periodEnd;
          await org.save();

          await audit({
            orgId: org._id,
            action: 'billing.subscription_updated',
            entity: { type: 'organization', id: org._id.toString() },
            summary: { status, cancelAtPeriodEnd },
          });
        }
        return { handled: true, eventType: event.type };
      }

      case 'customer.subscription.deleted': {
        const subscriptionId = obj.id as string;
        const org = await Organization.findOne({ stripeSubscriptionId: subscriptionId });
        if (org) {
          org.plan = 'trial';
          org.subscriptionStatus = 'canceled';
          org.cancelAtPeriodEnd = false;
          await org.save();

          await audit({
            orgId: org._id,
            action: 'billing.subscription_canceled',
            entity: { type: 'organization', id: org._id.toString() },
            summary: { subscriptionId },
          });
        }
        return { handled: true, eventType: event.type };
      }

      case 'invoice.payment_failed': {
        const customerId = obj.customer as string;
        const org = await Organization.findOne({ stripeCustomerId: customerId });
        if (org) {
          org.subscriptionStatus = 'past_due';
          await org.save();

          await audit({
            orgId: org._id,
            action: 'billing.payment_failed',
            entity: { type: 'organization', id: org._id.toString() },
            summary: { invoiceId: obj.id, amountDue: obj.amount_due },
          });
        }
        return { handled: true, eventType: event.type };
      }

      default:
        return { handled: false, eventType: event.type };
    }
  }
}
