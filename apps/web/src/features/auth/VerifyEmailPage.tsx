import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Button, FormError, Spinner } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { meQueryKey, useMe } from '../../lib/session';
import { AuthLayout } from './AuthLayout';

/** Landing page for the emailed verification link. */
export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const qc = useQueryClient();
  const verify = useMutation({
    mutationFn: () => api.post<{ email: string }>('/api/auth/verify-email', { token }),
    onSuccess: () => qc.invalidateQueries({ queryKey: meQueryKey }),
  });
  // Tokens are single-use, so make sure StrictMode's double effect only submits once.
  const sent = useRef(false);
  useEffect(() => {
    if (token && !sent.current) {
      sent.current = true;
      verify.mutate();
    }
  }, [token, verify]);

  return (
    <AuthLayout title="Email verification">
      {verify.isSuccess ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            <strong>{verify.data.email}</strong> is verified. You are all set.
          </p>
          <Link to="/" className="block">
            <Button className="w-full">Continue to Keyless</Button>
          </Link>
        </div>
      ) : verify.isError || !token ? (
        <div className="space-y-4">
          <FormError
            message={token ? errorMessage(verify.error) : 'This link is missing its token.'}
          />
          <Link to="/" className="text-sm font-medium text-brand-700 hover:underline">
            Go to Keyless
          </Link>
        </div>
      ) : (
        <div className="flex items-center gap-3 text-sm text-slate-600">
          <Spinner /> Verifying...
        </div>
      )}
    </AuthLayout>
  );
}

/** Shown inside the app until the signed-in user verifies their email. */
export function VerifyEmailNotice() {
  const { user } = useMe();
  const resend = useMutation({
    mutationFn: () => api.post('/api/auth/verify-email/resend'),
    onSuccess: () => toast.success('Verification email sent'),
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
      <h1 className="text-lg font-semibold">Verify your email</h1>
      <p className="mt-2 text-sm text-slate-600">
        We sent a link to <strong>{user.email}</strong>. Click it to finish setting up your account.
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <Button variant="secondary" loading={resend.isPending} onClick={() => resend.mutate()}>
          Resend email
        </Button>
        {import.meta.env.DEV && (
          <Link to="/dev/emails">
            <Button variant="ghost">Open dev mailbox</Button>
          </Link>
        )}
      </div>
    </div>
  );
}
