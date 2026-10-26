import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import type { OrganizationDto } from '@keyless/shared';
import { Button, Card, PageHeader, SelectField, TextField } from '../../components/ui';
import { api, errorMessage, fieldErrors } from '../../lib/api';
import { useHasRole, useMe, useSetSession } from '../../lib/session';

const CURRENCIES = ['GBP', 'EUR', 'USD'].map((c) => ({ value: c, label: c }));
const COUNTRIES = [
  { value: 'GB', label: 'United Kingdom' },
  { value: 'IE', label: 'Ireland' },
  { value: 'NL', label: 'Netherlands' },
  { value: 'DE', label: 'Germany' },
  { value: 'FR', label: 'France' },
  { value: 'US', label: 'United States' },
];
const TIMEZONES = [
  'Europe/London',
  'Europe/Dublin',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
].map((t) => ({ value: t, label: t }));

export function OrganizationPage() {
  const session = useMe();
  const setSession = useSetSession();
  const canEdit = useHasRole('admin');
  const [form, setForm] = useState(() => {
    const { name, country, timezone, currency } = session.organization;
    return { name, country, timezone, currency };
  });
  const save = useMutation({
    mutationFn: () => api.patch<{ organization: OrganizationDto }>('/api/org', form),
    onSuccess: ({ organization }) => {
      setSession({ ...session, organization });
      toast.success('Organisation updated');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const errors = fieldErrors(save.error);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <>
      <PageHeader title="Organisation" description="Company details used on orders and emails." />
      <Card>
        <form
          className="grid max-w-xl gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <fieldset disabled={!canEdit} className="contents">
            <TextField
              label="Company name"
              value={form.name}
              onChange={set('name')}
              error={errors.name}
              required
            />
            <div className="grid gap-4 sm:grid-cols-3">
              <SelectField
                label="Country"
                options={COUNTRIES}
                value={form.country}
                onChange={set('country')}
              />
              <SelectField
                label="Currency"
                options={CURRENCIES}
                value={form.currency}
                onChange={set('currency')}
              />
              <SelectField
                label="Timezone"
                options={TIMEZONES}
                value={form.timezone}
                onChange={set('timezone')}
              />
            </div>
          </fieldset>
          <p className="text-xs text-slate-500">
            Workspace ID: <code>{session.organization.slug}</code>
          </p>
          {canEdit ? (
            <div>
              <Button type="submit" loading={save.isPending}>
                Save changes
              </Button>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Only admins can change these settings.</p>
          )}
        </form>
      </Card>
    </>
  );
}
