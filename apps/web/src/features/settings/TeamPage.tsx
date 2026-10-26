import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { ROLES, assignableRoles, type InviteDto, type Role, type UserDto } from '@keyless/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  SelectField,
  Spinner,
  TextField,
} from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useHasRole, useMe } from '../../lib/session';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Billing, all settings and users',
  admin: 'Settings, integrations, rules, catalogue and users',
  reviewer: 'Reviews and approves orders, emails customers',
  viewer: 'Read-only dashboards and orders',
};

const roleOptions = (roles: readonly Role[]) =>
  roles.map((r) => ({ value: r, label: r[0]!.toUpperCase() + r.slice(1) }));

export function TeamPage() {
  const { user: me } = useMe();
  const isAdmin = useHasRole('admin');
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ users: UserDto[] }>('/api/users'),
  });
  const invites = useQuery({
    queryKey: ['invites'],
    queryFn: () => api.get<{ invites: InviteDto[] }>('/api/users/invites'),
    enabled: isAdmin,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['users'] });
    void qc.invalidateQueries({ queryKey: ['invites'] });
  };

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) =>
      api.patch(`/api/users/${id}/role`, { role }),
    onSuccess: () => {
      toast.success('Role updated');
      refresh();
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/users/${id}`),
    onSuccess: () => {
      toast.success('User removed');
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api/users/invites/${id}`),
    onSuccess: () => {
      toast.success('Invitation revoked');
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const canManage = (u: UserDto) =>
    isAdmin && u.id !== me.id && (u.role !== 'owner' || me.role === 'owner');

  return (
    <>
      <PageHeader title="Team" description="Who can review, approve and configure orders." />
      {isAdmin && <InviteForm onInvited={refresh} />}

      <Card title="Members" className="mt-6">
        {users.isPending ? (
          <Spinner />
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Name</th>
                  <th className="px-5 py-2 font-medium">Role</th>
                  <th className="px-5 py-2 font-medium">2FA</th>
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.data?.users.map((u) => (
                  <tr key={u.id}>
                    <td className="px-5 py-3">
                      <p className="font-medium text-slate-900">
                        {u.name} {u.id === me.id && <span className="text-slate-400">(you)</span>}
                      </p>
                      <p className="text-slate-500">{u.email}</p>
                    </td>
                    <td className="px-5 py-3">
                      {canManage(u) ? (
                        <select
                          aria-label={`Role for ${u.name}`}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
                          value={u.role}
                          onChange={(e) =>
                            changeRole.mutate({ id: u.id, role: e.target.value as Role })
                          }
                        >
                          {roleOptions(assignableRoles(me.role)).map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Badge tone={u.role === 'owner' ? 'brand' : 'slate'}>{u.role}</Badge>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {u.twoFactorEnabled ? (
                        <Badge tone="green">On</Badge>
                      ) : (
                        <span className="text-slate-400">Off</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {canManage(u) && (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            if (
                              confirm(
                                `Remove ${u.name} from the team? They will be signed out immediately.`,
                              )
                            )
                              remove.mutate(u.id);
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {isAdmin && (
        <Card title="Pending invitations" className="mt-6">
          {invites.data?.invites.length ? (
            <ul className="divide-y divide-slate-100 text-sm">
              {invites.data.invites.map((i) => (
                <li key={i.id} className="flex items-center justify-between py-2">
                  <span>
                    {i.email} <Badge>{i.role}</Badge>
                    <span className="ml-2 text-xs text-slate-400">
                      expires {new Date(i.expiresAt).toLocaleDateString()}
                    </span>
                  </span>
                  <Button variant="ghost" onClick={() => revoke.mutate(i.id)}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No pending invitations" />
          )}
        </Card>
      )}
    </>
  );
}

function InviteForm({ onInvited }: { onInvited: () => void }) {
  const { user: me } = useMe();
  const allowed = assignableRoles(me.role);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('reviewer');
  const invite = useMutation({
    mutationFn: () => api.post('/api/users/invites', { email, role }),
    onSuccess: () => {
      toast.success(`Invitation sent to ${email}`);
      setEmail('');
      onInvited();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Card title="Invite a teammate" description={ROLE_HELP[role]}>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          invite.mutate();
        }}
      >
        <TextField
          label="Email"
          type="email"
          required
          className="min-w-64 flex-1"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <SelectField
          label="Role"
          options={roleOptions(ROLES.filter((r) => allowed.includes(r)))}
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
        />
        <Button type="submit" loading={invite.isPending}>
          Send invite
        </Button>
      </form>
    </Card>
  );
}
