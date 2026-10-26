import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import type { MatchMethod, OrderDetailDto, OrderIssueDto } from '@keyless/shared';
import { Badge, Button, Card, FormError, FullPageSpinner } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useHasRole } from '../../lib/session';
import { ColourDot, StatusPill, money } from './OrderBits';

const METHOD_LABEL: Record<MatchMethod, string> = {
  xref_code: 'their code (learned)',
  xref_description: 'their description (learned)',
  sku: 'our SKU',
  barcode: 'barcode',
  fuzzy: 'description search',
  manual: 'set by reviewer',
  none: 'no match',
};

const CUSTOMER_METHOD: Record<OrderDetailDto['customerMatch']['method'], string> = {
  sender: 'known sender address',
  domain: 'sender email domain',
  account_number: 'account number on the PO',
  name: 'company name',
  forwarded_sender: 'original sender inside a forwarded email',
  manual: 'chosen by a reviewer',
  none: 'not identified',
};

function IssueList({ issues }: { issues: OrderIssueDto[] }) {
  const open = issues.filter((i) => !i.resolved);
  if (!open.length) return <p className="text-sm text-emerald-700">Nothing to check.</p>;
  return (
    <ul className="space-y-1.5 text-sm">
      {open.map((i) => (
        <li key={i.id} className="flex gap-2">
          <span
            className={clsx(
              'mt-0.5 shrink-0 rounded px-1.5 text-xs font-medium',
              i.blocking
                ? 'bg-red-100 text-red-800'
                : i.severity === 'info'
                  ? 'bg-slate-100 text-slate-600'
                  : 'bg-amber-100 text-amber-900',
            )}
          >
            {i.blocking ? 'Blocking' : i.severity === 'info' ? 'Note' : 'Check'}
          </span>
          <span className="text-slate-700">
            {i.lineNo && <span className="font-medium">Line {i.lineNo}: </span>}
            {i.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function OrderDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const canReview = useHasRole('reviewer');
  const order = useQuery({
    queryKey: ['order', id],
    queryFn: () => api.get<OrderDetailDto>(`/api/orders/${id}`),
  });
  const rematch = useMutation({
    mutationFn: () => api.post(`/api/orders/${id}/rematch`),
    onSuccess: () => {
      toast.success('Re-matching against the current catalogue');
      setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ['orders'] });
        void qc.invalidateQueries({ queryKey: ['order-counts'] });
      }, 2500);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (order.isPending) return <FullPageSpinner />;
  if (order.isError) return <FormError message={errorMessage(order.error)} />;
  const o = order.data;
  const a = o.deliveryAddress;
  const lineIssues = (lineNo: number) =>
    o.issues.filter((i) => i.lineNo === lineNo && !i.resolved && i.severity !== 'info');

  return (
    <>
      <Link to="/orders" className="text-sm text-slate-500 hover:text-slate-800">
        &larr; Orders
      </Link>
      <div className="mt-2 mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-xl font-semibold text-slate-900">
            {o.customer.name ?? 'Unknown customer'}{' '}
            <span className="font-mono text-base font-normal text-slate-500">
              PO {o.poNumber ?? '-'}
            </span>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-600">
            <StatusPill status={o.status} colour={o.colour} />
            <span>{Math.round(o.confidence * 100)}% confidence</span>
            <span>Value {money(o.value, o.currency)}</span>
            <Link to={`/inbox/${o.email.id}`} className="text-brand-700 hover:underline">
              Email: {o.email.subject || '(no subject)'}
            </Link>
          </div>
        </div>
        {canReview && (
          <Button variant="secondary" loading={rematch.isPending} onClick={() => rematch.mutate()}>
            Re-match
          </Button>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="What to check" className="lg:col-span-2">
          <IssueList issues={o.issues} />
          {o.relatedEmails.length > 0 && (
            <div className="mt-4 border-t border-slate-100 pt-3 text-sm">
              <p className="font-medium text-slate-800">Changes received</p>
              <ul className="mt-1 space-y-1">
                {o.relatedEmails.map((r) => (
                  <li key={r.emailId}>
                    <Badge tone={r.kind === 'cancellation' ? 'red' : 'amber'}>{r.kind}</Badge>{' '}
                    <Link to={`/inbox/${r.emailId}`} className="text-brand-700 hover:underline">
                      {r.subject || 'View email'}
                    </Link>{' '}
                    <span className="text-xs text-slate-400">
                      {new Date(r.receivedAt).toLocaleString('en-GB')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
        <Card title="Customer">
          {o.customerMatch.customerId ? (
            <>
              <Link
                to={`/customers/${o.customerMatch.customerId}`}
                className="font-medium text-brand-700 hover:underline"
              >
                {o.customerMatch.name}
              </Link>{' '}
              <span className="font-mono text-xs text-slate-500">
                {o.customerMatch.accountCode}
              </span>
              <p className="mt-1 text-xs text-slate-500">
                Identified by {CUSTOMER_METHOD[o.customerMatch.method]} (
                {Math.round(o.customerMatch.confidence * 100)}%)
              </p>
            </>
          ) : (
            <p className="text-sm text-amber-800">
              Not identified from {o.email.from ?? 'the sender'}.
            </p>
          )}
          {o.customerMatch.candidates.length > 0 && !o.customerMatch.customerId && (
            <div className="mt-2 text-sm">
              <p className="text-xs text-slate-500">
                Closest matches (picking one arrives with the review screen in M6):
              </p>
              <ul className="mt-1">
                {o.customerMatch.candidates.map((c) => (
                  <li key={c.customerId}>
                    {c.name}{' '}
                    <span className="font-mono text-xs text-slate-400">{c.accountCode}</span>{' '}
                    <span className="text-xs text-slate-400">{Math.round(c.score * 100)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <dl className="mt-4 space-y-1 text-sm">
            <div>
              <dt className="inline text-slate-500">Order date: </dt>
              <dd className="inline">{o.orderDate ?? '-'}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500">Delivery: </dt>
              <dd className="inline">{o.requestedDeliveryDate ?? 'not requested'}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Deliver to:</dt>
              <dd>
                {[a.line1, a.line2, a.city, a.postcode].filter(Boolean).join(', ') ||
                  'account address'}
              </dd>
            </div>
            {o.notes && (
              <div>
                <dt className="inline text-slate-500">Notes: </dt>
                <dd className="inline">{o.notes}</dd>
              </div>
            )}
          </dl>
        </Card>
      </div>

      <Card
        title={`Lines (${o.lines.length})`}
        className="mt-4"
        description="What the customer wrote, and the product Keyless matched it to."
      >
        {o.lines.length === 0 ? (
          <p className="text-sm text-slate-500">No lines could be read.</p>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-y border-slate-100 bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2" />
                  <th className="px-3 py-2 font-medium">They ordered</th>
                  <th className="px-3 py-2 text-right font-medium">Qty</th>
                  <th className="px-3 py-2 font-medium">Matched product</th>
                  <th className="px-3 py-2 text-right font-medium">Our qty</th>
                  <th className="px-3 py-2 text-right font-medium">Their price</th>
                  <th className="px-3 py-2 text-right font-medium">Our price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {o.lines.map((l) => {
                  const problems = lineIssues(l.lineNo);
                  return (
                    <tr
                      key={l.id}
                      className={clsx(
                        'align-top',
                        l.colour === 'red' && 'bg-red-50/50',
                        l.colour === 'amber' && 'bg-amber-50/40',
                      )}
                    >
                      <td className="px-3 py-2">
                        <ColourDot colour={l.colour} className="mt-1" />
                      </td>
                      <td className="max-w-72 px-3 py-2">
                        {l.customerPartCode && (
                          <p className="font-mono text-xs font-medium">{l.customerPartCode}</p>
                        )}
                        <p className="text-slate-700">{l.description ?? '-'}</p>
                        {problems.map((p) => (
                          <p key={p.id} className="mt-0.5 text-xs text-amber-800">
                            {p.message}
                          </p>
                        ))}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        {l.quantity ?? <span className="text-red-600">?</span>}{' '}
                        {l.unit && <span className="text-xs text-slate-500">{l.unit}</span>}
                      </td>
                      <td className="max-w-80 px-3 py-2">
                        {l.match.sku ? (
                          <>
                            <p>
                              <span className="font-mono text-xs font-medium">{l.match.sku}</span>{' '}
                              <span className="text-xs text-slate-400">
                                {METHOD_LABEL[l.match.method]},{' '}
                                {Math.round(l.match.confidence * 100)}%
                              </span>
                            </p>
                            <p className="text-slate-700">{l.match.description}</p>
                          </>
                        ) : (
                          <p className="text-red-700">No match</p>
                        )}
                        {l.match.candidates.filter((c) => c.productId !== l.match.productId)
                          .length > 0 && (
                          <details className="mt-1 text-xs text-slate-500">
                            <summary className="cursor-pointer">Other candidates</summary>
                            <ul className="mt-1 space-y-0.5">
                              {l.match.candidates
                                .filter((c) => c.productId !== l.match.productId)
                                .map((c) => (
                                  <li key={c.productId}>
                                    <span className="font-mono">{c.sku}</span> {c.description}{' '}
                                    <span className="text-slate-400">
                                      ({Math.round(c.score * 100)}%)
                                    </span>
                                  </li>
                                ))}
                            </ul>
                          </details>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        {l.convertedQuantity ?? '-'}{' '}
                        {l.uom && (
                          <span className="text-xs text-slate-500">{l.uom.toLowerCase()}</span>
                        )}
                        {l.conversionFactor !== 1 && (
                          <p className="text-xs text-slate-400">
                            x{Number(l.conversionFactor.toFixed(4))}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">{money(l.unitPrice, o.currency)}</td>
                      <td className="px-3 py-2 text-right">
                        {money(l.expectedPrice, o.currency)}
                        {l.priceSource && (
                          <p className="text-xs text-slate-400">
                            {l.priceSource.replace('_', ' ')}
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-400">
          Read from {o.source.label}.{' '}
          {o.source.attachmentUrl && (
            <a
              href={o.source.attachmentUrl}
              target="_blank"
              rel="noreferrer"
              className="text-brand-700 hover:underline"
            >
              Open document
            </a>
          )}{' '}
          Editing, approving and side-by-side review arrive in M6.
        </p>
      </Card>
    </>
  );
}
