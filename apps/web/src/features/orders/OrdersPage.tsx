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
    <>
      <PageHeader
        title="Orders"
        description="Every purchase order Keyless has read, routed green (ready), amber (check) or red (blocked)."
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1" aria-label="Order queues">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                setParams(t.key === 'needs_review' ? {} : { view: t.key });
                setPage(1);
              }}
              className={clsx(
                'rounded-md px-3 py-1.5 text-sm font-medium',
                view === t.key
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900',
              )}
            >
              {t.label}
              {counts.data && (
                <span className="ml-1.5 text-xs text-slate-400">{counts.data[t.key]}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Colour"
            value={colour}
            onChange={(e) => {
              setColour(e.target.value as RouteColour | '');
              setPage(1);
            }}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">All colours</option>
            <option value="green">Green - ready</option>
            <option value="amber">Amber - check</option>
            <option value="red">Red - blocked</option>
          </select>
          <SearchInput
            value={q}
            onChange={(v) => {
              setQ(v);
              setPage(1);
            }}
            placeholder="Search PO number or customer"
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
            cell: (o) => money(o.value, o.currency),
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
            cell: (o) => `${Math.round(o.confidence * 100)}%`,
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
    </>
  );
}
