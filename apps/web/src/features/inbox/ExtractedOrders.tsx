import clsx from 'clsx';
import type { ExtractedOrderDto, ExtractionDto } from '@keyless/shared';
import { Badge, Card } from '../../components/ui';

const LOW = 0.7;

const money = (n: number | null, currency: string | null) =>
  n === null
    ? '-'
    : currency
      ? n.toLocaleString('en-GB', { style: 'currency', currency })
      : n.toFixed(2);

function ConfidenceBadge({ value }: { value: number }) {
  const tone = value >= 0.85 ? 'green' : value >= 0.6 ? 'amber' : 'red';
  return <Badge tone={tone}>{Math.round(value * 100)}% confident</Badge>;
}

/** Cell that turns amber when the model was unsure of it. */
function Cell({
  value,
  confidence,
  className,
}: {
  value: React.ReactNode;
  confidence?: number;
  className?: string;
}) {
  const unsure = confidence !== undefined && confidence < LOW;
  return (
    <td
      className={clsx('px-3 py-1.5 align-top', unsure && 'bg-amber-50 text-amber-900', className)}
      title={confidence !== undefined ? `${Math.round(confidence * 100)}% confident` : undefined}
    >
      {value ?? <span className="text-slate-300">-</span>}
    </td>
  );
}

function Field({
  label,
  value,
  confidence,
}: {
  label: string;
  value: React.ReactNode;
  confidence?: number;
}) {
  const unsure = confidence !== undefined && confidence < LOW;
  return (
    <div className={clsx('rounded px-2 py-1', unsure && 'bg-amber-50')}>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-900">
        {value || <span className="text-slate-300">not on document</span>}
      </dd>
    </div>
  );
}

function OrderView({ order }: { order: ExtractedOrderDto }) {
  const a = order.deliveryAddress;
  const address = [a.line1, a.line2, a.city, a.postcode, a.country].filter(Boolean).join(', ');
  const t = order.documentTotals;
  return (
    <div className="rounded-lg border border-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2">
        <p className="font-medium text-slate-900">
          PO {order.poNumber ?? <span className="text-amber-700">(no PO number)</span>}
        </p>
        <ConfidenceBadge value={order.confidence} />
      </div>
      <dl className="grid gap-1 px-2 py-2 sm:grid-cols-2 lg:grid-cols-3">
        <Field
          label="Customer"
          value={[
            order.customer.name,
            order.customer.accountNumber && `(${order.customer.accountNumber})`,
          ]
            .filter(Boolean)
            .join(' ')}
          confidence={order.fieldConfidence.customer}
        />
        <Field
          label="Order date"
          value={order.orderDate}
          confidence={order.fieldConfidence.orderDate}
        />
        <Field label="Requested delivery" value={order.requestedDeliveryDate} />
        <Field
          label="Deliver to"
          value={address}
          confidence={order.fieldConfidence.deliveryAddress}
        />
        <Field label="Notes" value={order.notes} />
        <Field
          label="Totals"
          value={[
            t.subtotal !== null && `Subtotal ${money(t.subtotal, order.currency)}`,
            t.tax !== null && `VAT ${money(t.tax, order.currency)}`,
            t.total !== null && `Total ${money(t.total, order.currency)}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
      </dl>
      {order.issues.length > 0 && (
        <ul className="mx-4 mb-2 space-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {order.issues.map((i, k) => (
            <li key={k}>
              <span className={clsx('font-medium', i.severity === 'error' && 'text-red-700')}>
                {i.severity === 'error' ? 'Problem' : i.severity === 'warning' ? 'Check' : 'Note'}:
              </span>{' '}
              {i.lineNo ? `line ${i.lineNo}: ` : ''}
              {i.message}
            </li>
          ))}
        </ul>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-y border-slate-100 bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-1.5 font-medium">#</th>
              <th className="px-3 py-1.5 font-medium">Their code</th>
              <th className="px-3 py-1.5 font-medium">Description</th>
              <th className="px-3 py-1.5 text-right font-medium">Qty</th>
              <th className="px-3 py-1.5 font-medium">Unit</th>
              <th className="px-3 py-1.5 text-right font-medium">Price</th>
              <th className="px-3 py-1.5 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {order.lines.map((l) => (
              <tr key={l.lineNo}>
                <td className="px-3 py-1.5 text-slate-400">{l.lineNo}</td>
                <Cell
                  value={
                    l.customerPartCode && (
                      <span className="font-mono text-xs">{l.customerPartCode}</span>
                    )
                  }
                  confidence={l.confidence.customerPartCode}
                />
                <Cell
                  value={l.description}
                  confidence={l.confidence.description}
                  className="min-w-64"
                />
                <Cell
                  value={l.quantity}
                  confidence={l.confidence.quantity}
                  className="text-right"
                />
                <Cell value={l.unit} />
                <Cell
                  value={l.unitPrice === null ? null : money(l.unitPrice, order.currency)}
                  confidence={l.unitPrice === null ? undefined : l.confidence.unitPrice}
                  className="text-right"
                />
                <Cell
                  value={l.lineTotal === null ? null : money(l.lineTotal, order.currency)}
                  className="text-right"
                />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ExtractedOrders({
  extractions,
  running,
  onReextract,
  canReextract,
}: {
  extractions: ExtractionDto[];
  running: boolean;
  onReextract: () => void;
  canReextract: boolean;
}) {
  const cost = extractions.reduce((c, x) => c + x.usage.costUsd, 0);
  return (
    <Card
      title="Extracted orders"
      description={
        extractions.length
          ? `Read by ${extractions[0]!.provider === 'mock' ? 'the offline extractor (no AI key set)' : extractions[0]!.model} - ${extractions[0]!.promptVersion}${cost ? ` - $${cost.toFixed(4)}` : ''}`
          : undefined
      }
      actions={
        canReextract && (
          <button
            onClick={onReextract}
            disabled={running}
            className="text-sm text-brand-700 hover:underline disabled:opacity-50"
          >
            {running ? 'Extracting...' : 'Re-extract'}
          </button>
        )
      }
    >
      {running && !extractions.length && (
        <p className="text-sm text-slate-500">Reading the order...</p>
      )}
      <div className="space-y-4">
        {extractions.map((x) => (
          <div key={x.id}>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
              From {x.source.label}{' '}
              <span className="normal-case">
                ({x.source.mode === 'pdf' ? 'scanned PDF, read by vision' : x.source.mode})
              </span>
            </p>
            {x.status !== 'completed' && (
              <p
                className={clsx(
                  'rounded-md px-3 py-2 text-sm',
                  x.status === 'needs_llm'
                    ? 'bg-slate-50 text-slate-600'
                    : 'bg-red-50 text-red-700',
                )}
              >
                {x.error}
              </p>
            )}
            {x.status === 'completed' && !x.orders.length && (
              <p className="text-sm text-slate-500">No purchase order found in this document.</p>
            )}
            <div className="space-y-3">
              {x.orders.map((o, i) => (
                <OrderView key={i} order={o} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-slate-400">
        Matching to your products and approval arrive in M5-M6. Amber cells are values the reader
        was unsure of.
      </p>
    </Card>
  );
}
