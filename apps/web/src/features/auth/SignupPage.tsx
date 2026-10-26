import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { signupSchema, type LoginResponse, type SignupInput } from '@keyless/shared';
import { Button, FormError, TextField } from '../../components/ui';
import { api, errorMessage, fieldErrors } from '../../lib/api';
import { useSetSession } from '../../lib/session';
import { AuthLayout } from './AuthLayout';

export function SignupPage() {
  const navigate = useNavigate();
  const setSession = useSetSession();
  const form = useForm<SignupInput>({ resolver: zodResolver(signupSchema) });
  const signup = useMutation({
    mutationFn: (input: SignupInput) => api.post<LoginResponse>('/api/auth/signup', input),
    onSuccess: (res) => {
      if (res.status !== 'ok') return;
      setSession({ user: res.user, organization: res.organization });
      navigate('/', { replace: true });
    },
  });
  const errors = {
    ...fieldErrors(signup.error),
    ...Object.fromEntries(Object.entries(form.formState.errors).map(([k, v]) => [k, v?.message])),
  };

  return (
    <AuthLayout
      title="Create your Keyless account"
      subtitle="Set up your company in under a minute."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-brand-700 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit((v) => signup.mutate(v))} noValidate>
        <FormError
          message={
            signup.error && !Object.keys(fieldErrors(signup.error)).length
              ? errorMessage(signup.error)
              : null
          }
        />
        <TextField
          label="Your name"
          autoComplete="name"
          autoFocus
          error={errors.name}
          {...form.register('name')}
        />
        <TextField
          label="Company name"
          autoComplete="organization"
          error={errors.organizationName}
          {...form.register('organizationName')}
        />
        <TextField
          label="Work email"
          type="email"
          autoComplete="email"
          error={errors.email}
          {...form.register('email')}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters. A short phrase works well."
          error={errors.password}
          {...form.register('password')}
        />
        <Button type="submit" className="w-full" loading={signup.isPending}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
