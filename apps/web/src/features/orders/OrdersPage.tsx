import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type {
  OrderCounts,
  OrderListItemDto,
  OrderView,
  Paginated,
  RouteColour,
} from '@keyless/shared';
import { DataTable, NoResults, Pagination, SearchInput, useDebounced } from '../../components/data';
import { PageHeader } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { ColourDot, StatusPill, age, money } from './OrderBits';

const TABS: { key: OrderView; label: string }[] = [
  { key: 'needs_review', label: 'Needs review' },
  { key: 'ready', label: 'Ready' },
  { key: 'on_hold', label: 'On hold' },
  { key: 'pushed', label: 'Sent' },
  { key: 'failed', label: 'Failed' },
  { key: 'all', label: 'All' },
];

export function OrdersPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = (TABS.find((t) => t.key === params.get('view'))?.key ?? 'needs_review') as OrderView;
  const [colour, setColour] = useState<RouteColour | ''>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const query = useDebounced(q);

  const counts = useQuery({
    queryKey: ['order-counts'],
    queryFn: () => api.get<OrderCounts>('/api/orders/counts'),
    refetchInterval: 10_000,
  });
  const orders = useQuery({
    queryKey: ['orders', view, colour, query, page],
    queryFn: () =>
      api.get<Paginated<OrderListItemDto>>(
        `/api/orders${qs({ view, colour, q: query, page, pageSize: 50 })}`,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Purchase Orders"
        description="Every purchase order read and processed by Keyless, color-coded for quick review and 1-click ERP synchronization."
        badge={
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200/70">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            AI Matched
          </span>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-4">
        {/* Modern Segmented Navigation Tabs */}
        <nav className="flex flex-wrap gap-1 rounded-xl bg-slate-100/90 p-1.5 ring-1 ring-slate-200/60" aria-label="Order queues">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                setParams(t.key === 'needs_review' ? {} : { view: t.key });
                setPage(1);
              }}
              className={clsx(
                'inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-all duration-150',
                view === t.key
                  ? 'bg-white text-slate-900 shadow-xs ring-1 ring-slate-300 font-bold'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/50',
              )}
            >
              <span>{t.label}</span>
              {counts.data && (
                <span
                  className={clsx(
                    'rounded-full px-2 py-0.5 text-[10px] font-bold',
                    view === t.key
                      ? 'bg-brand-100 text-brand-800'
                      : 'bg-slate-200/80 text-slate-600',
                  )}
                >
                  {counts.data[t.key]}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Filters and Search Bar */}
        <div className="flex flex-wrap items-center gap-2.5">
          <select
            aria-label="Filter by route color"
            value={colour}
            onChange={(e) => {
              setColour(e.target.value as RouteColour | '');
              setPage(1);
            }}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-xs transition hover:border-slate-300 focus:border-brand-500 focus:outline-none focus:ring-3 focus:ring-brand-500/15"
          >
            <option value="">All statuses</option>
            <option value="green">🟢 Green &bull; Ready</option>
            <option value="amber">🟡 Amber &bull; Check</option>
            <option value="red">🔴 Red &bull; Blocked</option>
          </select>
          <SearchInput
            value={q}
            onChange={(v) => {
              setQ(v);
              setPage(1);
            }}
            placeholder="Search PO # or customer..."
          />
        </div>
      </div>
      <DataTable
        loading={orders.isFetching && !orders.data}
        rows={orders.data?.items}
        rowKey={(o) => o.id}
        onRowClick={(o) => navigate(`/orders/${o.id}`)}
        empty={
          <NoResults query={query}>
            {!query && 'Orders appear here as soon as purchase-order emails are read.'}
          </NoResults>
        }
        columns={[
          {
            header: '',
            cell: (o) => <ColourDot colour={o.colour} className="mt-1.5" />,
            className: 'w-4 pr-0',
          },
          {
            header: 'Customer',
            cell: (o) => (
              <div className="min-w-44">
                <p
                  className={clsx(
                    'font-medium',
                    o.customer.name ? 'text-slate-900' : 'text-amber-700',
                  )}
                >
                  {o.customer.name ?? 'Unknown customer'}
                </p>
                {o.customer.accountCode && (
                  <p className="font-mono text-xs text-slate-500">{o.customer.accountCode}</p>
                )}
              </div>
            ),
          },
          {
            header: 'PO',
            cell: (o) => <span className="font-mono text-xs">{o.poNumber ?? '-'}</span>,
          },
          { header: 'Lines', cell: (o) => o.lineCount, className: 'text-right' },
          {
            header: 'Value',
            cell: (o) => (
              <span className="inline-flex items-center gap-1">
                <span>{money(o.value, o.currency)}</span>
                {o.valueEstimated && (
                  <span
                    className="rounded bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-700 border border-amber-200"
                    title="Estimated based on catalogue list/contract prices"
                  >
                    est.
                  </span>
                )}
              </span>
            ),
            className: 'text-right whitespace-nowrap',
          },
          {
            header: 'Status',
            cell: (o) => (
              <div className="min-w-56">
                <StatusPill status={o.status} colour={o.colour} />
                {o.topIssue && (
                  <p className="mt-1 line-clamp-1 text-xs text-slate-500" title={o.topIssue}>
                    {o.topIssue}
                    {o.issueCount > 1 && ` (+${o.issueCount - 1} more)`}
                  </p>
                )}
              </div>
            ),
          },
          {
            header: 'Confidence',
            cell: (o) => (
              <div className="text-right">
                <span className="font-medium text-slate-800">{Math.round(o.confidence * 100)}%</span>
                {o.confidenceHint && (
                  <p className="text-xs text-slate-500 whitespace-nowrap" title={o.confidenceHint}>
                    {o.confidenceHint}
                  </p>
                )}
              </div>
            ),
            className: 'text-right',
          },
          {
            header: 'Received',
            cell: (o) => (
              <span className="whitespace-nowrap text-slate-500">
                {new Date(o.receivedAt).toLocaleString('en-GB', {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })}
              </span>
            ),
          },
          {
            header: 'Age',
            cell: (o) => <span className="text-slate-500">{age(o.receivedAt)}</span>,
            className: 'text-right',
          },
        ]}
      />
      {orders.data && (
        <Pagination page={page} pageSize={50} total={orders.data.total} onPage={setPage} />
      )}
    </div>
  );
}
