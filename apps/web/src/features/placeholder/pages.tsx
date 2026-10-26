import { Link } from 'react-router';
import { Card, EmptyState, PageHeader } from '../../components/ui';
import { useHasRole, useMe } from '../../lib/session';

export function OverviewPage() {
  const { user, organization } = useMe();
  const isAdmin = useHasRole('admin');
  return (
    <>
      <PageHeader
        title={`Welcome, ${user.name.split(' ')[0]}`}
        description={`${organization.name} on Keyless`}
      />
      <div className="grid gap-4 md:grid-cols-3">
        {[
          ['Orders today', '-'],
          ['Touch-free rate', '-'],
          ['Hours saved this month', '-'],
        ].map(([label, value]) => (
          <Card key={label}>
            <p className="text-sm text-slate-500">{label}</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
          </Card>
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
