import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { TWO_FACTOR_ROLES } from '@keyless/shared';
import { Badge, Button, Card, PageHeader, TextField } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { meQueryKey, useMe } from '../../lib/session';

type SetupResponse = { otpauthUrl: string; qrDataUrl: string; secret: string };

export function SecurityPage() {
  const { user } = useMe();
  const qc = useQueryClient();
  const refreshMe = () => qc.invalidateQueries({ queryKey: meQueryKey });
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');

  const begin = useMutation({
    mutationFn: () => api.post<SetupResponse>('/api/auth/2fa/setup'),
    onSuccess: setSetup,
    onError: (err) => toast.error(errorMessage(err)),
  });
  const enable = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/api/auth/2fa/enable', { code }),
    onSuccess: (res) => {
      setRecoveryCodes(res.recoveryCodes);
      setSetup(null);
      setCode('');
      void refreshMe();
      toast.success('Two-factor authentication is on');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const disable = useMutation({
    mutationFn: () => api.post('/api/auth/2fa/disable', { password }),
    onSuccess: () => {
      setPassword('');
      void refreshMe();
      toast.success('Two-factor authentication is off');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const recommended = TWO_FACTOR_ROLES.includes(user.role);

  return (
    <>
      <PageHeader title="Security" description="Protect your account with an authenticator app." />
      <Card
        title="Two-factor authentication"
        description={
          recommended
            ? 'Strongly recommended for owners and admins.'
            : 'Adds a code from your phone at sign-in.'
        }
        actions={
          user.twoFactorEnabled ? (
            <Badge tone="green">On</Badge>
          ) : (
            <Badge tone={recommended ? 'amber' : 'slate'}>Off</Badge>
          )
        }
      >
        {recoveryCodes && (
          <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-medium text-amber-900">Save your recovery codes</p>
            <p className="mt-1 text-sm text-amber-800">
              Each works once if you lose your phone. They will not be shown again.
            </p>
            <ul className="mt-3 grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-4">
              {recoveryCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <Button
              variant="secondary"
              className="mt-3"
              onClick={() => void navigator.clipboard.writeText(recoveryCodes.join('\n'))}
            >
              Copy codes
            </Button>
          </div>
        )}

        {user.twoFactorEnabled ? (
          <form
            className="flex max-w-md flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              disable.mutate();
            }}
          >
            <TextField
              label="Confirm your password to turn it off"
              type="password"
              autoComplete="current-password"
              className="flex-1"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <Button type="submit" variant="danger" loading={disable.isPending}>
              Turn off
            </Button>
          </form>
        ) : setup ? (
          <div className="flex flex-wrap gap-6">
            <img
              src={setup.qrDataUrl}
              alt="QR code for your authenticator app"
              className="size-44 rounded border border-slate-200"
            />
            <form
              className="max-w-xs space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                enable.mutate();
              }}
            >
              <p className="text-sm text-slate-600">
                Scan with Google Authenticator, Microsoft Authenticator or 1Password, then enter the
                6-digit code.
              </p>
              <p className="text-xs text-slate-500">
                Can't scan? Key: <code className="break-all">{setup.secret}</code>
              </p>
              <TextField
                label="Code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <Button type="submit" loading={enable.isPending} disabled={code.trim().length !== 6}>
                Turn on
              </Button>
            </form>
          </div>
        ) : (
          <Button onClick={() => begin.mutate()} loading={begin.isPending}>
            Set up two-factor
          </Button>
        )}
      </Card>
    </>
  );
}
