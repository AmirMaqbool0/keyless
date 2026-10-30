import clsx from 'clsx';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, EmptyState, Spinner } from './ui';

export function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className={clsx('relative w-full sm:max-w-xs', className)}>
      <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400">
        <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
      </div>
      <input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3.5 text-sm text-slate-800 placeholder:text-slate-400 shadow-xs transition hover:border-slate-300 focus:border-brand-500 focus:outline-none focus:ring-3 focus:ring-brand-500/15"
      />
    </div>
  );
}

export type Column<T> = {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  empty,
  onRowClick,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  empty: ReactNode;
  onRowClick?: (row: T) => void;
}) {
  if (loading && !rows) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-brand-600 gap-3">
        <Spinner className="size-8" />
        <span className="text-xs font-medium text-slate-400">Loading data...</span>
      </div>
    );
  }
  if (!rows?.length) return <>{empty}</>;
  return (
    <div
      className={clsx(
        'overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.03),0_4px_12px_rgba(0,0,0,0.02)]',
        loading && 'opacity-60',
      )}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200/80 bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            <tr>
              {columns.map((c) => (
                <th key={c.header} className={clsx('px-5 py-3 font-semibold', c.className)}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100/90">
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={clsx(
                  'transition-colors duration-150',
                  onRowClick && 'cursor-pointer hover:bg-slate-50/90 active:bg-slate-100/60',
                )}
              >
                {columns.map((c) => (
                  <td key={c.header} className={clsx('px-5 py-3.5 align-middle', c.className)}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="mt-4 flex items-center justify-between text-xs text-slate-500 font-medium">
      <span>
        Showing <strong className="text-slate-800">{from.toLocaleString()}-{to.toLocaleString()}</strong> of{' '}
        <strong className="text-slate-800">{total.toLocaleString()}</strong> results
      </span>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)} className="px-3 py-1.5 text-xs">
          Previous
        </Button>
        <Button variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)} className="px-3 py-1.5 text-xs">
          Next
        </Button>
      </div>
    </div>
  );
}

export function NoResults({ query, children }: { query?: string; children?: ReactNode }) {
  return (
    <EmptyState title={query ? `Nothing matches "${query}"` : 'Nothing here yet'}>
      {children}
    </EmptyState>
  );
}

export const money = (n: number | null | undefined, currency = 'GBP') =>
  n === null || n === undefined ? '-' : n.toLocaleString('en-GB', { style: 'currency', currency });

export const relativeTime = (iso: string | null | undefined) => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return new Date(iso).toLocaleDateString();
};
