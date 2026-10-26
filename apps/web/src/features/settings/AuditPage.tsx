import { useQuery } from '@tanstack/react-query';
import { Card, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { api } from '../../lib/api';

type AuditEntry = {
  id: string;
  action: string;
  actor: { email: string | null; type: string };
  entity: { type: string; id?: string };
  summary: Record<string, unknown> | null;
  createdAt: string;
};

export function AuditPage() {
  const q = useQuery({
    queryKey: ['audit'],
    queryFn: () => api.get<{ entries: AuditEntry[] }>('/api/audit?limit=100'),
  });
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every sign-in, approval, edit and settings change. Append-only."
      />
      <Card>
        {q.isPending ? (
          <Spinner />
        ) : !q.data?.entries.length ? (
          <EmptyState title="Nothing logged yet" />
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">When</th>
                  <th className="px-5 py-2 font-medium">Who</th>
                  <th className="px-5 py-2 font-medium">Action</th>
                  <th className="px-5 py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {q.data.entries.map((e) => (
                  <tr key={e.id} className="align-top">
                    <td className="whitespace-nowrap px-5 py-2 text-slate-500">
                      {new Date(e.createdAt).toLocaleString()}
                    </td>
                    <td className="px-5 py-2">{e.actor.email ?? e.actor.type}</td>
                    <td className="px-5 py-2 font-mono text-xs">{e.action}</td>
                    <td className="max-w-md truncate px-5 py-2 font-mono text-xs text-slate-500">
                      {e.summary ? JSON.stringify(e.summary) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
