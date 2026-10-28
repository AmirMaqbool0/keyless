import { useMutation } from '@tanstack/react-query';
import clsx from 'clsx';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router';
import { hasRole, type Role } from '@keyless/shared';
import { Badge, FullPageSpinner } from '../components/ui';
import { Logo } from '../features/auth/AuthLayout';
import { VerifyEmailNotice } from '../features/auth/VerifyEmailPage';
import { api } from '../lib/api';
import { useSession, useSetSession } from '../lib/session';

type NavItem = {
  to: string;
  label: string;
  icon: (props: { className?: string }) => React.ReactNode;
  minRole?: Role;
  soon?: string;
  superAdminOnly?: boolean;
};

// Modern, crisp SVG icons for non-technical visual recognition
function IconOverview({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'size-4'} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
    </svg>
  );
}

function IconInbox({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'size-4'} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
    </svg>
  );
}

function IconOrders({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'size-4'} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
}

function IconCustomers({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'size-4'} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
    </svg>
  );
}

function IconProducts({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'size-4'} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
    </svg>
  );
}

function IconCrossRefs({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'size-4'} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
    </svg>
  );
}

function IconImports({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'size-4'} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
    </svg>
  );
}

function IconRules({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'size-4'} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
    </svg>
  );
}

function IconAnalytics({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'size-4'} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  );
}

function IconSettings({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'size-4'} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function IconSuperAdmin({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'size-4'} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  );
}

const NAV: { heading?: string; items: NavItem[] }[] = [
  {
    items: [
      { to: '/', label: 'Overview', icon: IconOverview },
      { to: '/inbox', label: 'Inbox', icon: IconInbox },
      { to: '/orders', label: 'Orders', icon: IconOrders },
    ],
  },
  {
    heading: 'Catalogue & Data',
    items: [
      { to: '/customers', label: 'Customers', icon: IconCustomers },
      { to: '/products', label: 'Products', icon: IconProducts },
      { to: '/cross-references', label: 'Cross-references', icon: IconCrossRefs },
      { to: '/imports', label: 'Imports', minRole: 'admin', icon: IconImports },
    ],
  },
  {
    heading: 'Automation',
    items: [
      { to: '/rules', label: 'Rules & Actions', minRole: 'admin', icon: IconRules },
      { to: '/analytics', label: 'Executive Analytics', icon: IconAnalytics },
    ],
  },
  {
    heading: 'Settings',
    items: [
      { to: '/settings/organization', label: 'Organisation', icon: IconSettings },
      { to: '/settings/billing', label: 'Billing & Plans', icon: IconSettings },
      { to: '/settings/team', label: 'Team & Roles', icon: IconSettings },
      { to: '/settings/mailboxes', label: 'Email Mailboxes', icon: IconSettings },
      { to: '/settings/integrations', label: 'ERP Connectors', icon: IconSettings },
      { to: '/settings/processing', label: 'Processing errors', minRole: 'admin', icon: IconSettings },
      { to: '/settings/security', label: 'Security & 2FA', icon: IconSettings },
      { to: '/settings/audit', label: 'Audit Log', minRole: 'admin', icon: IconSettings },
    ],
  },
  {
    heading: 'Platform',
    items: [
      { to: '/superadmin', label: 'Platform Admin', superAdminOnly: true, icon: IconSuperAdmin },
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

  const initials = user.name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="flex min-h-full bg-slate-50/50">
      {/* Modern Desktop Sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-slate-200/80 bg-white shadow-xs md:flex">
        {/* Brand Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
          <Logo />
          <span className="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-indigo-700 ring-1 ring-inset ring-indigo-700/10">
            v2.0 AI
          </span>
        </div>

        {/* Navigation Grouping */}
        <nav className="flex-1 overflow-y-auto px-3.5 py-4 space-y-6" aria-label="Main Navigation">
          {NAV.map((group, i) => {
            const items = group.items.filter((it) => {
              if (it.superAdminOnly && !user.isSuperAdmin) return false;
              if (it.minRole && !hasRole(user.role, it.minRole)) return false;
              return true;
            });
            if (!items.length) return null;
            return (
              <div key={i} className="space-y-1">
                {group.heading && (
                  <p className="px-3 pb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    {group.heading}
                  </p>
                )}
                {items.map((it) => {
                  const Icon = it.icon;
                  return (
                    <NavLink
                      key={it.to}
                      to={it.to}
                      end={it.to === '/'}
                      className={({ isActive }) =>
                        clsx(
                          'group flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150',
                          isActive
                            ? 'bg-gradient-to-r from-brand-50 to-indigo-50/60 font-semibold text-brand-700 shadow-xs ring-1 ring-brand-500/10'
                            : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <div className="flex items-center gap-3">
                            <Icon
                              className={clsx(
                                'size-4.5 transition-colors',
                                isActive ? 'text-brand-600' : 'text-slate-400 group-hover:text-slate-600',
                              )}
                            />
                            <span>{it.label}</span>
                          </div>
                          {it.soon && (
                            <span className="text-[10px] rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">
                              {it.soon}
                            </span>
                          )}
                        </>
                      )}
                    </NavLink>
                  );
                })}
              </div>
            );
          })}
        </nav>

        {/* User Profile Footer */}
        <div className="border-t border-slate-100 bg-slate-50/60 p-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-600 to-brand-700 text-xs font-bold text-white shadow-xs">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-slate-900">{user.name}</p>
              <p className="truncate text-[11px] text-slate-500">{user.email}</p>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between pt-2 border-t border-slate-200/60 text-xs">
            <Badge tone="brand" dot>{user.role}</Badge>
            <button
              onClick={() => logout.mutate()}
              className="font-medium text-slate-500 hover:text-red-600 transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Header Bar */}
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-slate-200/80 bg-white/90 backdrop-blur-md px-6 shadow-2xs">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-semibold text-slate-600 tracking-wide uppercase">
                AI Engine Live
              </span>
            </div>
            <div className="hidden sm:block h-4 w-px bg-slate-200" />
            <span className="hidden sm:inline-flex items-center gap-1.5 text-sm font-semibold text-slate-800">
              {organization.name}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <Badge tone="green" dot>
              {organization.plan.toUpperCase()} PLAN
            </Badge>
            <div className="md:hidden">
              <button
                onClick={() => logout.mutate()}
                className="text-xs font-medium text-slate-600 hover:text-red-600"
              >
                Sign out
              </button>
            </div>
          </div>
        </header>

        {/* Main Body */}
        <main className="flex-1 px-6 py-8 md:px-10">
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
