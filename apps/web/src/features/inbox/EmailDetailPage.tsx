import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import {
  CLASSIFICATION_LABELS,
  EMAIL_CLASSIFICATIONS,
  type AttachmentDto,
  type EmailClassification,
  type EmailDetailDto,
} from '@keyless/shared';
import { Badge, Button, Card, FormError, FullPageSpinner } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useHasRole } from '../../lib/session';
import { ClassificationBadge } from './ClassificationBadge';
import { ExtractedOrders } from './ExtractedOrders';
import { StatusPill } from '../orders/OrderBits';

const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * HTML email bodies are shown in a sandboxed iframe: no scripts, no access to our origin, and a
 * CSP that blocks remote images (tracking pixels) and other network loads.
 */
function htmlDocument(html: string): string {
  const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{font-family:system-ui,sans-serif;font-size:14px;color:#0f172a;margin:12px}</style></head><body>${html}</body></html>`;
}

function Preview({ attachment }: { attachment: AttachmentDto }) {
  if (attachment.kind === 'pdf')
    return (
      <iframe
        title={attachment.filename}
        src={attachment.url}
        className="h-[70vh] w-full rounded border border-slate-200"
      />
    );
  if (attachment.kind === 'image')
    return (
      <img
        src={attachment.url}
        alt={attachment.filename}
        className="max-h-[70vh] rounded border border-slate-200"
      />
    );
  return <p className="text-sm text-slate-500">No preview for this file type. Open it to view.</p>;
}

export function EmailDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const canReview = useHasRole('reviewer');
  const isAdmin = useHasRole('admin');
  const [bodyTab, setBodyTab] = useState<'text' | 'html'>('text');
  const [previewId, setPreviewId] = useState<string | null>(null);

  const email = useQuery({
    queryKey: ['email', id],
    queryFn: () => api.get<EmailDetailDto>(`/api/emails/${id}`),
    refetchInterval: (q) =>
      q.state.data &&
      (['received', 'parsed'].includes(q.state.data.status) ||
        q.state.data.extraction?.status === 'running')
        ? 1500
        : false,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['email', id] });
    void qc.invalidateQueries({ queryKey: ['emails'] });
    void qc.invalidateQueries({ queryKey: ['email-counts'] });
  };
  const reclassify = useMutation({
    mutationFn: (label: EmailClassification) => api.post(`/api/emails/${id}/reclassify`, { label }),
    onSuccess: () => {
      toast.success('Classification updated');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const extract = useMutation({
    mutationFn: () => api.post(`/api/emails/${id}/extract`),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  });
  const reprocess = useMutation({
    mutationFn: () => api.post(`/api/emails/${id}/reprocess`),
    onSuccess: () => {
      toast.success('Reprocessing');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (email.isPending) return <FullPageSpinner />;
  if (email.isError) return <FormError message={errorMessage(email.error)} />;
  const e = email.data;
  const docs = e.attachments.filter((a) => !a.isInline);
  const inline = e.attachments.filter((a) => a.isInline);
  const preview =
    docs.find((a) => a.id === previewId) ??
    docs.find((a) => a.kind === 'pdf' || a.kind === 'image');

  return (
    <>
      <Link to="/inbox" className="text-sm text-slate-500 hover:text-slate-800">
        &larr; Inbox
      </Link>
      <div className="mt-2 mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-slate-900">{e.subject}</h1>
          <p className="mt-1 text-sm text-slate-600">
            <strong>{e.from.name ?? e.from.address}</strong>{' '}
            {e.from.name && <span className="text-slate-400">&lt;{e.from.address}&gt;</span>}
          </p>
          <p className="text-xs text-slate-500">
            {new Date(e.receivedAt).toLocaleString()} - via {e.source}
            {e.mailbox && ` (${e.mailbox.address})`}
            {e.to.length > 0 && ` - to ${e.to.join(', ')}`}
          </p>
        </div>
        <div className="flex gap-2">
          <a href={e.rawUrl}>
            <Button variant="secondary">Download .eml</Button>
          </a>
          {isAdmin && (
            <Button
              variant="secondary"
              loading={reprocess.isPending}
              onClick={() => reprocess.mutate()}
            >
              Reprocess
            </Button>
          )}
        </div>
      </div>

      {e.error && <FormError message={e.error} />}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {e.orders.length > 0 && (
            <Card
              title={e.orders.some((o) => o.relation === 'changes') ? 'Orders' : 'Orders created'}
            >
              <ul className="space-y-2 text-sm">
                {e.orders.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center gap-3">
                    <StatusPill status={o.status} colour={o.colour} />
                    <Link
                      to={`/orders/${o.id}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      PO {o.poNumber ?? '(no number)'}
                    </Link>
                    {o.relation === 'changes' && (
                      <span className="text-xs text-slate-500">this email changes it</span>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {(e.extraction || e.extractions.length > 0) && (
            <ExtractedOrders
              extractions={e.extractions}
              running={e.extraction?.status === 'running' || extract.isPending}
              canReextract={canReview}
              onReextract={() => extract.mutate()}
            />
          )}
          {docs.length > 0 && (
            <Card title={`Attachments (${docs.length})`}>
              <ul className="mb-4 flex flex-wrap gap-2">
                {docs.map((a) => (
                  <li key={a.id}>
                    <button
                      onClick={() => setPreviewId(a.id)}
                      className={clsx(
                        'rounded-md border px-3 py-1.5 text-left text-sm',
                        preview?.id === a.id
                          ? 'border-brand-500 bg-brand-50'
                          : 'border-slate-200 hover:bg-slate-50',
                      )}
                    >
                      <span className="font-medium">{a.filename}</span>
                      <span className="ml-2 text-xs text-slate-500">
                        {a.kind} - {formatSize(a.size)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {preview ? (
                <>
                  <Preview attachment={preview} />
                  <a
                    href={preview.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block text-sm text-brand-700 hover:underline"
                  >
                    Open in new tab
                  </a>
                </>
              ) : (
                <p className="text-sm text-slate-500">Choose a file to preview.</p>
              )}
            </Card>
          )}

          <Card
            title="Message"
            actions={
              e.html && (
                <div className="flex gap-1 text-sm">
                  {(['text', 'html'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setBodyTab(t)}
                      className={clsx(
                        'rounded px-2 py-1',
                        bodyTab === t ? 'bg-slate-100 font-medium' : 'text-slate-500',
                      )}
                    >
                      {t === 'text' ? 'Text' : 'Formatted'}
                    </button>
                  ))}
                </div>
              )
            }
          >
            {bodyTab === 'html' && e.html ? (
              <iframe
                title="Email body"
                sandbox=""
                srcDoc={htmlDocument(e.html)}
                className="h-[60vh] w-full rounded border border-slate-200"
              />
            ) : (
              <pre className="whitespace-pre-wrap font-sans text-sm text-slate-800">
                {e.text || '(no text body)'}
              </pre>
            )}
            {inline.length > 0 && (
              <p className="mt-3 text-xs text-slate-400">
                {inline.length} inline image(s) (signatures/logos) hidden.
              </p>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Classification">
            <ClassificationBadge classification={e.classification} status={e.status} />
            {e.classification && (
              <ul className="mt-3 space-y-1 text-sm text-slate-600">
                {e.classification.reasons.map((r, i) => (
                  <li key={i}>- {r}</li>
                ))}
              </ul>
            )}
            {canReview && e.status !== 'received' && (
              <label className="mt-4 block text-sm">
                <span className="font-medium text-slate-700">Correct it</span>
                <select
                  className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
                  value={e.classification?.label ?? ''}
                  disabled={reclassify.isPending}
                  onChange={(ev) => reclassify.mutate(ev.target.value as EmailClassification)}
                >
                  {!e.classification && <option value="">Choose...</option>}
                  {EMAIL_CLASSIFICATIONS.map((c) => (
                    <option key={c} value={c}>
                      {CLASSIFICATION_LABELS[c]}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </Card>

          <Card title="Activity">
            <ol className="space-y-3 text-sm">
              {e.timeline.map((t, i) => (
                <li key={i} className="border-l-2 border-slate-200 pl-3">
                  <p className="font-medium text-slate-800">{t.event}</p>
                  {t.detail && <p className="text-slate-500">{t.detail}</p>}
                  <p className="text-xs text-slate-400">{new Date(t.at).toLocaleString()}</p>
                </li>
              ))}
            </ol>
          </Card>

          <Card title="Details">
            <dl className="space-y-1 text-xs text-slate-500">
              <div>
                <dt className="inline font-medium">Message-ID: </dt>
                <dd className="inline break-all">{e.messageId ?? '-'}</dd>
              </div>
              {e.cc.length > 0 && (
                <div>
                  <dt className="inline font-medium">Cc: </dt>
                  <dd className="inline">{e.cc.join(', ')}</dd>
                </div>
              )}
              <div>
                <dt className="inline font-medium">Status: </dt>
                <dd className="inline">
                  <Badge>{e.status}</Badge>
                </dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}
