import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { MailboxDto, MailboxesResponse } from '@keyless/shared';
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

const FORWARDING_HELP = [
  {
    title: 'Microsoft 365 / Outlook',
    steps: [
      'Admin: Exchange admin centre > Mail flow > Rules > add a rule "Bcc the message to" your Keyless address for mail sent to your orders mailbox.',
      'Or, in Outlook on the web: Settings > Mail > Rules > New rule > "Forward to" your Keyless address.',
      'Tip: an admin rule keeps the original sender, which helps Keyless recognise the customer.',
    ],
  },
  {
    title: 'Gmail / Google Workspace',
    steps: [
      'Settings > See all settings > Forwarding and POP/IMAP > Add a forwarding address.',
      'Gmail sends a confirmation code: it appears in your Keyless inbox within a minute.',
      'Then create a filter (e.g. to: orders@yourcompany.co.uk) with "Forward it to" your Keyless address.',
    ],
  },
  {
    title: 'Anything else',
    steps: [
      'Set up automatic forwarding (not manual "Forward", which hides the customer) from your orders mailbox to your Keyless address.',
    ],
  },
];

export function MailboxesPage() {
  const isAdmin = useHasRole('admin');
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
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
  const sync = useMutation({
    mutationFn: (id: string) => api.post(`/api/mailboxes/${id}/sync`),
    onSuccess: () => {
      toast.success('Sync started');
      setTimeout(refresh, 3000);
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
        description="How order emails reach Keyless: forward them to your address, or connect the mailbox directly."
      />
      {forwarding && (
        <Card
          title="Your Keyless forwarding address"
          description="Emails sent or forwarded here appear in the inbox within seconds."
          actions={<Badge tone={STATUS_TONE[forwarding.status]}>{forwarding.status}</Badge>}
        >
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-md bg-slate-100 px-3 py-2 font-mono text-sm text-slate-900">
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
              <div key={h.title}>
                <p className="text-sm font-medium text-slate-800">{h.title}</p>
                <ol className="mt-1 list-decimal space-y-1 pl-4 text-xs text-slate-600">
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
        description="Keyless reads new mail every couple of minutes. Read-only: it never sends, moves or deletes."
      >
        {connected.length > 0 && (
          <ul className="mb-4 divide-y divide-slate-100">
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
          <div className="flex flex-wrap gap-3">
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
        {label} <span className="text-xs">(not configured: set {env})</span>
      </div>
    );
  }
  // A full-page navigation: the API redirects to the provider's sign-in page.
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
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium text-slate-900">
            {m.address} <Badge>{m.type === 'graph' ? 'Microsoft 365' : 'Gmail'}</Badge>{' '}
            <Badge tone={STATUS_TONE[m.status]}>{m.status}</Badge>
          </p>
          <p className="text-xs text-slate-500">
            Last checked {relativeTime(m.lastSyncAt)} - {m.type === 'graph' ? 'folder' : 'label'}{' '}
            {m.folder}
          </p>
          {m.lastError && <p className="mt-1 text-xs text-red-600">{m.lastError}</p>}
        </div>
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={onSync} disabled={m.status === 'paused'}>
              Sync now
            </Button>
            <Button variant="ghost" onClick={onPause}>
              {m.status === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            <Button variant="ghost" onClick={onRemove}>
              Disconnect
            </Button>
          </div>
        )}
      </div>
      {isAdmin && (
        <form
          className="mt-2 flex items-center gap-2 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            if (folder && folder !== m.folder) onFolder(folder);
          }}
        >
          <label className="text-slate-500">
            {m.type === 'graph' ? 'Folder (name like "inbox" or folder id)' : 'Gmail label id'}
            <input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              className="ml-2 rounded border border-slate-300 px-2 py-1"
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
