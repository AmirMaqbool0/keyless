import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { ConnectImapDto, MailboxDto, MailboxesResponse } from '@keyless/shared';
import { relativeTime } from '../../components/data';
import { Badge, Button, Card, FullPageSpinner, Modal, PageHeader } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useHasRole } from '../../lib/session';

const STATUS_TONE = {
  active: 'green',
  paused: 'slate',
  error: 'red',
  disconnected: 'slate',
} as const;

const FORWARDING_HELP = [
  {
    title: 'Hostinger / Webmail Direct Sync',
    steps: [
      'Connected natively via IMAP! Keyless checks service@karamfoodproducts.com.pk every minute.',
      'Clients can email orders directly to service@karamfoodproducts.com.pk.',
      'New customer purchase orders and PDF attachments are ingested automatically.',
    ],
  },
  {
    title: 'Microsoft 365 / Outlook',
    steps: [
      'Exchange admin centre > Mail flow > Rules > add a rule "Bcc the message to" your Keyless address.',
      'Or in Outlook Web: Settings > Mail > Rules > New rule > "Forward to" your Keyless address.',
    ],
  },
  {
    title: 'Gmail / Google Workspace',
    steps: [
      'Settings > See all settings > Forwarding and POP/IMAP > Add a forwarding address.',
      'Then create a filter (e.g. to: orders@yourcompany.com) with "Forward it to" your Keyless address.',
    ],
  },
];

