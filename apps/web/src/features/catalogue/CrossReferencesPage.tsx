import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { CrossReferenceDto, Paginated } from '@keyless/shared';
import {
  DataTable,
  NoResults,
  Pagination,
  SearchInput,
  relativeTime,
  useDebounced,
} from '../../components/data';
import { Badge, Button, PageHeader } from '../../components/ui';
import { api, errorMessage, qs } from '../../lib/api';
import { useHasRole } from '../../lib/session';

const SOURCE_TONE = { import: 'slate', learned: 'brand', manual: 'amber' } as const;

/** Cross-reference list; filtered to one customer when `customerId` is set. */
export function CrossReferenceTable({ customerId }: { customerId?: string }) {
  const isAdmin = useHasRole('admin');
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [page, setPage] = useState(1);
  const query = useDebounced(q);
  const xrefs = useQuery({
    queryKey: ['cross-references', customerId, query, source, page],
    queryFn: () =>
      api.get<Paginated<CrossReferenceDto>>(
        `/api/cross-references${qs({ customerId, q: query, source, page, pageSize: 50 })}`,
      ),
    placeholderData: keepPreviousData,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/cross-references/${id}`),
    onSuccess: () => {
      toast.success('Cross-reference deleted');
      void qc.invalidateQueries({ queryKey: ['cross-references'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-3">
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search customer code, description or SKU"
        />
        <select
          aria-label="Source"
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setPage(1);
          }}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">All sources</option>
          <option value="import">Imported</option>
          <option value="learned">Learned from reviews</option>
          <option value="manual">Manual</option>
        </select>
      </div>
      <DataTable
        loading={xrefs.isFetching}
        rows={xrefs.data?.items}
        rowKey={(x) => x.id}
        empty={
          <NoResults query={query}>
            {!query &&
              'Cross-references are imported here, and learned automatically from reviewer corrections (M6).'}
          </NoResults>
        }
        columns={[
          ...(customerId
            ? []
            : [
                {
                  header: 'Customer',
                  cell: (x: CrossReferenceDto) => (
                    <Link to={`/customers/${x.customerId}`} className="hover:text-brand-700">
                      {x.customerName ?? '-'}
                    </Link>
                  ),
                },
              ]),
          {
            header: 'They write',
            cell: (x) => (
              <>
                {x.customerPartCode && (
                  <p className="font-mono text-xs font-medium">{x.customerPartCode}</p>
                )}
                {x.customerDescription && (
                  <p className="text-xs text-slate-500">{x.customerDescription}</p>
                )}
              </>
            ),
          },
          {
            header: 'Our product',
            cell: (x) => (
              <>
                <p className="font-mono text-xs font-medium">{x.sku}</p>
                <p className="text-xs text-slate-500">
                  {x.productDescription ?? 'Not in catalogue'}
                </p>
              </>
            ),
          },
          {
            header: 'Units',
            cell: (x) =>
              x.uomFactor === 1
                ? (x.customerUom ?? '-')
                : `1 ${x.customerUom ?? 'unit'} = ${Number(x.uomFactor.toFixed(4))}`,
            className: 'whitespace-nowrap',
          },
          { header: 'Source', cell: (x) => <Badge tone={SOURCE_TONE[x.source]}>{x.source}</Badge> },
          {
            header: 'Used',
            cell: (x) =>
              x.timesUsed ? `${x.timesUsed}x, ${relativeTime(x.lastUsedAt)}` : 'Not yet',
            className: 'whitespace-nowrap text-slate-500',
          },
          ...(isAdmin
            ? [
                {
                  header: '',
                  cell: (x: CrossReferenceDto) => (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        if (
                          confirm(
                            `Delete the mapping ${x.customerPartCode ?? x.customerDescription} -> ${x.sku}?`,
                          )
                        )
                          remove.mutate(x.id);
                      }}
                    >
                      Delete
                    </Button>
                  ),
                  className: 'text-right',
                },
              ]
            : []),
        ]}
      />
      {xrefs.data && (
        <Pagination page={page} pageSize={50} total={xrefs.data.total} onPage={setPage} />
      )}
    </>
  );
}

export function CrossReferencesPage() {
  const isAdmin = useHasRole('admin');
  return (
    <>
      <PageHeader
        title="Cross-references"
        description="Your customers' codes and descriptions mapped to your SKUs. Keyless learns new ones every time a reviewer corrects a match."
        actions={
          <div className="flex gap-2">
            <a href="/api/cross-references/export" download>
              <Button variant="secondary">Export CSV</Button>
            </a>
            {isAdmin && (
              <Link to="/imports/new?type=cross_references">
                <Button>Import</Button>
              </Link>
            )}
          </div>
        }
      />
      <CrossReferenceTable />
    </>
  );
}
