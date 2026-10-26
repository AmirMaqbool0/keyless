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
    <input
      type="search"
      aria-label={placeholder}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={clsx(
        'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-xs placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 sm:max-w-sm',
        className,
      )}
    />
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
      <div className="flex justify-center py-12 text-brand-600">
        <Spinner />
      </div>
    );
  }
  if (!rows?.length) return <>{empty}</>;
  return (
    <div
      className={clsx(
        'overflow-x-auto rounded-lg border border-slate-200 bg-white',
        loading && 'opacity-60',
      )}
    >
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            {columns.map((c) => (
              <th key={c.header} className={clsx('px-4 py-2.5 font-medium', c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={clsx(onRowClick && 'cursor-pointer hover:bg-slate-50')}
            >
              {columns.map((c) => (
                <td key={c.header} className={clsx('px-4 py-2.5 align-top', c.className)}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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
    <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
      <span>
        {from.toLocaleString()}-{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
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

export const relativeTime = (iso: string | null) => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return new Date(iso).toLocaleDateString();
};
