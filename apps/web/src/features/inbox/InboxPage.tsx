import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { EmailListItemDto, Paginated } from '@keyless/shared';
import {
  DataTable,
  NoResults,
  Pagination,
  SearchInput,
  relativeTime,
  useDebounced,
} from '../../components/data';
import { Button, PageHeader, Spinner } from '../../components/ui';
import { api, errorMessage, qs } from '../../lib/api';
import { useHasRole } from '../../lib/session';
import { ClassificationBadge } from './ClassificationBadge';

const VIEWS = [
  { key: 'all', label: 'All' },
  { key: 'orders', label: 'Orders' },
  { key: 'other', label: 'Other emails' },
  { key: 'failed', label: 'Failed' },
] as const;
type View = (typeof VIEWS)[number]['key'];

type Counts = { byLabel: Record<string, number>; failed: number };
type UploadResult = {
  results: { filename: string; emailId?: string; duplicate?: boolean; error?: string }[];
};

const SCENARIOS = [
  ['pdf_po', 'PO as PDF'],
  ['csv_po', 'PO as CSV'],
  ['body_order', 'Order in email body'],
  ['amendment', 'Amendment'],
  ['cancellation', 'Cancellation'],
  ['quote_request', 'Quote request'],
  ['delivery_query', 'Delivery query'],
  ['out_of_office', 'Out of office'],
] as const;

export function InboxPage() {
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.find((v) => v.key === params.get('view'))?.key ?? 'all') as View;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canUpload = useHasRole('reviewer');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const query = useDebounced(q);

  const emails = useQuery({
    queryKey: ['emails', view, query, page],
    queryFn: () =>
      api.get<Paginated<EmailListItemDto>>(
        `/api/emails${qs({ view, q: query, page, pageSize: 50 })}`,
      ),
    placeholderData: keepPreviousData,
    // Keep polling while anything is still being processed.
    refetchInterval: (query) =>
      query.state.data?.items.some((e) => e.status === 'received' || e.status === 'parsed')
        ? 2000
        : 15000,
  });
  const counts = useQuery({
    queryKey: ['email-counts'],
    queryFn: () => api.get<Counts>('/api/emails/counts'),
    refetchInterval: 15000,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['emails'] });
    void qc.invalidateQueries({ queryKey: ['email-counts'] });
  };

  const total = counts.data
    ? Object.values(counts.data.byLabel).reduce((a, b) => a + b, 0)
    : undefined;
  const countFor: Record<View, number | undefined> = {
    all: total,
    orders: counts.data?.byLabel.new_order ?? 0,
    other: counts.data
      ? Object.entries(counts.data.byLabel)
          .filter(([k]) => k !== 'new_order' && k !== 'unclassified')
          .reduce((a, [, n]) => a + n, 0)
      : undefined,
    failed: counts.data?.failed,
  };

  return (
    <>
      <PageHeader
        title="Inbox"
        description="Every email Keyless receives, sorted into orders and everything else."
        actions={canUpload && <InboxActions onDone={refresh} />}
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex gap-1 rounded-lg bg-slate-100 p-1" aria-label="Email views">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => {
                setParams(v.key === 'all' ? {} : { view: v.key });
                setPage(1);
              }}
              className={clsx(
                'rounded-md px-3 py-1.5 text-sm font-medium',
                view === v.key
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900',
              )}
            >
              {v.label}
              {countFor[v.key] !== undefined && (
                <span className="ml-1.5 text-xs text-slate-400">{countFor[v.key]}</span>
              )}
            </button>
          ))}
        </nav>
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search subject or sender"
        />
      </div>
      {canUpload ? <UploadZone onDone={refresh}>{list()}</UploadZone> : list()}
    </>
  );

  function list() {
    return (
      <>
        <DataTable
          loading={emails.isFetching && !emails.data}
          rows={emails.data?.items}
          rowKey={(e) => e.id}
          onRowClick={(e) => navigate(`/inbox/${e.id}`)}
          empty={
            <NoResults query={query}>
              {!query && (
                <>
                  Forward order emails to your Keyless address (see{' '}
                  <a href="/settings/mailboxes" className="text-brand-700 hover:underline">
                    Mailboxes
                  </a>
                  ), connect a mailbox, or drop files here.
                </>
              )}
            </NoResults>
          }
          columns={[
            {
              header: 'From',
              cell: (e) => (
                <div className="max-w-48">
                  <p className="truncate font-medium text-slate-900">
                    {e.from.name || e.from.address || '-'}
                  </p>
                  {e.from.name && (
                    <p className="truncate text-xs text-slate-500">{e.from.address}</p>
                  )}
                </div>
              ),
            },
            {
              header: 'Subject',
              cell: (e) => (
                <div className="min-w-64">
                  <p className="text-slate-900">
                    {e.subject}
                    {e.attachmentCount > 0 && (
                      <span
                        className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500"
                        title="Attachments"
                      >
                        {e.attachmentCount} file{e.attachmentCount > 1 ? 's' : ''}
                      </span>
                    )}
                  </p>
                  <p className="line-clamp-1 text-xs text-slate-500">{e.error ?? e.snippet}</p>
                </div>
              ),
            },
            {
              header: 'Type',
              cell: (e) => (
                <ClassificationBadge classification={e.classification} status={e.status} />
              ),
            },
            {
              header: 'Via',
              cell: (e) => <span className="text-xs text-slate-500">{e.source}</span>,
            },
            {
              header: 'Received',
              cell: (e) => (
                <span className="whitespace-nowrap text-slate-500">
                  {relativeTime(e.receivedAt)}
                </span>
              ),
            },
          ]}
        />
        {emails.data && (
          <Pagination page={page} pageSize={50} total={emails.data.total} onPage={setPage} />
        )}
      </>
    );
  }
}

