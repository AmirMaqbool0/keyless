import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { ProcessingErrorDto } from '@keyless/shared';
import { relativeTime } from '../../components/data';
import { Button, Card, EmptyState, FullPageSpinner, PageHeader } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';

const JOB_LABELS: Record<string, string> = {
  'process-email': 'Reading an email',
  'classify-email': 'Classifying an email',
  'mailbox-sync': 'Checking a mailbox',
};

export function ProcessingErrorsPage() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['processing-errors'],
    queryFn: () => api.get<{ items: ProcessingErrorDto[] }>('/api/processing-errors'),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'retry' | 'dismiss' }) =>
      api.post(`/api/processing-errors/${id}/${action}`),
    onSuccess: (_d, v) => {
      toast.success(v.action === 'retry' ? 'Queued to try again' : 'Dismissed');
      void qc.invalidateQueries({ queryKey: ['processing-errors'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (list.isPending) return <FullPageSpinner />;
  const items = list.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Processing errors"
        description="Background work that failed after several automatic retries."
      />
      {!items.length ? (
        <EmptyState title="Nothing has failed">
          Keyless retries automatically; only persistent problems show up here.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {items.map((e) => (
            <Card key={e.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">
                    {JOB_LABELS[e.jobName] ?? e.jobName}
                    {e.entity?.type === 'email' && (
                      <Link
                        to={`/inbox/${e.entity.id}`}
                        className="ml-2 text-sm font-normal text-brand-700 hover:underline"
                      >
                        View email
                      </Link>
                    )}
                    {e.entity?.type === 'mailbox' && (
                      <Link
                        to="/settings/mailboxes"
                        className="ml-2 text-sm font-normal text-brand-700 hover:underline"
                      >
                        Mailboxes
                      </Link>
                    )}
                  </p>
                  <p className="mt-1 break-words font-mono text-xs text-red-700">{e.message}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {relativeTime(e.createdAt)} after {e.attempts} attempt
                    {e.attempts === 1 ? '' : 's'}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button onClick={() => act.mutate({ id: e.id, action: 'retry' })}>Retry</Button>
                  <Button
                    variant="ghost"
                    onClick={() => act.mutate({ id: e.id, action: 'dismiss' })}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
