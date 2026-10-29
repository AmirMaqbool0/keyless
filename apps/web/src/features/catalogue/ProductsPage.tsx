import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import type { Paginated, ProductDto } from '@keyless/shared';
import {
  DataTable,
  NoResults,
  Pagination,
  SearchInput,
  money,
  useDebounced,
} from '../../components/data';
import { Badge, Button, PageHeader } from '../../components/ui';
import { api, errorMessage, qs } from '../../lib/api';
import { useHasRole, useMe } from '../../lib/session';

export function ProductsPage() {
  const { organization } = useMe();
  const isAdmin = useHasRole('admin');
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [active, setActive] = useState<'all' | 'true' | 'false'>('all');
  const [page, setPage] = useState(1);
  const [clearing, setClearing] = useState(false);
  const query = useDebounced(q);

  const products = useQuery({
    queryKey: ['products', query, active, page],
    queryFn: () =>
      api.get<Paginated<ProductDto>>(
        `/api/products${qs({ q: query, active, page, pageSize: 50 })}`,
      ),
    placeholderData: keepPreviousData,
  });

  const clearAll = async () => {
    if (
      !window.confirm(
        'Are you sure you want to delete ALL products from your catalogue? This cannot be undone.',
      )
    )
      return;
    try {
      setClearing(true);
      await api.delete('/api/products/all');
      await qc.invalidateQueries({ queryKey: ['products'] });
    } catch (err) {
      alert(errorMessage(err));
    } finally {
      setClearing(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Products"
        description={
          !products.data
            ? 'Your catalogue'
            : query
              ? `${products.data.total.toLocaleString()} matching "${query}"`
              : `${products.data.total.toLocaleString()} products in your catalogue`
        }
        actions={
          isAdmin && (
            <div className="flex gap-2">
              <Button
                variant="danger"
                loading={clearing}
                onClick={clearAll}
                disabled={!products.data || products.data.total === 0}
              >
                Delete all products
              </Button>
              <Link to="/imports/new?type=products">
                <Button>Import products</Button>
              </Link>
            </div>
          )
        }
      />
      <div className="mb-4 flex flex-wrap gap-3">
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search SKU, description or barcode"
        />
        <select
          aria-label="Status"
          value={active}
          onChange={(e) => {
            setActive(e.target.value as typeof active);
            setPage(1);
          }}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="all">All products</option>
          <option value="true">Active only</option>
          <option value="false">Inactive only</option>
        </select>
      </div>
      <DataTable
        loading={products.isFetching}
        rows={products.data?.items}
        rowKey={(p) => p.id}
        empty={
          <NoResults query={query}>
            {!query && isAdmin && (
              <>
                <Link to="/imports/new?type=products" className="text-brand-700 hover:underline">
                  Import a CSV
                </Link>{' '}
                or{' '}
                <Link to="/settings/integrations" className="text-brand-700 hover:underline">
                  sync from your system
                </Link>
                .
              </>
            )}
          </NoResults>
        }
        columns={[
          {
            header: 'SKU',
            cell: (p) => <span className="font-mono text-xs font-medium">{p.sku}</span>,
            className: 'whitespace-nowrap',
          },
          {
            header: 'Description',
            cell: (p) => (
              <>
                <p className="text-slate-900">{p.description}</p>
                {p.barcode && <p className="font-mono text-xs text-slate-400">{p.barcode}</p>}
              </>
            ),
          },
          {
            header: 'Unit',
            cell: (p) => [p.uom, p.packSize && `x${p.packSize}`].filter(Boolean).join(' ') || '-',
            className: 'whitespace-nowrap',
          },
          {
            header: 'Price',
            cell: (p) => money(p.defaultPrice, organization.currency),
            className: 'text-right whitespace-nowrap',
          },
          {
            header: 'Stock',
            cell: (p) =>
              p.stockQty === null ? (
                '-'
              ) : (
                <span className={p.stockQty === 0 ? 'text-red-600' : ''}>
                  {p.stockQty.toLocaleString()}
                </span>
              ),
            className: 'text-right',
          },
          {
            header: 'Status',
            cell: (p) => (p.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>),
          },
          {
            header: 'Source',
            cell: (p) => <span className="text-xs text-slate-500">{p.source}</span>,
          },
        ]}
      />
      {products.data && (
        <Pagination page={page} pageSize={50} total={products.data.total} onPage={setPage} />
      )}
    </>
  );
}