async function uploadFiles(files: File[]): Promise<UploadResult> {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  return api.upload<UploadResult>('/api/emails/upload', form);
}

function reportUpload({ results }: UploadResult) {
  for (const r of results) {
    if (r.error) toast.error(`${r.filename}: ${r.error}`);
    else if (r.duplicate) toast.info(`${r.filename} was already in the inbox`);
  }
  const added = results.filter((r) => r.emailId && !r.duplicate).length;
  if (added) toast.success(`${added} file${added > 1 ? 's' : ''} added - processing now`);
}

/** The whole list is a drop target for .eml files and order documents. */
function UploadZone({ children, onDone }: { children: React.ReactNode; onDone: () => void }) {
  const [over, setOver] = useState(false);
  const upload = useMutation({
    mutationFn: uploadFiles,
    onSuccess: (r) => (reportUpload(r), onDone()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div
      className={clsx('relative rounded-lg', over && 'ring-2 ring-brand-500 ring-offset-4')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length) upload.mutate([...e.dataTransfer.files]);
      }}
    >
      {children}
      {(over || upload.isPending) && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-white/80 text-sm font-medium text-brand-700">
          {upload.isPending ? (
            <span className="flex items-center gap-2">
              <Spinner /> Uploading...
            </span>
          ) : (
            'Drop .eml files or order documents to add them'
          )}
        </div>
      )}
    </div>
  );
}

function InboxActions({ onDone }: { onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [scenario, setScenario] = useState<string>('pdf_po');
  const upload = useMutation({
    mutationFn: uploadFiles,
    onSuccess: (r) => (reportUpload(r), onDone()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const test = useMutation({
    mutationFn: () => api.post('/api/dev/test-email', { scenario }),
    onSuccess: () => {
      toast.success('Test email sent to your forwarding address');
      onDone();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {import.meta.env.DEV && (
        <div className="flex items-center gap-1 rounded-md border border-dashed border-slate-300 p-1">
          <select
            aria-label="Test email type"
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
            className="rounded border-0 bg-transparent py-1 text-sm"
          >
            {SCENARIOS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <Button variant="ghost" loading={test.isPending} onClick={() => test.mutate()}>
            Send test email
          </Button>
        </div>
      )}
      <Button onClick={() => input.current?.click()} loading={upload.isPending}>
        Upload files
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept=".eml,.pdf,.csv,.xlsx,.xls,.png,.jpg,.jpeg,.heic,.tif,.tiff,.doc,.docx,.txt"
        onChange={(e) => {
          if (e.target.files?.length) upload.mutate([...e.target.files]);
          e.target.value = '';
        }}
      />
    </div>
  );
}
