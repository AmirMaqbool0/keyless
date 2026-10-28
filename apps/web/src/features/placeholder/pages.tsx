import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { IntegrationPipelineStatusDto, OrderCounts } from '@keyless/shared';
import { Badge, EmptyState, PageHeader } from '../../components/ui';
import { api } from '../../lib/api';
import { useMe } from '../../lib/session';

export function OverviewPage() {
  const { user, organization } = useMe();
  const counts = useQuery({
    queryKey: ['order-counts'],
    queryFn: () => api.get<OrderCounts>('/api/orders/counts'),
    refetchInterval: 10_000,
  });

  const pipeline = useQuery({
    queryKey: ['pipeline-status'],
    queryFn: () => api.get<IntegrationPipelineStatusDto>('/api/org/pipeline-status'),
    refetchInterval: 15_000,
  });

  const readyCount = counts.data?.ready ?? 0;
  const reviewCount = counts.data?.needs_review ?? 0;
  const holdCount = counts.data?.on_hold ?? 0;
  const sentCount = counts.data?.pushed ?? 0;

  return (
    <div className="space-y-8">
      {/* Hero Welcome Banner */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-brand-900 via-indigo-900 to-slate-900 p-8 text-white shadow-lg">
        <div className="absolute -right-10 -top-10 size-64 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="relative z-10 flex flex-wrap items-center justify-between gap-6">
          <div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-xs font-medium text-emerald-300 ring-1 ring-inset ring-emerald-500/30">
                <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Autonomous System Active
              </span>
              <span className="text-xs text-indigo-200">|</span>
              <span className="text-xs text-indigo-200">{organization.name}</span>
            </div>
            <h1 className="mt-2 text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
              Welcome back, {user.name.split(' ')[0]}
            </h1>
            <p className="mt-1 max-w-xl text-sm text-indigo-100/90 leading-relaxed">
              Your sales order automation platform is continuously reading incoming purchase orders, extracting product line items with AI, and synchronizing with your inventory.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/orders"
              className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-brand-900 shadow-sm transition hover:bg-indigo-50 active:scale-95"
            >
              <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              View Order Queue
            </Link>
            <Link
              to="/inbox"
              className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-4 py-2.5 text-sm font-semibold text-white backdrop-blur-sm transition hover:bg-white/20 active:scale-95"
            >
              Inbox
            </Link>
          </div>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Ready to Approve */}
        <Link to="/orders?view=ready" className="group">
          <div className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-md">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Ready for ERP
              </span>
              <span className="flex size-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </span>
            </div>
            <p className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
              {counts.isPending ? '...' : readyCount}
            </p>
            <p className="mt-1 text-xs text-emerald-600 font-medium">
              100% clean matched &bull; 0 touch required
            </p>
          </div>
        </Link>

        {/* Needs Review */}
        <Link to="/orders?view=needs_review" className="group">
          <div className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-amber-300 hover:shadow-md">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Needs Review
              </span>
              <span className="flex size-7 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
                <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </span>
            </div>
            <p className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
              {counts.isPending ? '...' : reviewCount}
            </p>
            <p className="mt-1 text-xs text-amber-600 font-medium">
              Requires 1-click human verification
            </p>
          </div>
        </Link>

        {/* On Hold */}
        <Link to="/orders?view=on_hold" className="group">
          <div className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-rose-300 hover:shadow-md">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                On Hold
              </span>
              <span className="flex size-7 items-center justify-center rounded-lg bg-rose-50 text-rose-600">
                <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
              </span>
            </div>
            <p className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
              {counts.isPending ? '...' : holdCount}
            </p>
            <p className="mt-1 text-xs text-rose-600 font-medium">
              Credit hold or duplicate warnings
            </p>
          </div>
        </Link>

        {/* Sent to ERP */}
        <Link to="/orders?view=pushed" className="group">
          <div className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-md">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Sent to ERP
              </span>
              <span className="flex size-7 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                </svg>
              </span>
            </div>
            <p className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
              {counts.isPending ? '...' : sentCount}
            </p>
            <p className="mt-1 text-xs text-indigo-600 font-medium">
              Synced & ready for dispatch
            </p>
          </div>
        </Link>
      </div>

      {/* Connected Integrations & Pipeline Status */}
      <div className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-xs">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Live Integration Pipeline</h2>
            <p className="text-xs text-slate-500">Real-time status of your end-to-end automation components</p>
          </div>
          {pipeline.data?.allOperational ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200/70">
              <span className="size-1.5 rounded-full bg-emerald-500" /> All Services Operational
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 ring-1 ring-amber-200/70">
              <span className="size-1.5 rounded-full bg-amber-500" /> Action Needed
            </span>
          )}
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* AI Extraction */}
          <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">AI Extraction</span>
              <Badge tone={pipeline.data?.ai.status === 'active' ? 'green' : 'amber'} dot>
                {pipeline.data?.ai.status === 'active' ? 'Active' : 'Degraded'}
              </Badge>
            </div>
            <p className="mt-2 text-sm font-bold text-slate-900">
              {pipeline.data ? `${pipeline.data.ai.provider} • ${pipeline.data.ai.model}` : 'Loading...'}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {pipeline.data?.ai.lastExtractionAt
                ? `Last read: ${new Date(pipeline.data.ai.lastExtractionAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : 'Autonomous line & table parser'}
            </p>
          </div>

          {/* Email Inbound */}
          <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">Email Ingestion</span>
              <Badge tone={pipeline.data?.email.status === 'listening' ? 'green' : 'amber'} dot>
                {pipeline.data?.email.status === 'listening' ? 'Listening' : 'Not Set'}
              </Badge>
            </div>
            <p className="mt-2 text-sm font-bold text-slate-900 truncate" title={pipeline.data?.email.address ?? undefined}>
              {pipeline.data?.email.address || 'Inbound Forwarding'}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {pipeline.data?.email.lastReceivedAt
                ? `Last received: ${new Date(pipeline.data.email.lastReceivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : 'Captures customer PO attachments'}
            </p>
          </div>

          {/* Outbound Delivery */}
          <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">Outbound Mailer</span>
              <Badge tone={pipeline.data?.mailer.status === 'verified' ? 'green' : 'amber'} dot>
                {pipeline.data?.mailer.status === 'verified' ? 'Verified' : 'Not Configured'}
              </Badge>
            </div>
            <p className="mt-2 text-sm font-bold text-slate-900 truncate">
              {pipeline.data ? `${pipeline.data.mailer.provider.toUpperCase()} (${pipeline.data.mailer.from.split('<')[0]?.trim() || 'Keyless'})` : 'Mailer'}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">Order acknowledgments & alerts</p>
          </div>

          {/* ERP Connector */}
          <Link to="/settings/integrations" className="block group">
            <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-4 transition hover:border-brand-300">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700">ERP & Storage</span>
                <Badge tone={pipeline.data?.erp.status === 'connected' ? 'green' : 'amber'} dot>
                  {pipeline.data?.erp.status === 'connected' ? 'Connected' : 'Not Connected'}
                </Badge>
              </div>
              <p className="mt-2 text-sm font-bold text-slate-900 truncate">
                {pipeline.data?.erp.name || 'Not connected'}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {pipeline.data?.erp.status === 'connected'
                  ? (pipeline.data.erp.lastSyncAt ? `Synced ${new Date(pipeline.data.erp.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Connected & ready')
                  : 'Click to configure ERP sync'}
              </p>
            </div>
          </Link>
        </div>
      </div>

      {/* Non-Technical Workflow Guide */}
      <div className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-xs">
        <h2 className="text-base font-semibold text-slate-900">How Order Processing Works</h2>
        <p className="text-xs text-slate-500">A completely automated hands-free workflow designed for non-technical teams</p>

        <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-4">
          <div className="relative flex flex-col gap-2">
            <span className="flex size-8 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
              1
            </span>
            <h3 className="text-sm font-semibold text-slate-900">Customer Sends PO</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Customer emails a PDF, image, or text order to your mailbox. Outlook automatically forwards it to Keyless.
            </p>
          </div>

          <div className="relative flex flex-col gap-2">
            <span className="flex size-8 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
              2
            </span>
            <h3 className="text-sm font-semibold text-slate-900">AI Reads & Extracts</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Our AI extracts PO number, customer name, delivery address, product codes, quantities, and prices in seconds.
            </p>
          </div>

          <div className="relative flex flex-col gap-2">
            <span className="flex size-8 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
              3
            </span>
            <h3 className="text-sm font-semibold text-slate-900">Verification & Rules</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Keyless checks pricing against your catalogue, matches part numbers, checks credit limits, and flags any discrepancy.
            </p>
          </div>

          <div className="relative flex flex-col gap-2">
            <span className="flex size-8 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
              4
            </span>
            <h3 className="text-sm font-semibold text-slate-900">Auto-Push to ERP</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Clean orders push directly to your accounting/ERP system, and an order confirmation email is sent via Resend.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ComingSoonPage({
  title,
  milestone,
  description,
}: {
  title: string;
  milestone: string;
  description: string;
}) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState title={`Arrives in ${milestone}`}>{description}</EmptyState>
    </>
  );
}
