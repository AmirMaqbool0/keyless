import { Navigate, createBrowserRouter } from 'react-router';
import { FullPageSpinner } from '../components/ui';
import { AcceptInvitePage } from '../features/auth/AcceptInvitePage';
import { LoginPage } from '../features/auth/LoginPage';
import { ForgotPasswordPage, ResetPasswordPage } from '../features/auth/PasswordPages';
import { SignupPage } from '../features/auth/SignupPage';
import { VerifyEmailPage } from '../features/auth/VerifyEmailPage';
import { DevEmailsPage } from '../features/dev/DevEmailsPage';
import { ComingSoonPage, OverviewPage } from '../features/placeholder/pages';
import { AuditPage } from '../features/settings/AuditPage';
import { OrganizationPage } from '../features/settings/OrganizationPage';
import { SecurityPage } from '../features/settings/SecurityPage';
import { TeamPage } from '../features/settings/TeamPage';
import { useSession } from '../lib/session';
import { AppShell, RequireRole } from './AppShell';

/** Sign-in pages bounce to the app when already signed in. */
function GuestOnly({ children }: { children: React.ReactNode }) {
  const { data, isPending } = useSession();
  if (isPending) return <FullPageSpinner />;
  return data ? <Navigate to="/" replace /> : <>{children}</>;
}

export const router = createBrowserRouter([
  {
    path: '/login',
    element: (
      <GuestOnly>
        <LoginPage />
      </GuestOnly>
    ),
  },
  {
    path: '/signup',
    element: (
      <GuestOnly>
        <SignupPage />
      </GuestOnly>
    ),
  },
  {
    path: '/forgot-password',
    element: (
      <GuestOnly>
        <ForgotPasswordPage />
      </GuestOnly>
    ),
  },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/verify-email', element: <VerifyEmailPage /> },
  {
    path: '/accept-invite',
    element: (
      <GuestOnly>
        <AcceptInvitePage />
      </GuestOnly>
    ),
  },
  ...(import.meta.env.DEV ? [{ path: '/dev/emails', element: <DevEmailsPage /> }] : []),
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <OverviewPage /> },
      {
        path: 'orders',
        element: (
          <ComingSoonPage
            title="Orders"
            milestone="M5"
            description="The review queue: needs review, ready, on hold, pushed and failed."
          />
        ),
      },
      {
        path: 'emails',
        element: (
          <ComingSoonPage
            title="Other emails"
            milestone="M3"
            description="Emails that were not purchase orders, with a convert-to-order action."
          />
        ),
      },
      {
        path: 'customers',
        element: (
          <ComingSoonPage
            title="Customers"
            milestone="M2"
            description="Import customers, sender addresses, delivery addresses and price lists."
          />
        ),
      },
      {
        path: 'products',
        element: (
          <ComingSoonPage
            title="Products"
            milestone="M2"
            description="Import and search your catalogue."
          />
        ),
      },
      {
        path: 'cross-references',
        element: (
          <ComingSoonPage
            title="Cross-references"
            milestone="M2"
            description="Customer part codes mapped to your SKUs - learned from every correction."
          />
        ),
      },
      {
        path: 'rules',
        element: (
          <RequireRole minimum="admin">
            <ComingSoonPage
              title="Rules"
              milestone="M8"
              description="Auto-approve, require-review and block rules."
            />
          </RequireRole>
        ),
      },
      {
        path: 'analytics',
        element: (
          <ComingSoonPage
            title="Analytics"
            milestone="M9"
            description="Touch-free rate, time saved and accuracy trends."
          />
        ),
      },
      { path: 'settings', element: <Navigate to="/settings/organization" replace /> },
      { path: 'settings/organization', element: <OrganizationPage /> },
      { path: 'settings/team', element: <TeamPage /> },
      { path: 'settings/security', element: <SecurityPage /> },
      {
        path: 'settings/audit',
        element: (
          <RequireRole minimum="admin">
            <AuditPage />
          </RequireRole>
        ),
      },
      {
        path: '*',
        element: (
          <ComingSoonPage
            title="Page not found"
            milestone="a later milestone"
            description="This page does not exist (yet)."
          />
        ),
      },
    ],
  },
]);