export function MailboxesPage() {
  const isAdmin = useHasRole('admin');
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [showImapModal, setShowImapModal] = useState(false);
  const [imapForm, setImapForm] = useState<ConnectImapDto>({
    name: 'Hostinger Business Mail',
    host: 'imap.hostinger.com',
    port: 993,
    secure: true,
    user: 'service@karamfoodproducts.com.pk',
    pass: '4MM5by1d0+$v',
    folder: 'INBOX',
  });

  const list = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => api.get<MailboxesResponse>('/api/mailboxes'),
    refetchInterval: 10000,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['mailboxes'] });

  // Result of an OAuth round trip.
  useEffect(() => {
    const connected = params.get('connected');
    const error = params.get('error');
    if (connected) toast.success(`Connected ${connected}. Importing recent emails now.`);
    if (error) toast.error(error, { duration: 10000 });
    if (connected || error) setParams({}, { replace: true });
  }, [params, setParams]);

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; status?: 'active' | 'paused'; folder?: string }) =>
      api.patch(`/api/mailboxes/${id}`, body),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });

  const connectImap = useMutation({
    mutationFn: (body: ConnectImapDto) => api.post('/api/mailboxes/imap', body),
    onSuccess: () => {
      toast.success('Mailbox connected! Sync started.');
      setShowImapModal(false);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const sync = useMutation({
    mutationFn: (id: string) => api.post(`/api/mailboxes/${id}/sync`),
    onSuccess: () => {
      toast.success('Sync started');
      setTimeout(refresh, 2500);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/mailboxes/${id}`),
    onSuccess: () => {
      toast.success('Mailbox disconnected. Emails already imported are kept.');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (list.isPending) return <FullPageSpinner />;
  const forwarding = list.data?.items.find((m) => m.type === 'forwarding');
  const connected = list.data?.items.filter((m) => m.type !== 'forwarding') ?? [];
  const providers = list.data?.providers ?? { graph: false, gmail: false };

  return (
    <>
      <PageHeader
        title="Mailboxes"
        description="How order emails reach Keyless: direct connection via IMAP (Hostinger/cPanel), Microsoft 365, Gmail, or forwarding."
      />
      {forwarding && (
        <Card
          title="Forwarding address"
          description="Emails sent or forwarded here appear in the inbox within seconds."
          actions={<Badge tone={STATUS_TONE[forwarding.status]}>{forwarding.status}</Badge>}
        >
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-md bg-slate-100 px-3 py-2 font-mono text-sm text-slate-900 select-all">
              {forwarding.address}
            </code>
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(forwarding.address);
                toast.success('Address copied');
              }}
            >
              Copy
            </Button>
            {isAdmin && (
              <Button
                variant="ghost"
                onClick={() =>
                  update.mutate({
                    id: forwarding.id,
                    status: forwarding.status === 'paused' ? 'active' : 'paused',
                  })
                }
              >
                {forwarding.status === 'paused' ? 'Resume' : 'Pause'}
              </Button>
            )}
          </div>
          <div className="mt-5 grid gap-4 md:grid-cols-3">
            {FORWARDING_HELP.map((h) => (
              <div key={h.title} className="rounded-lg border border-slate-100 bg-slate-50/50 p-3">
                <p className="text-sm font-semibold text-slate-800">{h.title}</p>
                <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-xs text-slate-600">
                  {h.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card
        className="mt-6"
        title="Connected mailboxes"
        description="Keyless polls connected mailboxes automatically every 1-2 minutes for new customer orders. Read-only: it never deletes or modifies your emails."
      >
        {connected.length > 0 && (
          <ul className="mb-6 divide-y divide-slate-100 border-b border-slate-100">
            {connected.map((m) => (
              <ConnectedMailbox
                key={m.id}
                mailbox={m}
                isAdmin={isAdmin}
                onSync={() => sync.mutate(m.id)}
                onPause={() =>
                  update.mutate({ id: m.id, status: m.status === 'paused' ? 'active' : 'paused' })
                }
                onFolder={(folder) => update.mutate({ id: m.id, folder })}
                onRemove={() => {
                  if (confirm(`Disconnect ${m.address}? Emails already imported stay in Keyless.`))
                    remove.mutate(m.id);
                }}
              />
            ))}
          </ul>
        )}
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => setShowImapModal(true)}
              className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-sm hover:from-blue-700 hover:to-indigo-700"
            >
              <svg className="size-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Connect Hostinger / Custom Email
            </Button>
            <ConnectButton
              provider="graph"
              label="Connect Microsoft 365"
              configured={providers.graph}
              env="MS_CLIENT_ID and MS_CLIENT_SECRET"
            />
            <ConnectButton
              provider="gmail"
              label="Connect Gmail"
              configured={providers.gmail}
              env="GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET"
            />
          </div>
        )}
        {!connected.length && !isAdmin && (
          <p className="text-sm text-slate-500">
            No mailboxes connected. An admin can connect one.
          </p>
        )}
      </Card>

      <Modal
        open={showImapModal}
        onClose={() => setShowImapModal(false)}
        title="Connect Hostinger or Custom IMAP Mailbox"
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            connectImap.mutate(imapForm);
          }}
        >
          <p className="text-xs text-slate-500">
            Keyless securely encrypts these credentials with AES-256-GCM. We only read incoming messages and download attached purchase orders.
          </p>

          <div>
            <label className="block text-xs font-medium text-slate-700">Account Name</label>
            <input
              type="text"
              required
              value={imapForm.name}
              onChange={(e) => setImapForm({ ...imapForm, name: e.target.value })}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              placeholder="e.g. Hostinger Business Mail"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-700">IMAP Host</label>
              <input
                type="text"
                required
                value={imapForm.host}
                onChange={(e) => setImapForm({ ...imapForm, host: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
                placeholder="imap.hostinger.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">Port</label>
              <input
                type="number"
                required
                value={imapForm.port}
                onChange={(e) => setImapForm({ ...imapForm, port: parseInt(e.target.value, 10) || 993 })}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700">Email Address (Username)</label>
            <input
              type="email"
              required
              value={imapForm.user}
              onChange={(e) => setImapForm({ ...imapForm, user: e.target.value })}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              placeholder="service@karamfoodproducts.com.pk"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700">Password / App Password</label>
            <input
              type="password"
              required
              value={imapForm.pass}
              onChange={(e) => setImapForm({ ...imapForm, pass: e.target.value })}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
            />
          </div>

          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="block text-xs font-medium text-slate-700">Folder</label>
              <input
                type="text"
                value={imapForm.folder}
                onChange={(e) => setImapForm({ ...imapForm, folder: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
            <label className="flex items-center gap-2 pt-5 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={imapForm.secure}
                onChange={(e) => setImapForm({ ...imapForm, secure: e.target.checked })}
                className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              SSL / TLS
            </label>
          </div>

          <div className="mt-5 flex justify-end gap-2 pt-2 border-t border-slate-100">
            <Button variant="secondary" type="button" onClick={() => setShowImapModal(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={connectImap.isPending}>
              Save & Test Connection
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

function ConnectButton({
  provider,
  label,
  configured,
  env,
}: {
  provider: string;
  label: string;
  configured: boolean;
  env: string;
}) {
  if (!configured) {
    return (
      <div
        className="rounded-md border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-500"
        title={`Set ${env} on the server`}
      >
        {label} <span className="text-xs">(OAuth: set {env})</span>
      </div>
    );
  }
  return (
    <a href={`/api/mailboxes/oauth/${provider}/start`}>
      <Button>{label}</Button>
    </a>
  );
}

function ConnectedMailbox({
  mailbox: m,
  isAdmin,
  onSync,
  onPause,
  onFolder,
  onRemove,
}: {
  mailbox: MailboxDto;
  isAdmin: boolean;
  onSync: () => void;
  onPause: () => void;
  onFolder: (folder: string) => void;
  onRemove: () => void;
}) {
  const [folder, setFolder] = useState(m.folder ?? '');
  const providerLabel =
    m.type === 'graph' ? 'Microsoft 365' : m.type === 'gmail' ? 'Gmail' : 'Hostinger / IMAP';

  return (
    <li className="py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-900">{m.address}</span>
            <Badge tone="indigo">{providerLabel}</Badge>
            <Badge tone={STATUS_TONE[m.status]}>{m.status}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            Last checked {relativeTime(m.lastSyncAt)} - folder: <span className="font-mono">{m.folder || 'INBOX'}</span>
          </p>
          {m.lastError && (
            <p className="mt-1 text-xs text-red-600 bg-red-50 rounded px-2 py-0.5 inline-block border border-red-100">
              {m.lastError}
            </p>
          )}
        </div>
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={onSync} disabled={m.status === 'paused'}>
              Sync now
            </Button>
            <Button variant="ghost" onClick={onPause}>
              {m.status === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            <Button variant="ghost" className="text-red-600 hover:text-red-700" onClick={onRemove}>
              Disconnect
            </Button>
          </div>
        )}
      </div>
      {isAdmin && (
        <form
          className="mt-2.5 flex items-center gap-2 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            if (folder && folder !== m.folder) onFolder(folder);
          }}
        >
          <label className="text-slate-500 flex items-center gap-2">
            <span>Folder name:</span>
            <input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1 text-xs font-mono"
            />
          </label>
          <Button variant="ghost" type="submit" disabled={!folder || folder === m.folder}>
            Save
          </Button>
        </form>
      )}
    </li>
  );
}
