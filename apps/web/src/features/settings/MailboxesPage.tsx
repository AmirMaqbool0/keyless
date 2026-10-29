import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { MailboxesResponse } from '@keyless/shared';
import { relativeTime } from '../../components/data';
import { Badge, Button, Card, FullPageSpinner, PageHeader } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useHasRole } from '../../lib/session';

const STATUS_TONE = {
  active: 'green',
  paused: 'slate',
  error: 'red',
  disconnected: 'slate',
} as const;

export function MailboxesPage() {
  const isAdmin = useHasRole('admin');
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => api.get<MailboxesResponse>('/api/mailboxes'),
    refetchInterval: 10000,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['mailboxes'] });

  const activeMailbox =
    list.data?.items.find((m) => m.address.toLowerCase() === 'service@karamfoodproducts.com.pk') ??
    list.data?.items[0];

  const sync = useMutation({
    mutationFn: () =>
      api.post<{ success: boolean; result?: { seen: number; imported: number; duplicates: number } }>(
        `/api/mailboxes/sync`,
      ),
    onSuccess: (data) => {
      const imported = data?.result?.imported ?? 0;
      if (imported > 0) {
        toast.success(`Sync complete! Imported ${imported} new email order(s).`);
      } else {
        toast.success('Sync complete. Mailbox is up to date.');
      }
      refresh();
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['inbound-emails'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; status?: 'active' | 'paused'; folder?: string }) =>
      api.patch(`/api/mailboxes/${id}`, body),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (list.isPending) return <FullPageSpinner />;

  const displayAddress = 'service@karamfoodproducts.com.pk';
  const status = activeMailbox?.status ?? 'active';

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Email Settings & Order Inbox"
        description="Your dedicated business email where clients send and forward purchase orders."
      />

      {/* Main Order Inbox Card */}
      <Card
        title="Order Receiving Email Address"
        description="All customer order emails and PDF purchase orders sent or forwarded to this address are automatically ingested, parsed by AI, and converted into dashboard orders."
        actions={
          <div className="flex items-center gap-2">
            <Badge tone="indigo">Hostinger Direct IMAP</Badge>
            <Badge tone={STATUS_TONE[status]}>{status === 'active' ? 'Active & Receiving' : status}</Badge>
          </div>
        }
      >
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-4 rounded-xl bg-gradient-to-r from-slate-50 to-indigo-50/40 border border-slate-200">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white shadow-xs">
              <svg className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Official Inbound Address</p>
              <code className="text-base sm:text-lg font-bold font-mono text-slate-900 select-all tracking-tight">
                {displayAddress}
              </code>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(displayAddress);
                toast.success('Email address copied to clipboard');
              }}
            >
              <svg className="size-4 mr-1.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
              </svg>
              Copy
            </Button>

            {isAdmin && (
              <Button
                variant="primary"
                loading={sync.isPending}
                onClick={() => sync.mutate()}
              >
                <svg className="size-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Sync Now
              </Button>
            )}
          </div>
        </div>

        {/* Real-time Status Details */}
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="rounded-lg border border-slate-100 bg-white p-3">
            <span className="text-slate-500 block font-medium">Server Connection</span>
            <span className="font-semibold text-slate-900 mt-0.5 block font-mono">
              imap.hostinger.com:993 (SSL)
            </span>
          </div>

          <div className="rounded-lg border border-slate-100 bg-white p-3">
            <span className="text-slate-500 block font-medium">Automatic Polling</span>
            <span className="font-semibold text-emerald-700 mt-0.5 flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
              Auto-syncs every 60 seconds
            </span>
          </div>

          <div className="rounded-lg border border-slate-100 bg-white p-3">
            <span className="text-slate-500 block font-medium">Last Checked</span>
            <span className="font-semibold text-slate-800 mt-0.5 block">
              {relativeTime(activeMailbox?.lastSyncAt)}
            </span>
          </div>
        </div>

        {activeMailbox?.lastError && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            <strong>Connection Notice:</strong> {activeMailbox.lastError}
          </div>
        )}

        {isAdmin && activeMailbox && (
          <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <span>Mailbox Status: <strong className="text-slate-700 capitalize">{status}</strong></span>
            <Button
              variant="ghost"
              className="text-xs py-1 px-2.5 h-auto"
              onClick={() =>
                update.mutate({
                  id: activeMailbox.id,
                  status: status === 'paused' ? 'active' : 'paused',
                })
              }
            >
              {status === 'paused' ? 'Resume Auto-Sync' : 'Pause Auto-Sync'}
            </Button>
          </div>
        )}
      </Card>

      {/* How Customer Emails Work Card */}
      <Card
        title="How Customer Orders Are Processed"
        description="Clients and customers do not need to configure anything. Everything happens automatically."
      >
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-4">
            <div className="flex size-7 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 font-bold text-xs mb-2">
              1
            </div>
            <p className="text-sm font-semibold text-slate-900">Clients Send Orders</p>
            <p className="mt-1 text-xs text-slate-600 leading-relaxed">
              Customers email their purchase order (PDF, scanned invoice, or email body) directly to <strong className="text-slate-800 font-mono">service@karamfoodproducts.com.pk</strong>.
            </p>
          </div>

          <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-4">
            <div className="flex size-7 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 font-bold text-xs mb-2">
              2
            </div>
            <p className="text-sm font-semibold text-slate-900">Keyless Reads & Extracts</p>
            <p className="mt-1 text-xs text-slate-600 leading-relaxed">
              Keyless securely reads incoming emails, saves the PDF attachments, and extracts item codes, quantities, and totals using AI.
            </p>
          </div>

          <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-4">
            <div className="flex size-7 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 font-bold text-xs mb-2">
              3
            </div>
            <p className="text-sm font-semibold text-slate-900">Orders Created In Dashboard</p>
            <p className="mt-1 text-xs text-slate-600 leading-relaxed">
              Extracted orders are matched against your product catalogue and customers, and appear instantly in your <a href="/orders" className="text-brand-600 font-medium hover:underline">Orders</a> dashboard.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
