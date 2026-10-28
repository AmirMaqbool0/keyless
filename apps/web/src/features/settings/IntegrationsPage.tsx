import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ConnectorDto, ConnectorType, SyncResult } from '@keyless/shared';
import { relativeTime } from '../../components/data';
import { Badge, Button, Card, Modal, PageHeader, SelectField, Spinner, TextField } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useHasRole } from '../../lib/session';

type ListResponse = { items: ConnectorDto[]; available: string[] };

type ConnectorOption = {
  type: ConnectorType;
  name: string;
  description: string;
};

const CONNECTOR_OPTIONS: ConnectorOption[] = [
  {
    type: 'mock',
    name: 'Demo ERP (mock)',
    description: 'A mock system with 5,000 products and 60 customers for trying Keyless end to end.',
  },
  {
    type: 'csv_export',
    name: 'CSV Export',
    description: 'Export validated orders into RFC-compliant CSV files in cloud or local storage for import into any ERP.',
  },
  {
    type: 'unleashed',
    name: 'Unleashed',
    description: 'Direct REST API connection with HMAC-SHA256 signatures for stock, customers, and sales order creation.',
  },
  {
    type: 'cin7_core',
    name: 'Cin7 Core',
    description: 'Cin7 Core (formerly DEAR) integration for catalogue sync and automated sales order generation.',
  },
  {
    type: 'quickbooks_online',
    name: 'QuickBooks Online',
    description: 'QuickBooks Online integration creating Estimates or Invoices via OAuth 2.0.',
  },
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

  // Connect modal state
  const [modalType, setModalType] = useState<string | null>(null);
  const [connName, setConnName] = useState('');
  // Unleashed
  const [unleashedApiId, setUnleashedApiId] = useState('');
  const [unleashedApiKey, setUnleashedApiKey] = useState('');
  // Cin7
  const [cin7AccountId, setCin7AccountId] = useState('');
  const [cin7AppKey, setCin7AppKey] = useState('');
  // QBO
  const [qboRealmId, setQboRealmId] = useState('');
  const [qboAccessToken, setQboAccessToken] = useState('');
  const [qboDocType, setQboDocType] = useState('estimate');
  // CSV
  const [csvDelimiter, setCsvDelimiter] = useState(',');
  const [csvFolder, setCsvFolder] = useState('exports');

  const add = useMutation({
    mutationFn: (payload: {
      type: string;
      name?: string;
      credentials?: Record<string, unknown>;
      settings?: Record<string, unknown>;
    }) => api.post('/api/connectors', payload),
    onSuccess: () => {
      toast.success('Connector added successfully');
      setModalType(null);
      resetForm();
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const testConn = useMutation({
    mutationFn: (id: string) =>
      api.post<{ result: { ok: boolean; message: string } }>(`/api/connectors/${id}/test`),
    onSuccess: (res) => {
      if (res.result.ok) {
        toast.success(`Connection test passed: ${res.result.message}`);
      } else {
        toast.error(`Connection test failed: ${res.result.message}`);
      }
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const makeDefault = useMutation({
    mutationFn: (id: string) => api.patch(`/api/connectors/${id}`, { isDefault: true }),
    onSuccess: () => {
      toast.success('Default connector updated');
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

  function resetForm() {
    setConnName('');
    setUnleashedApiId('');
    setUnleashedApiKey('');
    setCin7AccountId('');
    setCin7AppKey('');
    setQboRealmId('');
    setQboAccessToken('');
    setQboDocType('estimate');
    setCsvDelimiter(',');
    setCsvFolder('exports');
  }

  function handleOpenModal(type: string) {
    resetForm();
    if (type === 'mock') {
      add.mutate({ type: 'mock', name: 'Demo ERP' });
      return;
    }
    const def = CONNECTOR_OPTIONS.find((c) => c.type === type);
    setConnName(def?.name ?? '');
    setModalType(type);
  }

  function handleSubmitConnection(e: React.FormEvent) {
    e.preventDefault();
    if (!modalType) return;

    if (modalType === 'csv_export') {
      add.mutate({
        type: 'csv_export',
        name: connName || 'CSV Export',
        settings: { delimiter: csvDelimiter, folder: csvFolder },
      });
    } else if (modalType === 'unleashed') {
      if (!unleashedApiId || !unleashedApiKey) {
        toast.error('API ID and API Key are required');
        return;
      }
      add.mutate({
        type: 'unleashed',
        name: connName || 'Unleashed',
        credentials: { apiId: unleashedApiId, apiKey: unleashedApiKey },
      });
    } else if (modalType === 'cin7_core') {
      if (!cin7AccountId || !cin7AppKey) {
        toast.error('Account ID and Application Key are required');
        return;
      }
      add.mutate({
        type: 'cin7_core',
        name: connName || 'Cin7 Core',
        credentials: { accountId: cin7AccountId, applicationKey: cin7AppKey },
      });
    } else if (modalType === 'quickbooks_online') {
      if (!qboRealmId || !qboAccessToken) {
        toast.error('Realm ID (Company ID) and Access Token are required');
        return;
      }
      add.mutate({
        type: 'quickbooks_online',
        name: connName || 'QuickBooks Online',
        credentials: { realmId: qboRealmId, accessToken: qboAccessToken },
        settings: { documentType: qboDocType },
      });
    }
  }

  const connectedTypes = new Set(list.data?.items.map((c) => c.type) ?? []);

  return (
    <>
      <PageHeader
        title="Integrations &amp; ERP Connectors"
        description="Connect the ERP or system your sales orders push into. Synced products, customers and prices keep Keyless matching accurately."
      />
      {list.isPending ? (
        <Spinner />
      ) : (
        <div className="space-y-6">
          {/* Active Connectors */}
          {list.data?.items.map((c) => (
            <Card
              key={c.id}
              title={
                <span className="flex items-center gap-2">
                  <span className="font-semibold text-slate-900">{c.name}</span>
                  {c.isDefault && (
                    <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700 border border-brand-200">
                      Default Connector
                    </span>
                  )}
                </span>
              }
              description={`Type: ${c.type} &bull; Last sync: ${relativeTime(c.lastSyncAt)}`}
              actions={
                <div className="flex items-center gap-2">
                  {c.status === 'connected' ? (
                    <Badge tone="green">Connected</Badge>
                  ) : (
                    <Badge tone="red">{c.status}</Badge>
                  )}
                </div>
              }
            >
              {c.lastError && (
                <div className="mb-4 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                  <strong>Last error:</strong> {c.lastError}
                </div>
              )}

              {c.lastSyncResults.length > 0 && (
                <div className="mb-4 overflow-x-auto">
                  <table className="w-full max-w-xl text-left text-sm">
                    <thead className="text-xs uppercase text-slate-500">
                      <tr>
                        <th className="py-1 font-medium">Entity</th>
                        <th className="py-1 text-right font-medium">New</th>
                        <th className="py-1 text-right font-medium">Updated</th>
                        <th className="py-1 text-right font-medium">Deactivated</th>
                        <th className="py-1 text-right font-medium">Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.lastSyncResults.map((r) => (
                        <tr key={r.entity} className={r.errors.length ? 'text-red-700' : 'border-t border-slate-100'}>
                          <td className="py-1 capitalize font-medium">{r.entity}</td>
                          <td className="py-1 text-right">{r.created.toLocaleString()}</td>
                          <td className="py-1 text-right">{r.updated.toLocaleString()}</td>
                          <td className="py-1 text-right">{r.deactivated.toLocaleString()}</td>
                          <td className="py-1 text-right">{(r.durationMs / 1000).toFixed(1)}s</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {isAdmin && (
                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
                  <Button
                    loading={sync.isPending && sync.variables?.id === c.id && !sync.variables.entities}
                    onClick={() => sync.mutate({ id: c.id })}
                  >
                    Sync Catalogue
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={sync.isPending}
                    onClick={() => sync.mutate({ id: c.id, entities: ['stock'] })}
                  >
                    Sync Stock Only
                  </Button>
                  <Button
                    variant="secondary"
                    loading={testConn.isPending && testConn.variables === c.id}
                    onClick={() => testConn.mutate(c.id)}
                  >
                    Test Connection
                  </Button>
                  {!c.isDefault && (
                    <Button
                      variant="ghost"
                      loading={makeDefault.isPending && makeDefault.variables === c.id}
                      onClick={() => makeDefault.mutate(c.id)}
                    >
                      Make Default
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (
                        confirm(
                          `Disconnect ${c.name}? Products and customers already synced will stay in Keyless.`,
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

          {/* Add a Connection Section */}
          <Card title="Available Connectors" description="Connect an ERP system to sync catalogue data and push approved sales orders.">
            <ul className="divide-y divide-slate-100">
              {CONNECTOR_OPTIONS.map((opt) => {
                const isConnected = connectedTypes.has(opt.type);
                return (
                  <li key={opt.type} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3.5">
                    <div>
                      <p className="font-semibold text-slate-900">{opt.name}</p>
                      <p className="text-sm text-slate-500">{opt.description}</p>
                    </div>
                    <div>
                      {isConnected ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 border border-emerald-200">
                          Connected
                        </span>
                      ) : (
                        isAdmin && (
                          <Button
                            variant="secondary"
                            onClick={() => handleOpenModal(opt.type)}
                            loading={add.isPending && add.variables?.type === opt.type}
                          >
                            Connect
                          </Button>
                        )
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      )}

      {/* Connection Configuration Modal */}
      <Modal
        open={modalType !== null}
        onClose={() => setModalType(null)}
        title={`Connect ${CONNECTOR_OPTIONS.find((c) => c.type === modalType)?.name ?? 'System'}`}
      >
        <form onSubmit={handleSubmitConnection} className="space-y-4">
          <TextField
            label="Connection Name"
            value={connName}
            onChange={(e) => setConnName(e.target.value)}
            required
          />

          {modalType === 'csv_export' && (
            <>
              <TextField
                label="Storage Folder / Directory"
                value={csvFolder}
                onChange={(e) => setCsvFolder(e.target.value)}
                hint="Relative folder inside storage bucket (e.g. exports or orders/inbox)"
              />
              <SelectField
                label="CSV Delimiter"
                value={csvDelimiter}
                onChange={(e) => setCsvDelimiter(e.target.value)}
                options={[
                  { value: ',', label: 'Comma (,)' },
                  { value: ';', label: 'Semicolon (;)' },
                  { value: '\t', label: 'Tab (\\t)' },
                ]}
              />
            </>
          )}

          {modalType === 'unleashed' && (
            <>
              <TextField
                label="API ID"
                value={unleashedApiId}
                onChange={(e) => setUnleashedApiId(e.target.value)}
                hint="Found in Unleashed under Settings > Security > API Keys"
                required
              />
              <TextField
                label="API Key (Secret)"
                type="password"
                value={unleashedApiKey}
                onChange={(e) => setUnleashedApiKey(e.target.value)}
                required
              />
            </>
          )}

          {modalType === 'cin7_core' && (
            <>
              <TextField
                label="Account ID"
                value={cin7AccountId}
                onChange={(e) => setCin7AccountId(e.target.value)}
                hint="Found under Cin7 Core Integrations > API"
                required
              />
              <TextField
                label="Application Key"
                type="password"
                value={cin7AppKey}
                onChange={(e) => setCin7AppKey(e.target.value)}
                required
              />
            </>
          )}

          {modalType === 'quickbooks_online' && (
            <>
              <TextField
                label="Realm ID (Company ID)"
                value={qboRealmId}
                onChange={(e) => setQboRealmId(e.target.value)}
                hint="Your Intuit QuickBooks Online Company ID"
                required
              />
              <TextField
                label="OAuth Access Token"
                type="password"
                value={qboAccessToken}
                onChange={(e) => setQboAccessToken(e.target.value)}
                hint="OAuth 2.0 Bearer access token"
                required
              />
              <SelectField
                label="Document Entity Type"
                value={qboDocType}
                onChange={(e) => setQboDocType(e.target.value)}
                options={[
                  { value: 'estimate', label: 'Estimate (Sales Quote)' },
                  { value: 'invoice', label: 'Invoice' },
                ]}
              />
            </>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <Button variant="secondary" type="button" onClick={() => setModalType(null)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" loading={add.isPending}>
              Save &amp; Test Connection
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
