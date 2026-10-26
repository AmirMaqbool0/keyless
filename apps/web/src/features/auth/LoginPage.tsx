import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router';
import { loginSchema, type LoginInput, type LoginResponse } from '@keyless/shared';
import { Button, FormError, TextField } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useSetSession } from '../../lib/session';
import { AuthLayout } from './AuthLayout';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const setSession = useSetSession();
  const [challenge, setChallenge] = useState<string | null>(null);
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const finish = (res: LoginResponse) => {
    if (res.status === 'two_factor_required') {
      setChallenge(res.challengeToken);
      return;
    }
    setSession({ user: res.user, organization: res.organization });
    navigate(from, { replace: true });
  };

  const form = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });
  const login = useMutation({
    mutationFn: (input: LoginInput) => api.post<LoginResponse>('/api/auth/login', input),
    onSuccess: finish,
  });

  if (challenge)
    return (
      <TwoFactorStep
        challengeToken={challenge}
        onDone={finish}
        onRestart={() => setChallenge(null)}
      />
    );

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back."
      footer={
        <>
          New to Keyless?{' '}
          <Link to="/signup" className="font-medium text-brand-700 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit((v) => login.mutate(v))} noValidate>
        <FormError message={login.error ? errorMessage(login.error) : null} />
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          autoFocus
          error={form.formState.errors.email?.message}
          {...form.register('email')}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          error={form.formState.errors.password?.message}
          {...form.register('password')}
        />
        <div className="flex justify-end">
          <Link to="/forgot-password" className="text-sm text-brand-700 hover:underline">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" className="w-full" loading={login.isPending}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}

function TwoFactorStep({
  challengeToken,
  onDone,
  onRestart,
}: {
  challengeToken: string;
  onDone: (res: LoginResponse) => void;
  onRestart: () => void;
}) {
  const [code, setCode] = useState('');
  const verify = useMutation({
    mutationFn: () => api.post<LoginResponse>('/api/auth/login/2fa', { challengeToken, code }),
    onSuccess: onDone,
  });
  return (
    <AuthLayout
      title="Two-factor authentication"
      subtitle="Enter the 6-digit code from your authenticator app, or a recovery code."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          verify.mutate();
        }}
      >
        <FormError message={verify.error ? errorMessage(verify.error) : null} />
        <TextField
          label="Code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <Button
          type="submit"
          className="w-full"
          loading={verify.isPending}
          disabled={code.trim().length < 6}
        >
          Verify
        </Button>
        <button
          type="button"
          onClick={onRestart}
          className="w-full text-sm text-slate-500 hover:text-slate-700"
        >
          Start over
        </button>
      </form>
    </AuthLayout>
  );
}
