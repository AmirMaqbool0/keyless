import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { CustomerDto, Paginated } from '@keyless/shared';
import { DataTable, NoResults, Pagination, SearchInput, useDebounced } from '../../components/data';
import { Badge, Button, PageHeader } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { useHasRole } from '../../lib/session';

export function CustomersPage() {
  const navigate = useNavigate();
  const isAdmin = useHasRole('admin');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const query = useDebounced(q);
  const customers = useQuery({
    queryKey: ['customers', query, page],
    queryFn: () =>
      api.get<Paginated<CustomerDto>>(`/api/customers${qs({ q: query, page, pageSize: 50 })}`),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Customers"
        description="Who sends you orders, from which addresses, and at what prices."
        actions={
          isAdmin && (
            <div className="flex gap-2">
              <Link to="/imports/new?type=prices">
                <Button variant="secondary">Import prices</Button>
              </Link>
              <Link to="/imports/new?type=customers">
                <Button>Import customers</Button>
              </Link>
            </div>
          )
        }
      />
      <div className="mb-4">
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search name, account code or sender email"
        />
      </div>
      <DataTable
        loading={customers.isFetching}
        rows={customers.data?.items}
        rowKey={(c) => c.id}
        onRowClick={(c) => navigate(`/customers/${c.id}`)}
        empty={
          <NoResults query={query}>
            {!query && 'Import customers or sync them from your system.'}
          </NoResults>
        }
        columns={[
          {
            header: 'Account',
            cell: (c) => <span className="font-mono text-xs font-medium">{c.accountCode}</span>,
          },
          {
            header: 'Customer',
            cell: (c) => (
              <Link
                to={`/customers/${c.id}`}
                className="font-medium text-slate-900 hover:text-brand-700"
                onClick={(e) => e.stopPropagation()}
              >
                {c.name}
              </Link>
            ),
            className: 'min-w-48',
          },
          {
            header: 'Order senders',
            cell: (c) =>
              c.senderAddresses.length ? (
                <span className="text-slate-600">
                  {c.senderAddresses[0]}
                  {c.senderAddresses.length > 1 && (
                    <span className="text-slate-400"> +{c.senderAddresses.length - 1}</span>
                  )}
                </span>
              ) : (
                <span className="text-amber-700">None yet</span>
              ),
          },
          { header: 'Price list', cell: (c) => c.priceListCode ?? '-' },
          {
            header: 'Cross-refs',
            cell: (c) => (c.crossReferenceCount ?? 0).toLocaleString(),
            className: 'text-right',
          },
          {
            header: 'Flags',
            cell: (c) => (
              <div className="flex gap-1">
                {c.creditHold && <Badge tone="red">Credit hold</Badge>}
                {c.trustedForAutoApprove && <Badge tone="green">Trusted</Badge>}
              </div>
            ),
          },
        ]}
      />
      {customers.data && (
        <Pagination page={page} pageSize={50} total={customers.data.total} onPage={setPage} />
      )}
    </>
  );
}
