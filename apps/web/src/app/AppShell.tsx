import { useMutation } from '@tanstack/react-query';
import clsx from 'clsx';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router';
import { hasRole, type Role } from '@keyless/shared';
import { Badge, FullPageSpinner } from '../components/ui';
import { Logo } from '../features/auth/AuthLayout';
import { VerifyEmailNotice } from '../features/auth/VerifyEmailPage';
import { api } from '../lib/api';
import { useSession, useSetSession } from '../lib/session';

type NavItem = { to: string; label: string; minRole?: Role; soon?: string };

const NAV: { heading?: string; items: NavItem[] }[] = [
  {
    items: [
      { to: '/', label: 'Overview' },
      { to: '/inbox', label: 'Inbox' },
      { to: '/orders', label: 'Orders' },
    ],
  },
  {
    heading: 'Data',
    items: [
      { to: '/customers', label: 'Customers' },
      { to: '/products', label: 'Products' },
      { to: '/cross-references', label: 'Cross-references' },
      { to: '/imports', label: 'Imports', minRole: 'admin' },
    ],
  },
  {
    heading: 'Automation',
    items: [
      { to: '/rules', label: 'Rules', minRole: 'admin', soon: 'M8' },
      { to: '/analytics', label: 'Analytics', soon: 'M9' },
    ],
  },
  {
    heading: 'Settings',
    items: [
      { to: '/settings/organization', label: 'Organisation' },
      { to: '/settings/team', label: 'Team' },
      { to: '/settings/mailboxes', label: 'Mailboxes' },
      { to: '/settings/integrations', label: 'Integrations' },
      { to: '/settings/processing', label: 'Processing errors', minRole: 'admin' },
      { to: '/settings/security', label: 'Security' },
      { to: '/settings/audit', label: 'Audit log', minRole: 'admin' },
    ],
  },
];

export function AppShell() {
  const { data: session, isPending } = useSession();
  const location = useLocation();
  const setSession = useSetSession();
  const logout = useMutation({
    mutationFn: () => api.post('/api/auth/logout'),
    onSettled: () => setSession(null),
  });

  if (isPending) return <FullPageSpinner />;
  if (!session)
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  const { user, organization } = session;

  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="px-5 py-4">
          <Logo />
        </div>
        <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label="Main">
          {NAV.map((group, i) => {
            const items = group.items.filter((it) => !it.minRole || hasRole(user.role, it.minRole));
            if (!items.length) return null;
            return (
              <div key={i} className="mt-4 first:mt-0">
                {group.heading && (
                  <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
                    {group.heading}
                  </p>
                )}
                {items.map((it) => (
                  <NavLink
                    key={it.to}
                    to={it.to}
                    end={it.to === '/'}
                    className={({ isActive }) =>
                      clsx(
                        'flex items-center justify-between rounded-md px-2 py-1.5 text-sm',
                        isActive
                          ? 'bg-brand-50 font-medium text-brand-700'
                          : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
                      )
                    }
                  >
                    {it.label}
                    {it.soon && <span className="text-[10px] text-slate-400">{it.soon}</span>}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="border-t border-slate-200 px-4 py-3">
          <p className="truncate text-sm font-medium text-slate-900">{user.name}</p>
          <p className="truncate text-xs text-slate-500">{user.email}</p>
          <div className="mt-2 flex items-center justify-between">
            <Badge tone="brand">{user.role}</Badge>
            <button
              onClick={() => logout.mutate()}
              className="text-xs text-slate-500 hover:text-slate-800"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-6">
          <span className="text-sm font-medium text-slate-700">{organization.name}</span>
          <span className="text-xs text-slate-400 md:hidden">
            <button onClick={() => logout.mutate()}>Sign out</button>
          </span>
          <Badge>{organization.plan}</Badge>
        </header>
        <main className="flex-1 px-6 py-8">
          <div className="mx-auto max-w-6xl">
            {user.emailVerified ? <Outlet /> : <VerifyEmailNotice />}
          </div>
        </main>
      </div>
    </div>
  );
}

/** Wrap routes that need a minimum role; shows a friendly message instead of a broken page. */
export function RequireRole({ minimum, children }: { minimum: Role; children: React.ReactNode }) {
  const { data } = useSession();
  if (!data || !hasRole(data.user.role, minimum)) {
    return (
      <p className="text-sm text-slate-600">
        You need the {minimum} role or higher to view this page.
      </p>
    );
  }
  return <>{children}</>;
}
