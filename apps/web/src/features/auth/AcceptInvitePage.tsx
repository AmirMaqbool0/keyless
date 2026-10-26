import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { passwordSchema, type LoginResponse } from '@keyless/shared';
import { Button, FormError, Spinner, TextField } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useSetSession } from '../../lib/session';
import { AuthLayout } from './AuthLayout';

type InviteInfo = { email: string; role: string; organizationName: string };

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const setSession = useSetSession();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string>();

  const info = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.get<InviteInfo>(`/api/auth/invites/${encodeURIComponent(token)}`),
    enabled: Boolean(token),
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () => api.post<LoginResponse>('/api/auth/accept-invite', { token, name, password }),
    onSuccess: (res) => {
      if (res.status !== 'ok') return;
      setSession({ user: res.user, organization: res.organization });
      navigate('/', { replace: true });
    },
  });

  if (!token || info.isError) {
    return (
      <AuthLayout title="Invitation">
        <FormError message={token ? errorMessage(info.error) : 'This link is missing its token.'} />
        <p className="mt-4 text-sm text-slate-600">
          Ask whoever invited you to send a new invitation.
        </p>
      </AuthLayout>
    );
  }
  if (!info.data) {
    return (
      <AuthLayout title="Invitation">
        <Spinner />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={`Join ${info.data.organizationName}`}
      subtitle={
        <>
          You have been invited as a <strong>{info.data.role}</strong> ({info.data.email}).
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const check = passwordSchema.safeParse(password);
          setPasswordError(check.success ? undefined : check.error.issues[0]?.message);
          if (check.success) accept.mutate();
        }}
      >
        <FormError message={accept.error ? errorMessage(accept.error) : null} />
        <TextField
          label="Your name"
          autoComplete="name"
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label="Choose a password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters."
          error={passwordError}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" className="w-full" loading={accept.isPending}>
          Join team
        </Button>
      </form>
    </AuthLayout>
  );
}
