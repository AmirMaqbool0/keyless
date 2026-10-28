import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { toast } from 'sonner';
import { PLANS, type PlanId, type SubscriptionDto } from '@keyless/shared';
import { Badge, Button, Card, PageHeader, Spinner } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useHasRole } from '../../lib/session';

export function BillingPage() {
  const isOwner = useHasRole('owner');

  const subscription = useQuery({
    queryKey: ['billing-subscription'],
    queryFn: () => api.get<SubscriptionDto>('/api/billing'),
  });

  const checkoutMutation = useMutation({
    mutationFn: (plan: Exclude<PlanId, 'trial'>) =>
      api.post<{ url: string; sessionId: string }>('/api/billing/checkout', { plan }),
    onSuccess: (res) => {
      toast.success('Redirecting to Stripe checkout...');
      window.location.href = res.url;
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const portalMutation = useMutation({
    mutationFn: () => api.post<{ url: string }>('/api/billing/portal', {}),
    onSuccess: (res) => {
      toast.success('Redirecting to Stripe customer portal...');
      window.location.href = res.url;
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const sub = subscription.data;

  return (
    <>
      <PageHeader
        title="Billing &amp; Subscription Plans"
        description="Manage your Keyless subscription tier, monthly order usage limits, payment methods, and invoices."
        actions={
          isOwner && sub?.hasPaymentMethod ? (
            <Button
              variant="secondary"
              loading={portalMutation.isPending}
              onClick={() => portalMutation.mutate()}
            >
              Stripe Customer Portal ↗
            </Button>
          ) : undefined
        }
      />

      {subscription.isPending ? (
        <div className="py-12 flex justify-center">
          <Spinner className="size-8 text-brand-600" />
        </div>
      ) : !sub ? (
        <Card>
          <div className="py-12 text-center text-slate-500">Failed to load subscription details.</div>
        </Card>
      ) : (
        <div className="space-y-8">
          {/* Usage Alert Banners */}
          {sub.exceededLimit && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 flex items-center justify-between">
              <div>
                <span className="font-bold">Plan Order Limit Exceeded:</span> You have processed {sub.ordersUsed} of your {sub.ordersLimit} monthly order limit ({sub.usagePct}%).
                Please upgrade your plan below to ensure continuous automated processing.
              </div>
            </div>
          )}

          {sub.approachingLimit && !sub.exceededLimit && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 flex items-center justify-between">
              <div>
                <span className="font-bold">Approaching Plan Limit:</span> You have utilized {sub.usagePct}% of your monthly order quota ({sub.ordersUsed} / {sub.ordersLimit} orders).
              </div>
            </div>
          )}

          {/* Current Subscription & Usage Card */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-5">
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="text-lg font-bold text-slate-900">{sub.planName} Plan</h2>
                  <Badge tone={sub.status === 'active' ? 'green' : sub.status === 'trialing' ? 'brand' : 'amber'}>
                    {sub.status.toUpperCase()}
                  </Badge>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Billing cycle: {new Date(sub.currentPeriodStart).toLocaleDateString()} &mdash; {new Date(sub.currentPeriodEnd).toLocaleDateString()}
                </p>
              </div>

              <div className="text-right">
                <span className="text-2xl font-black text-slate-900">
                  {sub.priceMonthly > 0 ? `£${sub.priceMonthly}` : 'Free'}
                </span>
                {sub.priceMonthly > 0 && <span className="text-xs text-slate-500"> / month</span>}
              </div>
            </div>

            {/* Usage Progress Bar */}
            <div className="mt-5 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-700">Monthly Orders Quota</span>
                <span className="font-mono font-semibold text-slate-800">
                  {sub.ordersUsed} / {sub.ordersLimit} orders ({sub.usagePct}%)
                </span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden">
                <div
                  className={clsx(
                    'h-3 rounded-full transition-all duration-500',
                    sub.exceededLimit
                      ? 'bg-red-500'
                      : sub.approachingLimit
                        ? 'bg-amber-500'
                        : 'bg-emerald-500',
                  )}
                  style={{ width: `${Math.min(100, sub.usagePct)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>0 orders</span>
                <span>{sub.ordersLimit - sub.ordersUsed > 0 ? `${sub.ordersLimit - sub.ordersUsed} orders remaining` : 'Limit reached'}</span>
                <span>{sub.ordersLimit} max</span>
              </div>
            </div>
          </div>

          {/* Pricing Tier Plans Grid */}
          <div>
            <div className="mb-4">
              <h3 className="text-base font-bold text-slate-900">Available Plans</h3>
              <p className="text-xs text-slate-500">Choose the capacity that fits your sales order volume.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {(['starter', 'growth', 'pro'] as const).map((planKey) => {
                const plan = PLANS[planKey];
                const isCurrent = sub.plan === planKey;

                return (
                  <div
                    key={planKey}
                    className={clsx(
                      'rounded-xl border p-6 flex flex-col justify-between transition-all',
                      isCurrent
                        ? 'border-brand-500 ring-2 ring-brand-500/20 bg-brand-50/20 shadow-md'
                        : 'border-slate-200 bg-white hover:border-slate-300 shadow-xs',
                    )}
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <h4 className="text-base font-bold text-slate-900">{plan.name}</h4>
                        {isCurrent && <Badge tone="green">Current Plan</Badge>}
                      </div>
                      <p className="mt-1 text-xs text-slate-500 min-h-[32px]">{plan.description}</p>

                      <div className="mt-4 flex items-baseline gap-1">
                        <span className="text-3xl font-extrabold text-slate-900">£{plan.priceMonthly}</span>
                        <span className="text-xs text-slate-500 font-medium"> / month</span>
                      </div>
                      <span className="inline-block mt-1 font-mono text-xs font-semibold text-brand-700 bg-brand-50 px-2 py-0.5 rounded">
                        Up to {plan.orderLimit.toLocaleString()} orders / mo
                      </span>

                      <div className="mt-6 space-y-2.5 border-t border-slate-100 pt-5">
                        {plan.features.map((feat, i) => (
                          <div key={i} className="flex items-start gap-2 text-xs text-slate-600">
                            <span className="text-brand-600 font-bold shrink-0">✓</span>
                            <span>{feat}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="mt-8 pt-4 border-t border-slate-100">
                      {isCurrent ? (
                        <Button variant="secondary" disabled className="w-full">
                          Current Plan
                        </Button>
                      ) : (
                        <Button
                          variant={planKey === 'growth' ? 'primary' : 'secondary'}
                          disabled={!isOwner}
                          loading={checkoutMutation.isPending}
                          onClick={() => checkoutMutation.mutate(planKey)}
                          className="w-full"
                        >
                          {isOwner ? `Upgrade to ${plan.name}` : 'Owner required to upgrade'}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
