import { Navigate, createBrowserRouter } from 'react-router';
import { FullPageSpinner } from '../components/ui';
import { AcceptInvitePage } from '../features/auth/AcceptInvitePage';
import { LoginPage } from '../features/auth/LoginPage';
import { ForgotPasswordPage, ResetPasswordPage } from '../features/auth/PasswordPages';
import { SignupPage } from '../features/auth/SignupPage';
import { VerifyEmailPage } from '../features/auth/VerifyEmailPage';
import { CrossReferencesPage } from '../features/catalogue/CrossReferencesPage';
import { CustomerDetailPage } from '../features/catalogue/CustomerDetailPage';
import { CustomersPage } from '../features/catalogue/CustomersPage';
import { ProductsPage } from '../features/catalogue/ProductsPage';
import { DevEmailsPage } from '../features/dev/DevEmailsPage';
import { ImportJobPage, ImportsPage, NewImportPage } from '../features/imports/ImportWizard';
import { EmailDetailPage } from '../features/inbox/EmailDetailPage';
import { InboxPage } from '../features/inbox/InboxPage';
import { OrderDetailPage } from '../features/orders/OrderDetailPage';
import { OrdersPage } from '../features/orders/OrdersPage';
import { MailboxesPage } from '../features/settings/MailboxesPage';
import { ProcessingErrorsPage } from '../features/settings/ProcessingErrorsPage';
import { IntegrationsPage } from '../features/settings/IntegrationsPage';
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
        element: <OrdersPage />,
      },
      { path: 'orders/:id', element: <OrderDetailPage /> },
      {
        path: 'emails',
        element: <Navigate to="/inbox?view=other" replace />,
      },
      { path: 'inbox', element: <InboxPage /> },
      { path: 'inbox/:id', element: <EmailDetailPage /> },
      { path: 'settings/mailboxes', element: <MailboxesPage /> },
      {
        path: 'settings/processing',
        element: (
          <RequireRole minimum="admin">
            <ProcessingErrorsPage />
          </RequireRole>
        ),
      },
      { path: 'customers', element: <CustomersPage /> },
      { path: 'customers/:id', element: <CustomerDetailPage /> },
      { path: 'products', element: <ProductsPage /> },
      { path: 'cross-references', element: <CrossReferencesPage /> },
      {
        path: 'imports',
        element: (
          <RequireRole minimum="admin">
            <ImportsPage />
          </RequireRole>
        ),
      },
      {
        path: 'imports/new',
        element: (
          <RequireRole minimum="admin">
            <NewImportPage />
          </RequireRole>
        ),
      },
      {
        path: 'imports/:id',
        element: (
          <RequireRole minimum="admin">
            <ImportJobPage />
          </RequireRole>
        ),
      },
      { path: 'settings/integrations', element: <IntegrationsPage /> },
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
