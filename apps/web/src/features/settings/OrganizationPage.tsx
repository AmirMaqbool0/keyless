import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
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
  const navigate = useNavigate();
  const canEdit = useHasRole('admin');
  const isOwner = useHasRole('owner');

  const [form, setForm] = useState(() => {
    const { name, country, timezone, currency, settings } = session.organization;
    return {
      name,
      country,
      timezone,
      currency,
      settings: {
        greenConfidenceThreshold: settings?.greenConfidenceThreshold ?? 0.9,
        amberConfidenceThreshold: settings?.amberConfidenceThreshold ?? 0.6,
        priceTolerancePct: settings?.priceTolerancePct ?? 2,
        codeDescriptionMismatchThreshold: settings?.codeDescriptionMismatchThreshold ?? 0.5,
      },
    };
  });

  const [confirmSlug, setConfirmSlug] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const save = useMutation({
    mutationFn: () => api.patch<{ organization: OrganizationDto }>('/api/org', form),
    onSuccess: ({ organization }) => {
      setSession({ ...session, organization });
      toast.success('Organisation updated');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  // Export Data Mutation
  const exportMutation = useMutation({
    mutationFn: async () => {
      const data = await api.post<Record<string, unknown>>('/api/org/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `keyless-export-${session.organization.slug}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => toast.success('Organization data exported successfully'),
    onError: (err) => toast.error(errorMessage(err)),
  });

  // Retention Prune Mutation
  const pruneMutation = useMutation({
    mutationFn: () =>
      api.post<{ emailsPruned: number; attachmentsPruned: number }>('/api/org/retention/cleanup'),
    onSuccess: (res) => {
      toast.success(
        `Pruned ${res.emailsPruned} expired emails and ${res.attachmentsPruned} attachments`,
      );
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  // Delete Organization Mutation
  const deleteOrgMutation = useMutation({
    mutationFn: () => api.delete('/api/org', { confirmSlug }),
    onSuccess: () => {
      toast.success('Organization permanently deleted');
      setSession(null);
      navigate('/login');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const errors = fieldErrors(save.error);
  const set = (k: 'name' | 'country' | 'timezone' | 'currency') => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });
  const setSetting = (k: keyof typeof form.settings) => (e: { target: { value: string } }) => {
    const val = parseFloat(e.target.value);
    setForm((f) => ({
      ...f,
      settings: { ...f.settings, [k]: isNaN(val) ? 0 : val },
    }));
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Organisation" description="Company details used on orders, emails, and data compliance." />

      {/* General Settings */}
      <Card title="Company Profile">
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

            <div className="pt-2 border-t border-slate-100">
              <h4 className="text-sm font-semibold text-slate-800 mb-2">Matching & Routing Thresholds</h4>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Green Confidence"
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  value={form.settings.greenConfidenceThreshold}
                  onChange={setSetting('greenConfidenceThreshold')}
                  hint="Threshold (0.0 - 1.0) for auto-ready orders"
                />
                <TextField
                  label="Amber Confidence"
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  value={form.settings.amberConfidenceThreshold}
                  onChange={setSetting('amberConfidenceThreshold')}
                  hint="Threshold (0.0 - 1.0) for needs review"
                />
                <TextField
                  label="Price Tolerance %"
                  type="number"
                  step="0.5"
                  min="0"
                  value={form.settings.priceTolerancePct}
                  onChange={setSetting('priceTolerancePct')}
                  hint="Max allowable difference from expected price"
                />
                <TextField
                  label="Code/Desc Mismatch Threshold"
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  value={form.settings.codeDescriptionMismatchThreshold}
                  onChange={setSetting('codeDescriptionMismatchThreshold')}
                  hint="Similarity threshold below which SKU matches are distrusted (default 0.5)"
                />
              </div>
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

      {/* GDPR Data Portability & Retention */}
      <Card
        title="Data Portability & GDPR Compliance"
        description="Download your complete organization records or run data retention pruning to erase raw email text while retaining structured orders."
      >
        <div className="max-w-xl space-y-4 text-sm text-slate-600">
          <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
            <h4 className="font-semibold text-slate-900">GDPR Data Export</h4>
            <p className="mt-1 text-xs text-slate-500">
              Generate a machine-readable JSON archive containing all customers, products, customer prices,
              cross-references, automation rules, and complete order history.
            </p>
            <div className="mt-3">
              <Button
                variant="secondary"
                loading={exportMutation.isPending}
                onClick={() => exportMutation.mutate()}
              >
                Export All Data (JSON)
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
            <h4 className="font-semibold text-slate-900">Data Retention Cleanup</h4>
            <p className="mt-1 text-xs text-slate-500">
              Purges raw MIME payloads and file attachments older than your retention setting (default 90 days).
              Structured order data and analytics are preserved for tax and reporting compliance.
            </p>
            {canEdit && (
              <div className="mt-3">
                <Button
                  variant="secondary"
                  loading={pruneMutation.isPending}
                  onClick={() => pruneMutation.mutate()}
                >
                  Run Retention Cleanup Now
                </Button>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Danger Zone: Org Deletion (Owner only) */}
      {isOwner && (
        <Card
          title="Danger Zone"
          description="Irreversible actions regarding your organization tenancy and stored data."
          className="border-red-200"
        >
          <div className="max-w-xl space-y-4">
            <div>
              <h4 className="text-sm font-semibold text-red-900">Delete this organization</h4>
              <p className="mt-1 text-xs text-slate-500">
                Permanently mark this workspace as deleted, revoke all team members' active sessions, and cease all
                inbound mailbox processing.
              </p>
            </div>

            {!showDeleteModal ? (
              <Button variant="danger" onClick={() => setShowDeleteModal(true)}>
                Delete Organization
              </Button>
            ) : (
              <div className="rounded-md border border-red-300 bg-red-50 p-4 space-y-3">
                <p className="text-xs font-medium text-red-800">
                  Please confirm by typing your workspace slug <code>{session.organization.slug}</code> below:
                </p>
                <TextField
                  label="Confirm workspace slug"
                  value={confirmSlug}
                  onChange={(e) => setConfirmSlug(e.target.value)}
                  placeholder={session.organization.slug}
                />
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    disabled={confirmSlug !== session.organization.slug}
                    loading={deleteOrgMutation.isPending}
                    onClick={() => deleteOrgMutation.mutate()}
                  >
                    Permanently Delete
                  </Button>
                  <Button variant="secondary" onClick={() => setShowDeleteModal(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
