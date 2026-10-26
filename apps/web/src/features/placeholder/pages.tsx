import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { OrderCounts } from '@keyless/shared';
import { Card, EmptyState, PageHeader } from '../../components/ui';
import { api } from '../../lib/api';
import { useHasRole, useMe } from '../../lib/session';

export function OverviewPage() {
  const { user, organization } = useMe();
  const isAdmin = useHasRole('admin');
  const counts = useQuery({
    queryKey: ['order-counts'],
    queryFn: () => api.get<OrderCounts>('/api/orders/counts'),
  });
  return (
    <>
      <PageHeader
        title={`Welcome, ${user.name.split(' ')[0]}`}
        description={`${organization.name} on Keyless`}
      />
      <div className="grid gap-4 md:grid-cols-3">
        {(
          [
            ['Ready to approve', counts.data?.ready, 'ready', 'text-emerald-700'],
            ['Need review', counts.data?.needs_review, '', 'text-amber-700'],
            ['On hold', counts.data?.on_hold, 'on_hold', 'text-red-700'],
          ] as const
        ).map(([label, value, view, tone]) => (
          <Link key={label} to={`/orders${view ? `?view=${view}` : ''}`}>
            <Card className="transition hover:border-brand-300">
              <p className="text-sm text-slate-500">{label}</p>
              <p className={`mt-1 text-2xl font-semibold ${tone}`}>{value ?? '-'}</p>
            </Card>
          </Link>
        ))}
      </div>
      <Card className="mt-6" title="Getting started">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700">
          <li>
            {isAdmin ? (
              <Link to="/settings/team" className="text-brand-700 hover:underline">
                Invite your team
              </Link>
            ) : (
              'Your admin invites the team'
            )}{' '}
            - reviewers approve orders, viewers see dashboards.
          </li>
          <li>Import your catalogue, customers and price lists (coming in M2).</li>
          <li>Connect your orders mailbox or forwarding address (coming in M3).</li>
          <li>Send a test purchase order and watch it get processed.</li>
        </ol>
      </Card>
    </>
  );
}

export function ComingSoonPage({
  title,
  milestone,
  description,
}: {
  title: string;
  milestone: string;
  description: string;
}) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState title={`Arrives in ${milestone}`}>{description}</EmptyState>
    </>
  );
}
