import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import type {
  CustomerDto,
  CustomerPriceDto,
  Paginated,
  UpdateCustomerInput,
} from '@keyless/shared';
import { DataTable, NoResults, Pagination, money } from '../../components/data';
import { Badge, Button, Card, FullPageSpinner, PageHeader } from '../../components/ui';
import { api, errorMessage, fieldErrors, qs } from '../../lib/api';
import { useHasRole } from '../../lib/session';
import { CrossReferenceTable } from './CrossReferencesPage';

type Detail = { customer: CustomerDto; counts: { crossReferences: number; prices: number } };

export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const isAdmin = useHasRole('admin');
  const qc = useQueryClient();
  const [tab, setTab] = useState<'xrefs' | 'prices'>('xrefs');
  const detail = useQuery({
    queryKey: ['customer', id],
    queryFn: () => api.get<Detail>(`/api/customers/${id}`),
  });

  const update = useMutation({
    mutationFn: (input: UpdateCustomerInput) =>
      api.patch<{ customer: CustomerDto }>(`/api/customers/${id}`, input),
    onSuccess: () => {
      toast.success('Customer updated');
      void qc.invalidateQueries({ queryKey: ['customer', id] });
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: (err) => {
      const fields = Object.values(fieldErrors(err));
      toast.error(fields[0] ?? errorMessage(err));
    },
  });

  if (detail.isPending) return <FullPageSpinner />;
  if (detail.isError) return <p className="text-sm text-red-600">{errorMessage(detail.error)}</p>;
  const { customer: c, counts } = detail.data;

  return (
    <>
      <Link to="/customers" className="text-sm text-slate-500 hover:text-slate-800">
        &larr; Customers
      </Link>
      <PageHeader
        title={c.name}
        description={`Account ${c.accountCode}${c.erpCustomerId ? ` - ERP ID ${c.erpCustomerId}` : ''} - from ${c.source}`}
        actions={
          <div className="flex gap-2">
            {c.creditHold && <Badge tone="red">Credit hold</Badge>}
            {c.trustedForAutoApprove && <Badge tone="green">Trusted for auto-approve</Badge>}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Order controls" description="Used when routing orders from this customer.">
          <div className="space-y-3">
            <Toggle
              label="On credit hold"
              help="Orders go straight to On hold (red)."
              checked={c.creditHold}
              disabled={!isAdmin || update.isPending}
              onChange={(v) => update.mutate({ creditHold: v })}
            />
            <Toggle
              label="Trusted for auto-approve"
              help="Allows auto-approve rules (M8) to push this customer's green orders."
              checked={c.trustedForAutoApprove}
              disabled={!isAdmin || update.isPending}
              onChange={(v) => update.mutate({ trustedForAutoApprove: v })}
            />
            <p className="text-sm text-slate-600">
              Price list: <strong>{c.priceListCode ?? 'none'}</strong>
            </p>
          </div>
        </Card>

        <Card
          title="How we recognise them"
          description="Emails from these senders or domains are matched to this customer."
        >
          <ListEditor
            label="Sender addresses"
            values={c.senderAddresses}
            placeholder="orders@customer.co.uk"
            disabled={!isAdmin}
            onSave={(senderAddresses) => update.mutate({ senderAddresses })}
          />
          <div className="mt-4">
            <ListEditor
              label="Email domains"
              values={c.emailDomains}
              placeholder="customer.co.uk"
              disabled={!isAdmin}
              onSave={(emailDomains) => update.mutate({ emailDomains })}
            />
          </div>
        </Card>

        <Card title="Delivery addresses">
          {c.deliveryAddresses.length ? (
            <ul className="space-y-3 text-sm">
              {c.deliveryAddresses.map((a, i) => (
                <li key={i}>
                  {a.label && (
                    <p className="text-xs font-medium uppercase text-slate-400">{a.label}</p>
                  )}
                  <p>{[a.line1, a.line2].filter(Boolean).join(', ')}</p>
                  <p className="text-slate-500">
                    {[a.city, a.postcode, a.country].filter(Boolean).join(' ')}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">
              None known. New addresses on orders will be flagged for review.
            </p>
          )}
        </Card>
      </div>

      <div className="mt-8 border-b border-slate-200">
        <nav className="-mb-px flex gap-6" aria-label="Customer data">
          {(
            [
              ['xrefs', `Cross-references (${counts.crossReferences})`],
              ['prices', `Prices (${counts.prices})`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={clsx(
                'border-b-2 px-1 pb-2 text-sm font-medium',
                tab === key
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800',
              )}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>
      <div className="mt-4">
        {tab === 'xrefs' ? (
          <CrossReferenceTable customerId={c.id} />
        ) : (
          <PricesTable customerId={c.id} />
        )}
      </div>
    </>
  );
}

function PricesTable({ customerId }: { customerId: string }) {
  const [page, setPage] = useState(1);
  const prices = useQuery({
    queryKey: ['customer-prices', customerId, page],
    queryFn: () =>
      api.get<Paginated<CustomerPriceDto>>(
        `/api/customers/${customerId}/prices${qs({ page, pageSize: 50 })}`,
      ),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <DataTable
        loading={prices.isFetching}
        rows={prices.data?.items}
        rowKey={(p) => p.id}
        empty={
          <NoResults>No contract or price-list prices. Default catalogue prices apply.</NoResults>
        }
        columns={[
          { header: 'SKU', cell: (p) => <span className="font-mono text-xs">{p.sku}</span> },
          { header: 'Price', cell: (p) => money(p.price, p.currency), className: 'text-right' },
          { header: 'Min qty', cell: (p) => p.minQty ?? '-', className: 'text-right' },
          {
            header: 'From',
            cell: (p) =>
              p.customerId ? (
                <Badge tone="brand">Contract</Badge>
              ) : (
                <Badge>List {p.priceListCode}</Badge>
              ),
          },
          {
            header: 'Valid',
            cell: (p) =>
              [p.validFrom, p.validTo].some(Boolean)
                ? `${p.validFrom ?? '...'} to ${p.validTo ?? '...'}`
                : 'Always',
          },
        ]}
      />
      {prices.data && (
        <Pagination page={page} pageSize={50} total={prices.data.total} onPage={setPage} />
      )}
    </>
  );
}

function Toggle({
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  help: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={clsx(
        'flex items-start gap-3',
        disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer',
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-brand-600"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        <span className="block text-xs text-slate-500">{help}</span>
      </span>
    </label>
  );
}

/** Small "one per line" editor for addresses and domains. */
function ListEditor({
  label,
  values,
  placeholder,
  disabled,
  onSave,
}: {
  label: string;
  values: string[];
  placeholder: string;
  disabled?: boolean;
  onSave: (values: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(values.join('\n'));
  if (!editing) {
    return (
      <div>
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-700">{label}</p>
          {!disabled && (
            <button
              className="text-xs text-brand-700 hover:underline"
              onClick={() => {
                setText(values.join('\n'));
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
        </div>
        {values.length ? (
          <ul className="mt-1 space-y-0.5 text-sm text-slate-600">
            {values.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-slate-400">None</p>
        )}
      </div>
    );
  }
  return (
    <div>
      <label className="text-sm font-medium text-slate-700">
        {label} <span className="font-normal text-slate-400">(one per line)</span>
        <textarea
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
          rows={4}
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className="mt-2 flex gap-2">
        <Button
          onClick={() => {
            onSave(
              text
                .split(/[\n,;]/)
                .map((s) => s.trim())
                .filter(Boolean),
            );
            setEditing(false);
          }}
        >
          Save
        </Button>
        <Button variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
