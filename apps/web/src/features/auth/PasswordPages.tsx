import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { passwordSchema } from '@keyless/shared';
import { Button, FormError, TextField } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useSetSession } from '../../lib/session';
import { AuthLayout } from './AuthLayout';

const backToLogin = (
  <Link to="/login" className="font-medium text-brand-700 hover:underline">
    Back to sign in
  </Link>
);

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const send = useMutation({ mutationFn: () => api.post('/api/auth/forgot-password', { email }) });

  if (send.isSuccess) {
    return (
      <AuthLayout title="Check your email" footer={backToLogin}>
        <p className="text-sm text-slate-600">
          If an account exists for <strong>{email}</strong>, we have sent a link to reset the
          password. It expires in 1 hour.
        </p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title="Reset your password"
      subtitle="We will email you a reset link."
      footer={backToLogin}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <FormError message={send.error ? errorMessage(send.error) : null} />
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button type="submit" className="w-full" loading={send.isPending}>
          Send reset link
        </Button>
      </form>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const setSession = useSetSession();
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const reset = useMutation({
    mutationFn: () => api.post('/api/auth/reset-password', { token, password }),
    onSuccess: () => {
      setSession(null);
      toast.success('Password updated. Please sign in.');
      navigate('/login', { replace: true });
    },
  });

  return (
    <AuthLayout title="Choose a new password" footer={backToLogin}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const check = passwordSchema.safeParse(password);
          setLocalError(
            check.success ? null : (check.error.issues[0]?.message ?? 'Invalid password'),
          );
          if (check.success) reset.mutate();
        }}
      >
        <FormError
          message={
            !token
              ? 'This link is missing its token.'
              : reset.error
                ? errorMessage(reset.error)
                : null
          }
        />
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          autoFocus
          hint="At least 10 characters."
          error={localError ?? undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" className="w-full" loading={reset.isPending} disabled={!token}>
          Update password
        </Button>
      </form>
    </AuthLayout>
  );
}
