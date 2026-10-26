import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ConnectorDto, SyncResult } from '@keyless/shared';
import { relativeTime } from '../../components/data';
import { Badge, Button, Card, PageHeader, Spinner } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useHasRole } from '../../lib/session';

type ListResponse = { items: ConnectorDto[]; available: string[] };

const UPCOMING = [
  { name: 'CSV export', note: 'Any system that can import a CSV. M7.' },
  { name: 'Unleashed', note: 'M7' },
  { name: 'Cin7 Core', note: 'M7' },
  { name: 'QuickBooks Online', note: 'M7' },
];

export function IntegrationsPage() {
  const isAdmin = useHasRole('admin');
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['connectors'],
    queryFn: () => api.get<ListResponse>('/api/connectors'),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['connectors'] });
    for (const key of ['products', 'customers', 'cross-references'])
      void qc.invalidateQueries({ queryKey: [key] });
  };

  const add = useMutation({
    mutationFn: () => api.post('/api/connectors', { type: 'mock' }),
    onSuccess: () => {
      toast.success('Demo ERP connected');
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const sync = useMutation({
    mutationFn: ({ id, entities }: { id: string; entities?: string[] }) =>
      api.post<{ results: SyncResult[] }>(
        `/api/connectors/${id}/sync`,
        entities ? { entities } : {},
      ),
    onSuccess: ({ results }) => {
      const failed = results.filter((r) => r.errors.length);
      if (failed.length)
        toast.warning(`Sync finished with problems in ${failed.map((r) => r.entity).join(', ')}`);
      else toast.success('Sync complete');
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/connectors/${id}`),
    onSuccess: () => {
      toast.success('Disconnected. Synced data was kept.');
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const hasMock = list.data?.items.some((c) => c.type === 'mock');

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connect the system your orders go into. Synced products, customers and prices keep Keyless matching accurately."
      />
      {list.isPending ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          {list.data?.items.map((c) => (
            <Card
              key={c.id}
              title={
                <span className="flex items-center gap-2">
                  {c.name} {c.isDefault && <Badge tone="brand">Default</Badge>}
                </span>
              }
              description={`Last sync: ${relativeTime(c.lastSyncAt)}`}
              actions={
                c.status === 'connected' ? (
                  <Badge tone="green">Connected</Badge>
                ) : (
                  <Badge tone="red">{c.status}</Badge>
                )
              }
            >
              {c.lastError && <p className="mb-3 text-sm text-red-600">{c.lastError}</p>}
              {c.lastSyncResults.length > 0 && (
                <table className="mb-4 w-full max-w-xl text-left text-sm">
                  <thead className="text-xs uppercase text-slate-500">
                    <tr>
                      <th className="py-1 font-medium">Synced</th>
                      <th className="py-1 text-right font-medium">New</th>
                      <th className="py-1 text-right font-medium">Updated</th>
                      <th className="py-1 text-right font-medium">Deactivated</th>
                      <th className="py-1 text-right font-medium">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.lastSyncResults.map((r) => (
                      <tr key={r.entity} className={r.errors.length ? 'text-red-700' : ''}>
                        <td className="py-1 capitalize">{r.entity}</td>
                        <td className="py-1 text-right">{r.created.toLocaleString()}</td>
                        <td className="py-1 text-right">{r.updated.toLocaleString()}</td>
                        <td className="py-1 text-right">{r.deactivated.toLocaleString()}</td>
                        <td className="py-1 text-right">{(r.durationMs / 1000).toFixed(1)}s</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {isAdmin && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    loading={
                      sync.isPending && sync.variables?.id === c.id && !sync.variables.entities
                    }
                    onClick={() => sync.mutate({ id: c.id })}
                  >
                    Sync everything
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={sync.isPending}
                    onClick={() => sync.mutate({ id: c.id, entities: ['stock'] })}
                  >
                    Sync stock only
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (
                        confirm(
                          `Disconnect ${c.name}? Products and customers already synced stay in Keyless.`,
                        )
                      )
                        remove.mutate(c.id);
                    }}
                  >
                    Disconnect
                  </Button>
                </div>
              )}
            </Card>
          ))}

          <Card title="Add a connection">
            <ul className="divide-y divide-slate-100">
              <li className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium text-slate-900">Demo ERP</p>
                  <p className="text-sm text-slate-500">
                    A fake system with 5,000 products and 60 customers, for trying Keyless end to
                    end.
                  </p>
                </div>
                {isAdmin && !hasMock && (
                  <Button onClick={() => add.mutate()} loading={add.isPending}>
                    Connect
                  </Button>
                )}
                {hasMock && <Badge tone="green">Connected</Badge>}
              </li>
              {UPCOMING.map((u) => (
                <li key={u.name} className="flex items-center justify-between py-3">
                  <div>
                    <p className="font-medium text-slate-900">{u.name}</p>
                    <p className="text-sm text-slate-500">{u.note}</p>
                  </div>
                  <Badge>Coming soon</Badge>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-slate-500">
              No integration yet? Use CSV imports from the Products and Customers pages.
            </p>
          </Card>
        </div>
      )}
    </>
  );
}
